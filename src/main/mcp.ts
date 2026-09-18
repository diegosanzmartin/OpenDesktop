/**
 * Tools from somewhere else, and what they cost to have on the table.
 *
 * MCP is a small protocol: a process you start, three methods you call over
 * newline-delimited JSON-RPC on its stdin and stdout — `initialize`,
 * `tools/list`, `tools/call` — and a JSON Schema per tool that the AI SDK can
 * take as it is. So this is the client rather than a dependency: the official
 * SDK is a reasonable library and this is two hundred lines, and the part that
 * needs judgement is not the protocol.
 *
 * The part that needs judgement is the cost. A tool is a schema in the prefix
 * of every step of every turn, resent each time and paid for each time: the
 * list from one desktop client came to 130 tools and 57,800 tokens, which is
 * four times this app's entire prompt and more than the whole window of the
 * model that runs on this machine. Worse, a schema that changes invalidates
 * the provider's cache of the prefix — the thing that turns a 63k conversation
 * into 4k of charged input.
 *
 * So nothing here is global. A server is declared in the config and *enabled
 * per session*, its process starts the first time a session that wants it runs
 * a turn, and what it costs in tokens is measured and shown next to it. A
 * session that has enabled nothing sends nothing, which is every session until
 * somebody chooses otherwise.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { jsonSchema, tool, type ToolSet } from 'ai'
import type { McpServerConfig, McpStatus } from '@shared/types'
import { logLine } from './log'
import { toolEnvironment } from './tool-env'

/** The spec version this client speaks, and the one before it as a fallback. */
const PROTOCOL = '2025-06-18'
const OLDER_PROTOCOL = '2024-11-05'

const START_MS = 20_000
const CALL_MS = 120_000

export interface McpTool {
  name: string
  description: string
  inputSchema: Record<string, unknown>
}

interface Live {
  child: ChildProcess
  /** Resolvers waiting on a request id. */
  waiting: Map<number, { resolve: (value: unknown) => void; reject: (err: Error) => void }>
  nextId: number
  tools: McpTool[]
  tokens: number
  tail: string
  stderr: string
}

const live = new Map<string, Live>()
const starting = new Map<string, Promise<Live>>()
const failed = new Map<string, string>()

/* ---------------- the protocol ---------------- */

function send(instance: Live, message: Record<string, unknown>): void {
  instance.child.stdin?.write(`${JSON.stringify(message)}\n`)
}

function request(instance: Live, method: string, params: unknown, timeoutMs: number): Promise<unknown> {
  const id = instance.nextId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      instance.waiting.delete(id)
      reject(new Error(`${method} did not answer within ${timeoutMs / 1000}s`))
    }, timeoutMs)
    instance.waiting.set(id, {
      resolve: (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      reject: (err) => {
        clearTimeout(timer)
        reject(err)
      }
    })
    send(instance, { jsonrpc: '2.0', id, method, params })
  })
}

/**
 * One line of stdout is one message. Partial lines are kept: a server writing
 * a large tool list does not get to have it cut in half by a chunk boundary.
 */
function onData(instance: Live, chunk: Buffer): void {
  instance.tail += chunk.toString('utf8')
  for (;;) {
    const at = instance.tail.indexOf('\n')
    if (at === -1) break
    const line = instance.tail.slice(0, at).trim()
    instance.tail = instance.tail.slice(at + 1)
    if (!line) continue
    let message: { id?: number; result?: unknown; error?: { message?: string } }
    try {
      message = JSON.parse(line)
    } catch {
      // Not ours: some servers log to stdout. Ignored rather than fatal.
      continue
    }
    if (typeof message.id !== 'number') continue
    const pending = instance.waiting.get(message.id)
    if (!pending) continue
    instance.waiting.delete(message.id)
    if (message.error) pending.reject(new Error(message.error.message ?? 'the server refused'))
    else pending.resolve(message.result)
  }
}

async function handshake(instance: Live, version: string): Promise<void> {
  await request(
    instance,
    'initialize',
    {
      protocolVersion: version,
      capabilities: {},
      clientInfo: { name: 'OpenDesktop', version: '1.0' }
    },
    START_MS
  )
  send(instance, { jsonrpc: '2.0', method: 'notifications/initialized' })
}

async function listTools(instance: Live): Promise<McpTool[]> {
  const out: McpTool[] = []
  let cursor: string | undefined
  // Paginated, because a server with a hundred tools is allowed to say so in
  // instalments and silently taking the first page would be a missing tool.
  do {
    const page = (await request(instance, 'tools/list', cursor ? { cursor } : {}, START_MS)) as {
      tools?: { name?: string; description?: string; inputSchema?: Record<string, unknown> }[]
      nextCursor?: string
    }
    for (const entry of page.tools ?? []) {
      if (!entry.name) continue
      out.push({
        name: entry.name,
        description: entry.description ?? '',
        inputSchema: entry.inputSchema ?? { type: 'object', properties: {} }
      })
    }
    cursor = page.nextCursor
  } while (cursor)
  return out
}

/* ---------------- starting one ---------------- */

async function start(server: McpServerConfig): Promise<Live> {
  const child = spawn(server.command, server.args ?? [], {
    cwd: server.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    // The same environment an agent's commands get — this app's own API keys
    // stripped out of it — plus whatever the server was declared with.
    env: { ...toolEnvironment(), ...(server.env ?? {}) }
  })

  const instance: Live = {
    child,
    waiting: new Map(),
    nextId: 1,
    tools: [],
    tokens: 0,
    tail: '',
    stderr: ''
  }

  child.stdout?.on('data', (chunk: Buffer) => onData(instance, chunk))
  child.stderr?.on('data', (chunk: Buffer) => {
    // Kept, not printed: a server's startup chatter is only interesting when
    // it turns out to be the reason nothing worked.
    instance.stderr = `${instance.stderr}${chunk.toString('utf8')}`.slice(-4000)
  })
  child.on('error', (err) => {
    instance.stderr += `\ncould not run ${server.command}: ${err.message}`
  })
  child.on('close', (code) => {
    for (const pending of instance.waiting.values()) {
      pending.reject(new Error(`the server stopped (code ${code ?? 0})`))
    }
    instance.waiting.clear()
    if (live.get(server.id) === instance) {
      live.delete(server.id)
      logLine('warn', `mcp ${server.id}: stopped (code ${code ?? 0})`)
    }
  })

  try {
    await handshake(instance, PROTOCOL)
  } catch (err) {
    /*
     * One retry on the older version. A server pinned to the 2024 protocol
     * answers the newer `initialize` with an error rather than a negotiation,
     * and the difference between "this server is broken" and "this server is
     * a year old" is worth one extra round trip to find out.
     */
    if (!instance.child.killed) {
      await handshake(instance, OLDER_PROTOCOL).catch(() => {
        throw err
      })
    } else {
      throw err
    }
  }

  instance.tools = await listTools(instance)
  instance.tokens = Math.round(JSON.stringify(instance.tools).length / 4)
  return instance
}

/** Connects if it is not connected, and only ever once at a time. */
export async function connectMcp(server: McpServerConfig): Promise<McpStatus> {
  const already = live.get(server.id)
  if (already) return statusOf(server)

  if (!starting.has(server.id)) {
    starting.set(
      server.id,
      start(server)
        .then((instance) => {
          live.set(server.id, instance)
          failed.delete(server.id)
          logLine(
            'info',
            `mcp ${server.id}: ${instance.tools.length} tools, ~${instance.tokens} tokens of schema`
          )
          return instance
        })
        .finally(() => starting.delete(server.id))
    )
  }

  try {
    await starting.get(server.id)
  } catch (err) {
    const message = `${(err as Error).message}${
      live.get(server.id)?.stderr ? `\n${live.get(server.id)?.stderr}` : ''
    }`
    failed.set(server.id, message.trim())
    logLine('warn', `mcp ${server.id}: ${message.trim().slice(0, 300)}`)
  }
  return statusOf(server)
}

export function statusOf(server: McpServerConfig): McpStatus {
  const instance = live.get(server.id)
  const problem = failed.get(server.id)
  return {
    id: server.id,
    name: server.name || server.id,
    state: instance ? 'ready' : starting.has(server.id) ? 'starting' : problem ? 'failed' : 'idle',
    tools: (instance?.tools ?? []).map((entry) => ({
      name: entry.name,
      description: entry.description
    })),
    tokens: instance?.tokens ?? 0,
    message: problem
  }
}

export function stopMcp(id?: string): void {
  for (const [key, instance] of live) {
    if (id && key !== id) continue
    instance.child.kill()
    live.delete(key)
  }
  if (id) failed.delete(id)
  else failed.clear()
}

/** Called from `before-quit`: these are this app's child processes. */
export function disposeMcp(): void {
  stopMcp()
}

/* ---------------- what the model is handed ---------------- */

/** `github__create_issue`: the server it came from, then the tool it called. */
export function toolName(serverId: string, name: string): string {
  return `${serverId}__${name}`.replace(/[^A-Za-z0-9_-]/g, '_')
}

function textOf(result: unknown): string {
  const content = (result as { content?: { type?: string; text?: string }[] })?.content ?? []
  const parts = content.map((entry) =>
    entry.type === 'text' && typeof entry.text === 'string'
      ? entry.text
      : `[${entry.type ?? 'content'}]`
  )
  return parts.join('\n').trim() || '(the server returned nothing)'
}

/**
 * The tools of the servers this session asked for, in the AI SDK's shape.
 *
 * The JSON Schema goes across as it is: these schemas are written by somebody
 * else and converting them to zod and back would be a translation with nothing
 * to gain. A server that is declared but not reachable contributes no tools
 * and says why in its status — the alternative is a turn that offers a tool
 * and fails on it.
 */
export async function mcpTools(
  servers: McpServerConfig[],
  run: (input: {
    serverId: string
    serverName: string
    tool: string
    description: string
    args: Record<string, unknown>
    call: () => Promise<string>
  }) => Promise<string>
): Promise<ToolSet> {
  const out: ToolSet = {}
  for (const server of servers) {
    await connectMcp(server)
    const instance = live.get(server.id)
    if (!instance) continue
    for (const entry of instance.tools) {
      out[toolName(server.id, entry.name)] = tool({
        description: entry.description,
        inputSchema: jsonSchema(entry.inputSchema as never),
        execute: async (args: unknown) =>
          run({
            serverId: server.id,
            serverName: server.name || server.id,
            tool: entry.name,
            description: entry.description,
            args: (args ?? {}) as Record<string, unknown>,
            call: async () => {
              const current = live.get(server.id)
              if (!current) throw new Error(`${server.id} is not connected`)
              const result = await request(
                current,
                'tools/call',
                { name: entry.name, arguments: args ?? {} },
                CALL_MS
              )
              if ((result as { isError?: boolean })?.isError) {
                throw new Error(textOf(result))
              }
              return textOf(result)
            }
          })
      })
    }
  }
  return out
}

/** What a session's chosen servers would add to every step, for the UI. */
export function tokensFor(servers: McpServerConfig[]): number {
  let total = 0
  for (const server of servers) total += live.get(server.id)?.tokens ?? 0
  return total
}
