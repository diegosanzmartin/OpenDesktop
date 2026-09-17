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
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { generateText } from 'ai'
import { formatBytes, localSpec, LOCAL_PROVIDER_ID } from '@shared/local-model'
import { loadConfig, saveConfig, setAgentLoader } from './config'
import {
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

async function main(): Promise<void> {
  /*
   * Which model, so the two in the catalogue can be compared like for like
   * through the same harness: `node local-check.mjs qwen3-4b`. Without an
   * argument it is whichever is installed, or the default.
   */
  const spec = localSpec(process.argv[2])
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

  // Nothing of this check outlives it: the app's own sessions are next door.
  store.deleteSession(turnSession.id)
  history.clearHistory(turnSession.id)
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
