/**
 * Talks to a real tool server, and says what it offers and what it costs.
 *
 * The smoke test covers the client against a server it writes itself, which is
 * the only way to test a protocol without the network. This is the other half:
 * a published server, started the way the app starts it, so the numbers are
 * real — and it is the thing to run before switching a server on for a
 * session, because "2 tools · 1.9k tokens" is the whole decision.
 *
 *   pnpm mcp:check -- npx -y @modelcontextprotocol/server-filesystem /tmp/room
 *   pnpm mcp:check -- --call list_directory --args '{"path":"/tmp/room"}' -- npx …
 *   pnpm mcp:check -- --turn 'what is in this folder?' -- npx …
 */
import { generateText } from 'ai'
import { estimateTokens } from './history'
import { listAgents, seedBuiltins } from './agents'
import { loadConfig, saveConfig, setAgentLoader } from './config'
import { connectMcp, statusOf, stopMcp, toolName } from './mcp'
import { externalTools } from './agent/tools'
import { resolveModel } from './providers'
import { runTurn } from './agent/runner'
import { resolveApproval } from './approvals'
import { bus } from './bus'
import { getRuntime } from './runtime'
import { localModelRef } from '@shared/local-model'
import { MANAGER_AGENT, type McpServerConfig } from '@shared/types'
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

/** `--call x --args {…} --turn '…' -- command args…` */
function parseArgs(argv: string[]): {
  command: string[]
  call?: string
  args?: Record<string, unknown>
  turn?: string
  model?: string
  keep?: boolean
} {
  const out: {
    command: string[]
    call?: string
    args?: Record<string, unknown>
    turn?: string
    model?: string
    keep?: boolean
  } = { command: [] }
  let rest = argv
  for (;;) {
    const flag = rest[0]
    if (flag === '--call') {
      out.call = rest[1]
      rest = rest.slice(2)
    } else if (flag === '--args') {
      out.args = JSON.parse(rest[1] ?? '{}') as Record<string, unknown>
      rest = rest.slice(2)
    } else if (flag === '--turn') {
      out.turn = rest[1]
      rest = rest.slice(2)
    } else if (flag === '--model') {
      out.model = rest[1]
      rest = rest.slice(2)
    } else if (flag === '--keep') {
      out.keep = true
      rest = rest.slice(1)
    } else if (flag === '--') {
      rest = rest.slice(1)
    } else break
  }
  out.command = rest
  return out
}

/**
 * Run under electron when the model's key is in the keychain.
 *
 * `{secret:…}` is decrypted by safeStorage, which needs a ready electron app
 * — so a check of a hosted model has to run there, and a check of the local
 * model or a bare server does not. Both, rather than one: the interesting
 * question is what a real model does with a real server's tools, and the real
 * model is usually the one behind a key.
 */
async function readyForSecrets(): Promise<void> {
  if (!process.versions.electron) return
  const { app } = await import('electron')
  await app.whenReady()
  const { loadSecrets } = await import('./secrets')
  const secrets = loadSecrets()
  console.log(`       keychain: ${secrets.available ? `${secrets.names.length} stored` : 'unavailable'}`)
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.command.length === 0) {
    console.log(
      'usage: mcp:check -- [--call tool --args json] [--turn prompt [--model ref] [--keep]] -- command [args…]'
    )
    process.exit(1)
  }

  const server: McpServerConfig = {
    id: 'probe',
    name: 'Probe',
    command: parsed.command[0],
    args: parsed.command.slice(1)
  }
  console.log(`\n${server.command} ${(server.args ?? []).join(' ')}`)
  await readyForSecrets()

  const started = Date.now()
  const status = await connectMcp(server)
  check('it starts and answers the handshake', status.state === 'ready', status.message)
  if (status.state !== 'ready') {
    console.log(`\n${checks - failures.length}/${checks} checks passed`)
    process.exit(1)
  }
  console.log(`       ready in ${((Date.now() - started) / 1000).toFixed(1)}s`)

  check('and offers tools', status.tools.length > 0, status.tools.length)
  check('whose schemas were measured', status.tokens > 0, status.tokens)
  console.log(
    `       ${status.tools.length} tools · ~${status.tokens.toLocaleString('en-US')} tokens on every step`
  )
  for (const entry of status.tools) {
    console.log(`         ${entry.name} — ${entry.description.split('\n')[0].slice(0, 80)}`)
  }

  if (parsed.call) {
    /*
     * A real session, because the call gets a block like any other tool and a
     * block belongs to a conversation. Made here and deleted below: this check
     * leaves nothing behind.
     */
    const scratch = store.createSession({
      title: 'mcp check',
      cwd: process.cwd(),
      environmentId: 'local',
      agentId: MANAGER_AGENT,
      model: 'none/none',
      mcp: ['probe']
    })
    const ctx = {
      config: { ...loadConfig(), mcp: { probe: server } },
      agent: { id: 'build', name: 'Build', description: '', mode: 'all' as const },
      permissions: { ...loadConfig().permissions, mcp: 'allow' as const },
      sessionId: scratch.id,
      environmentId: 'local',
      cwd: process.cwd(),
      runtime: getRuntime('local'),
      savings: { rtk: false, shunt: false },
      modelRef: 'none/none',
      currentMessageId: () => 'm-mcp-check',
      depth: 0,
      signal: new AbortController().signal
    }

    const tools = await externalTools(ctx as never, [server])
    const name = toolName(server.id, parsed.call)
    const entry = tools[name] as unknown as { execute: (input: unknown) => Promise<string> } | undefined
    check(`${parsed.call} is on the table as ${name}`, Boolean(entry), Object.keys(tools))
    if (entry) {
      const answer = await entry.execute(parsed.args ?? {}).catch((err: Error) => `FAILED: ${err.message}`)
      check('calling it comes back with something', answer.length > 0 && !answer.startsWith('FAILED'), answer.slice(0, 200))
      console.log(`       said: ${answer.replace(/\s+/g, ' ').slice(0, 300)}`)
      const block = store.listBlocks(scratch.id).filter((entry) => entry.tool === 'mcp').slice(-1)[0]
      check(
        'and it is a block in the transcript, with the server and the arguments on it',
        block?.subtitle === server.name && JSON.stringify(block?.input ?? {}).includes(parsed.call),
        { title: block?.title, subtitle: block?.subtitle }
      )
    }
    store.deleteSession(scratch.id)
    history.clearHistory(scratch.id)
  }

  if (parsed.turn) {
    /*
     * The whole path, for real: a turn on a real model, with a real server's
     * tools merged in by the runner. Read-only approvals only — this runs on
     * somebody's machine.
     */
    seedBuiltins()
    setAgentLoader(listAgents)
    const modelRef = parsed.model ?? localModelRef()
    const before = loadConfig()
    saveConfig({ ...before, mcp: { ...(before.mcp ?? {}), probe: server } })
    loadConfig(true)

    const resolved = await resolveModel(loadConfig(true), modelRef).catch(() => null)
    check(`${modelRef} is configured`, Boolean(resolved), modelRef)
    if (resolved) {
      const session = store.createSession({
        title: 'mcp check',
        cwd: process.cwd(),
        environmentId: 'local',
        agentId: MANAGER_AGENT,
        model: modelRef,
        mcp: ['probe']
      })
      const refused: string[] = []
      const watching = bus.subscribe((event) => {
        if (event.type !== 'approval.requested') return
        const allowed = event.request.tool === 'mcp' || event.request.tool === 'read'
        if (!allowed) refused.push(event.request.tool)
        resolveApproval(event.request.id, allowed ? 'always' : 'reject')
      })

      const turnStarted = Date.now()
      await runTurn({ sessionId: session.id, userText: parsed.turn })
      watching()

      const blocks = store.listBlocks(session.id)
      const said = (store.listMessages(session.id).slice(-1)[0]?.parts ?? [])
        .filter((part) => part.type === 'text')
        .map((part) => part.text ?? '')
        .join(' ')
        .trim()
      console.log(
        `       turn: ${blocks.map((block) => `${block.tool}:${block.status}`).join(' ')} in ${Math.round((Date.now() - turnStarted) / 1000)}s`
      )
      console.log(`       said: ${said.replace(/\s+/g, ' ').slice(0, 320)}`)
      /*
       * That the tools were on the table, not that the model picked them.
       *
       * The first version of this asserted an `mcp` block and failed on a turn
       * that answered the question perfectly — with the app's own `read`,
       * because the file was right there and the server's equivalent was the
       * longer way round. A model choosing the simpler tool is the router
       * working, not a fault, and a check that calls it one is a check that
       * will be argued with. `--call` is what tests the call path.
       */
      check('the turn ran with the server on the table', status.tools.length > 0 && blocks.length > 0, {
        offered: status.tools.length,
        used: blocks.map((block) => block.tool)
      })
      check('and answered', said.length > 0, said.length)
      const viaServer = blocks.filter((block) => block.tool === 'mcp').length
      console.log(
        `       it used the server for ${viaServer} of ${blocks.length} call${blocks.length === 1 ? '' : 's'}` +
          `${viaServer === 0 ? ' — it had its own tools for this one' : ''}`
      )
      console.log(`       prefix: ${estimateTokens(history.getHistory(session.id))} tokens of transcript`)

      /*
       * Kept when asked, because a check that proves something and then
       * deletes the evidence is a check nobody can look at. The app reads the
       * sessions directory at startup rather than the index, so a session
       * written by this process shows up the next time it is opened — not in a
       * window that is already running, which has its own copy in memory.
       */
      if (parsed.keep) {
        store.updateSession(session.id, { title: `MCP check — ${server.command}` })
        store.flush()
        console.log(`       kept as "${session.id}" — reopen OpenDesktop to see it`)
      } else {
        store.deleteSession(session.id)
        history.clearHistory(session.id)
      }
    }
    saveConfig(before)
  }

  stopMcp()
  check('stopping it leaves nothing running', statusOf(server).state === 'idle')

  console.log(`\n${checks - failures.length}/${checks} checks passed`)
  if (failures.length > 0) {
    console.log(`\nfailed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
    process.exit(1)
  }
  process.exit(0)
}

void main().catch((err: Error) => {
  console.error(err)
  process.exit(1)
})
