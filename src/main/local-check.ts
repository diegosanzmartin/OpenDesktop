/**
 * Proves the local model works on this machine, for real.
 *
 * The smoke test covers the rules — the checksum, the unsafe archive, the
 * provider it declares — against a stand-in release it serves itself, because
 * a test suite that downloads two gigabytes is a test suite nobody runs. This
 * is the other half: the pinned build, the pinned weights, the sidecar, and a
 * completion that came out of it. It is slow and it uses the network on
 * purpose.
 *
 * Run with: pnpm local:check
 */
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import { LOCAL_MODELS, LOCAL_PROVIDER_ID, formatBytes, localSpec } from '@shared/local-model'
import { loadConfig, readConfigText, saveConfig, setAgentLoader, writeConfigText } from './config'
import {
  LOCAL_DIR,
  MODELS_DIR,
  disposeLocalModel,
  installLocalModel,
  localStatus,
  serverBinary,
  startLocalModel,
  stopLocalModel
} from './local-model'
import { resolveModel } from './providers'
import { bus } from './bus'
import { listAgents, seedBuiltins } from './agents'
import { runTurn } from './agent/runner'
import { createTools } from './agent/tools'
import { getRuntime } from './runtime'
import { resolveApproval } from './approvals'
import { MANAGER_AGENT } from '@shared/types'
import * as store from './store'
import * as history from './history'

const failures: string[] = []
let checks = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  checks++
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

function weightsOnDisk(spec: { file: string; bytes: number }): boolean {
  try {
    return statSync(join(MODELS_DIR, spec.file)).size === spec.bytes
  } catch {
    return false
  }
}

async function main(): Promise<void> {
  /*
   * Which model, so the two in the catalogue can be compared like for like
   * through the same harness: `node local-check.mjs qwen3-4b`. Without an
   * argument it is whichever is installed, or the default.
   */
  const argv = process.argv.slice(2)
  /*
   * `--keep` leaves the conversation in the app instead of deleting it. A
   * check that proves something and then removes the evidence is a check
   * nobody can look at — which is exactly how the file card came to be
   * believed missing.
   */
  const keep = argv.includes('--keep')
  const spec = localSpec(argv.find((entry) => !entry.startsWith('--')))
  console.log(`\nlocal model: ${spec.name} on ${process.platform}/${process.arch}`)

  let lastShown = 0
  bus.subscribe((event) => {
    if (event.type !== 'local.status' || !event.status.progress) return
    const { received, total, label } = event.status.progress
    if (received - lastShown < 50_000_000 && received !== total) return
    lastShown = received
    console.log(
      `       ${label}: ${formatBytes(received)} / ${formatBytes(total)} (${Math.round((received / total) * 100)}%)`
    )
  })

  const started = Date.now()
  const installed = await installLocalModel(spec.id)
  check(
    'installing leaves the runtime and the weights on disk',
    installed.runtime.installed && installed.model.installed,
    installed.message
  )
  check('and the server binary is where it says it is', existsSync(serverBinary()))
  console.log(
    `       ${formatBytes(installed.diskBytes)} on disk after ${Math.round((Date.now() - started) / 1000)}s`
  )

  const config = loadConfig(true)
  check(
    'the provider declared itself, with no help',
    config.provider[LOCAL_PROVIDER_ID]?.options.baseURL === 'local://llama',
    config.provider[LOCAL_PROVIDER_ID]
  )
  check(
    'and the model with it',
    Boolean(config.provider[LOCAL_PROVIDER_ID]?.models[spec.id]),
    Object.keys(config.provider[LOCAL_PROVIDER_ID]?.models ?? {})
  )

  const up = Date.now()
  const running = await startLocalModel(spec.id)
  check('the sidecar comes up and answers its health check', running.stage === 'running', running.message)
  check('on a port of its own', Boolean(running.port), running.port)
  console.log(`       ready in ${Math.round((Date.now() - up) / 1000)}s on 127.0.0.1:${running.port}`)

  // The point of all of it: a completion, through the same resolver every turn
  // uses, with nothing configured by hand.
  const resolved = await resolveModel(loadConfig(true), `${LOCAL_PROVIDER_ID}/${spec.id}`)
  const asked = Date.now()
  // Long enough for the rate to mean something: two tokens measures the time
  // to the first one and nothing else.
  const answer = await generateText({
    model: resolved.model,
    prompt: 'In one paragraph, explain what a KV cache is in a transformer.',
    maxOutputTokens: 256
  })
  const elapsed = (Date.now() - asked) / 1000
  check('and it answers a prompt', answer.text.trim().length > 0, answer.text.slice(0, 120))
  check(
    'having counted the tokens, so a turn can be metered',
    (answer.usage.outputTokens ?? 0) > 0,
    answer.usage
  )
  console.log(
    `       "${answer.text.trim().slice(0, 60)}" — ${answer.usage.outputTokens ?? 0} tokens in ${elapsed.toFixed(1)}s` +
      ` (${(((answer.usage.outputTokens ?? 0) / elapsed) || 0).toFixed(1)} tok/s)`
  )

  /*
   * And then a whole turn through the agent loop, because a completion is not
   * the job. What a small local model is for here is delegated reading: given
   * a folder and a question, call the read tool, find the answer and say it
   * short. A model that cannot call a tool is no use whatever its tokens per
   * second, and that is not visible from a prompt with no tools in it.
   */
  seedBuiltins()
  setAgentLoader(listAgents)
  // After the loader, or the config is still the one that was read before the
  // agents existed — and a session naming an agent the config does not have
  // runs the orchestrator instead, which is a far heavier prompt than the
  // read-only agent this is meant to be measuring.
  loadConfig(true)
  const room = join(tmpdir(), `opendesktop-local-turn-${Date.now()}`)
  mkdirSync(room, { recursive: true })
  writeFileSync(
    join(room, 'notes.md'),
    [
      '# Runbook: quote-service',
      '',
      'Owner: the payments team (rota in #pay-oncall).',
      'The service listens on port 8443 behind the shared ingress.',
      'Restart with `systemctl restart quote-service`; it takes about 40s to warm up.',
      ''
    ].join('\n')
  )

  const turnSession = store.createSession({
    title: 'local model check',
    cwd: room,
    environmentId: 'local',
    // Read-only by design: this runs on somebody's real machine.
    agentId: 'explore',
    model: `${LOCAL_PROVIDER_ID}/${spec.id}`,
    autoApprove: true
  })
  const turnStarted = Date.now()
  await runTurn({
    sessionId: turnSession.id,
    userText:
      'Read notes.md in this folder. In one sentence: which port does the service listen on, and which team owns it?'
  })
  /*
   * What it said, from the transcript rather than from runTurn's return value:
   * that one is only filled in for a subagent, whose text is its report. A
   * turn in a session puts its answer in the message, which is also where the
   * UI reads it.
   */
  const messages = store.listMessages(turnSession.id)
  const said = (messages[messages.length - 1]?.parts ?? [])
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join(' ')
    .trim()
  const calls = store.listBlocks(turnSession.id)
  console.log(
    `       turn: ${calls.length} tool call${calls.length === 1 ? '' : 's'} (${calls
      .map((block) => block.tool)
      .join(', ')}) in ${Math.round((Date.now() - turnStarted) / 1000)}s`
  )
  console.log(`       said (${said.length} chars): ${said.replace(/\s+/g, ' ').trim().slice(0, 700)}`)
  check('a turn through the agent loop calls a tool', calls.length > 0, calls.map((b) => b.tool))
  check(
    'reads the file it was pointed at rather than guessing',
    calls.some((block) => /notes\.md/.test(JSON.stringify(block.input ?? {}))),
    calls.map((block) => block.input)
  )
  check('and answers with what was in it', /8443/.test(said) && /payment/i.test(said), said.slice(0, 200))
  /*
   * Not "one sentence", which is what was asked for and which a small model
   * does not honour — it thinks out loud in its answer, and that is a fact
   * about the model rather than something for this check to fail on. What is
   * checked is that it stopped: an answer the length of an essay means it was
   * still going when the cap cut it off.
   */
  check('and stops rather than running on', said.length > 0 && said.length < 1500, said.length)

  /*
   * And the job this model is actually here for: a delegated read.
   *
   * With the savings switch on, a whole-file read longer than a few hundred
   * lines is refused and handed to a cheaper model instead — the file goes
   * there, the answer comes back, and the file never enters this conversation.
   * That is what a local model is worth having for, and it needs two of them
   * installed so the worker is not the model doing the asking.
   */
  const other = LOCAL_MODELS.find((entry) => entry.id !== spec.id && weightsOnDisk(entry))
  if (!other) {
    console.log(`       shunt: skipped — install a second local model to delegate to`)
  } else {
    const long = join(room, 'runner.ts')
    const source = join(process.cwd(), 'src/main/agent/runner.ts')
    if (!existsSync(source)) {
      console.log('       shunt: skipped — run this from the repository')
    } else {
      /*
       * Long enough to be refused, small enough for the worker to hold.
       *
       * The whole 1,600-line file was the first thing tried and it is too big
       * for any local model: the read was refused, the delegation was refused
       * because 60,000 tokens do not fit in a 32k window, and the model fell
       * back to a ranged read — which is the system working correctly and
       * tests nothing about delegating. 600 lines is over the 350-line
       * threshold and about 7,000 tokens, which fits.
       */
      writeFileSync(long, readFileSync(source, 'utf8').split('\n').slice(0, 600).join('\n'))
      const lines = readFileSync(long, 'utf8').split('\n').length

      // Named by hand, because the router would otherwise pick whichever model
      // is cheapest at the margin — and with a real key in the keychain that is
      // a hosted model, not this one. This is the knob that says "delegate to
      // the thing on my machine".
      const before = readConfigText()
      saveConfig({ ...loadConfig(), shuntModel: `${LOCAL_PROVIDER_ID}/${other.id}` })

      /*
       * The manager, because the read-only agent declares a fixed tool list
       * that does not include `bulk_read` — which is why the first run of this
       * check watched a 4B model grep a 1,568-line file three times and then
       * invent an answer. And without auto-approval: nothing that changes
       * anything is allowed through, so a small model let loose on a real
       * repository can read and search and nothing else.
       */
      const shunted = store.createSession({
        title: 'local shunt check',
        cwd: room,
        environmentId: 'local',
        agentId: MANAGER_AGENT,
        model: `${LOCAL_PROVIDER_ID}/${spec.id}`,
        savings: { rtk: false, shunt: true }
      })
      const READ_ONLY = ['read', 'bulk_read', 'grep', 'glob', 'list']
      const refused: string[] = []
      const watching = bus.subscribe((event) => {
        if (event.type !== 'approval.requested') return
        const allowed = READ_ONLY.includes(event.request.tool)
        if (!allowed) refused.push(event.request.tool)
        resolveApproval(event.request.id, allowed ? 'always' : 'reject')
      })
      const shuntStarted = Date.now()
      await runTurn({
        sessionId: shunted.id,
        /*
         * A question that cannot be grepped. "How many steps may a turn take"
         * was the first one tried and it taught the check nothing: the model
         * grepped for "steps", found `let steps = 0`, and reported that as the
         * answer. Delegation is for what has to be read whole.
         */
        userText:
          'Read runner.ts and summarise what it is responsible for, in two sentences.'
      })
      const blocks = store.listBlocks(shunted.id)
      // The last one, and its status: the first of two bulk_read calls in one
      // run turned out to have failed, and reading the first block reported
      // the "asking…" line it had got as far as printing.
      const delegated = blocks.filter((block) => block.tool === 'bulk_read').slice(-1)[0]
      const answered = (store.listMessages(shunted.id).slice(-1)[0]?.parts ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(' ')
        .trim()

      console.log(
        `       shunt: ${spec.name} drove, ${other.name} read ${lines} lines — ` +
          `${blocks.length} call${blocks.length === 1 ? '' : 's'} (${blocks
            .map((block) => block.tool)
            .join(', ')}) in ${Math.round((Date.now() - shuntStarted) / 1000)}s`
      )
      console.log(
        `       blocks: ${blocks.map((block) => `${block.tool}:${block.status}`).join(' ')}`
      )
      console.log(
        `       delegated (${delegated?.status ?? 'none'}): ${String(delegated?.output ?? '(none)')
          .replace(/\s+/g, ' ')
          .slice(0, 320)}`
      )
      console.log(`       said (${answered.length} chars): ${answered.replace(/\s+/g, ' ').slice(0, 400)}`)

      check(
        'a file too long to read is delegated rather than read into the conversation',
        Boolean(delegated),
        blocks.map((block) => block.tool)
      )
      check(
        'to the other local model, which is what shuntModel asked for',
        JSON.stringify(delegated?.input ?? {}).includes('runner.ts') ||
          String(delegated?.subtitle ?? '').includes(other.id),
        { input: delegated?.input, subtitle: delegated?.subtitle }
      )
      /*
       * That an answer came back, not that it is a good one. It is not: a 3B
       * model handed 1,600 lines of runner.ts reported "logic for executing
       * and managing test runners, likely used in a testing framework" —
       * confident, fluent and from the filename. The mechanism is what this
       * check is for; whether a given worker is worth delegating to is a
       * judgement for whoever picks it, and the honest version of that
       * judgement is in the README.
       */
      check(
        'and an answer comes back, charged to the model that did the reading',
        delegated?.status === 'success' &&
          String(delegated?.output ?? '').includes(`${LOCAL_PROVIDER_ID}/${other.id}:`),
        String(delegated?.output ?? '').slice(-160)
      )
      check(
        'having kept the file itself out of the conversation',
        /stayed out of this conversation/.test(String(delegated?.output ?? '')),
        String(delegated?.output ?? '').slice(-120)
      )

      if (refused.length > 0) {
        console.log(`       refused, as this check does not let it write: ${refused.join(', ')}`)
      }
      watching()
      store.deleteSession(shunted.id)
      history.clearHistory(shunted.id)
      writeConfigText(before)
    }
  }

  /*
   * And a file handed over, which is the other half of a turn that produced
   * something: the model runs a command that writes a file and then passes it
   * to `deliver`, which is what puts a card in the conversation. Nothing about
   * this is visible from the component tests — those mount the card with a
   * block they were given.
   */
  const madeSession = store.createSession({
    title: 'local model check — a file',
    cwd: room,
    environmentId: 'local',
    agentId: MANAGER_AGENT,
    model: `${LOCAL_PROVIDER_ID}/${spec.id}`,
    autoApprove: true
  })
  await runTurn({
    sessionId: madeSession.id,
    userText:
      'Two steps, in this order. First run this exact command with bash: ' +
      "grep -o 'port [0-9]*' notes.md > ports.txt . Then pass ports.txt to the deliver tool so I " +
      'can open it. Say nothing else.'
  })
  const madeBlocks = store.listBlocks(madeSession.id)
  const delivered = madeBlocks.find((entry) => entry.tool === 'deliver' && entry.status === 'success')
  console.log(
    `       file turn: ${madeBlocks.map((entry) => `${entry.tool}:${entry.status}`).join(' ')}`
  )
  check(
    'it runs the command and hands the file over',
    Boolean(delivered),
    madeBlocks.map((entry) => entry.tool)
  )
  if (!delivered) {
    /*
     * A 3B or 4B model does one thing per turn, and this asks for two. The
     * handing over is the part being checked, so it is done directly rather
     * than left unproven — and the card in the conversation is the same card
     * either way, because it is drawn from the block and the block is real.
     */
    const tools = createTools({
      config: loadConfig(),
      agent: { id: MANAGER_AGENT, name: 'Manager', description: '', mode: 'all' },
      permissions: { ...loadConfig().permissions, read: 'allow', bash: 'allow' },
      sessionId: madeSession.id,
      environmentId: 'local',
      cwd: room,
      runtime: getRuntime('local'),
      savings: { rtk: false, shunt: false },
      modelRef: `${LOCAL_PROVIDER_ID}/${spec.id}`,
      currentMessageId: () => store.listMessages(madeSession.id).slice(-1)[0]?.id ?? 'm-made',
      depth: 0,
      signal: new AbortController().signal
    })
    const bash = tools.bash as unknown as { execute: (input: unknown) => Promise<string> }
    await bash.execute({
      command: "grep -o 'port [0-9]*' notes.md > ports.txt",
      description: 'pull the port out of the notes'
    })
    const hand = tools.deliver as unknown as { execute: (input: unknown) => Promise<string> }
    const out = await hand.execute({ paths: ['ports.txt'], note: 'the port, pulled out of the notes' })
    check('handed over directly, then', out.includes('ports.txt'), out)
    console.log('       (the model would not do two steps in one turn, so the file was handed over here)')
  }

  if (keep) {
    // The room has to survive too: a card fetches the file when it is clicked.
    const kept = join(LOCAL_DIR, 'check-output')
    rmSync(kept, { recursive: true, force: true })
    mkdirSync(kept, { recursive: true })
    for (const name of ['notes.md', 'ports.txt']) {
      if (existsSync(join(room, name))) writeFileSync(join(kept, name), readFileSync(join(room, name)))
    }
    for (const entry of store.listBlocks(madeSession.id)) {
      const paths = (entry.input as { paths?: string[] })?.paths
      if (!paths) continue
      store.updateBlock(madeSession.id, entry.id, {
        input: { ...(entry.input as object), paths: paths.map((path) => join(kept, path.split('/').pop() ?? '')) }
      })
    }
    store.updateSession(madeSession.id, { cwd: kept })
    store.flush()
    console.log(`       kept "${madeSession.title}" and its files in ${kept} — reopen OpenDesktop`)
  }

  // Nothing of this check outlives it: the app's own sessions are next door.
  if (!keep) {
    store.deleteSession(turnSession.id)
    history.clearHistory(turnSession.id)
    store.deleteSession(madeSession.id)
    history.clearHistory(madeSession.id)
  } else {
    store.deleteSession(turnSession.id)
    history.clearHistory(turnSession.id)
  }
  rmSync(room, { recursive: true, force: true })

  const stopped = stopLocalModel('the check is done')
  check('stopping it leaves it installed rather than gone', stopped.stage === 'ready' && stopped.model.installed)
  check('and nothing is listening any more', stopped.port === undefined)

  disposeLocalModel()
  // Leave the config as it was found, models and all: this check installs, it
  // does not reconfigure somebody's app.
  saveConfig(loadConfig())

  console.log(`\n${checks - failures.length}/${checks} checks passed`)
  if (failures.length > 0) {
    console.log(`\nfailed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`\nstatus: ${JSON.stringify(localStatus().stage)}`)
  process.exit(0)
}

void main().catch((err: Error) => {
  console.error(err)
  process.exit(1)
})
