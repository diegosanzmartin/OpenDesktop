import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { basename, relative } from 'node:path'
import type { AgentConfig, AppConfig, Block, Permissions } from '@shared/types'
import { type Savings } from '@shared/savings'
import { PermissionDenied, decide, hasSessionGrant, requestApproval } from '../approvals'
import { diffStats, renderDiff } from '../diff'
import { shellQuote, type Runtime } from '../runtime'
import {
  describeForModel,
  killBackgroundTask,
  listBackgroundTasks,
  readBackgroundOutput,
  startBackgroundTask
} from '../background'
import * as store from '../store'
import { recordWrite, writeWarning } from '../coordination'
import { rewriteThroughRtk, rtkListingCommand, rtkStatus } from '../rtk'
import {
  BULK_READER_INSTRUCTIONS,
  CODE_WRITER_INSTRUCTIONS,
  PLANNER_INSTRUCTIONS,
  plannerModelRef,
  payloadLimitFor,
  payloadRefusal,
  askWorker,
  bashReadTarget,
  packFiles,
  readRefusal,
  stripFences,
  workerModelRef
} from '../shunt'
import { costOf } from '@shared/cost'
import { mcpTools } from '../mcp'
import type { McpServerConfig } from '@shared/types'
import { fileSize } from '@shared/documents'
import { scrubSecrets } from '@shared/errors'
import { record as meterRecord, spentLookup } from '../meter'

export interface ToolContext {
  config: AppConfig
  agent: AgentConfig
  permissions: Permissions
  sessionId: string
  environmentId: string
  cwd: string
  runtime: Runtime
  signal: AbortSignal
  /** What this session does to keep its context and its bill down. */
  savings: Savings
  /** The model running this turn, as `provider/model`. */
  modelRef: string
  /** The assistant message currently being streamed; blocks attach to it. */
  currentMessageId: () => string
  parentBlockId?: string
  depth: number
  /** Injected by the runner so the `task` tool can start a nested agent. */
  spawnSubagent?: (input: {
    agentId: string
    prompt: string
    description: string
    parentBlockId: string
    /** Files the lead has already read, handed over rather than read again. */
    contextPaths?: string[]
    contextNotes?: string
  }) => Promise<{ sessionId: string; report: string }>
}

const MAX_TOOL_OUTPUT = 30_000

function truncate(text: string, limit = MAX_TOOL_OUTPUT): string {
  if (text.length <= limit) return text
  const head = text.slice(0, Math.floor(limit * 0.7))
  const tail = text.slice(-Math.floor(limit * 0.2))
  return `${head}\n\n[... ${text.length - head.length - tail.length} characters truncated ...]\n\n${tail}`
}

function shortPath(cwd: string, path: string): string {
  const rel = relative(cwd, path)
  return !rel || rel.startsWith('..') ? path : rel
}

interface PermissionSpec {
  key: keyof Omit<Permissions, 'allowlist' | 'denylist'>
  command?: string
  detail: string
  preview?: string
  /** Ask even if the allowlist would have covered it. */
  forceAsk?: boolean
}

/**
 * Puts the question to a person, against a block that already exists.
 *
 * Separate from `withBlock` because one tool cannot ask at the start: the whole
 * point of a delegated write is that the file is generated before it is
 * written, and an approval card for a write has to show the diff. So that tool
 * runs, then asks, then writes — and asks with exactly the same wording,
 * denylist and session grants as every other one.
 */
async function askPermission(ctx: ToolContext, block: Block, spec: PermissionSpec): Promise<void> {
  const decision = decide(ctx.permissions, spec.key, spec.command)
  if (decision.mode === 'deny') {
    store.updateBlock(ctx.sessionId, block.id, {
      status: 'error',
      error: decision.deniedBy
        ? `Not permitted by configuration — ${decision.deniedBy}`
        : `Not permitted by configuration — ${spec.key} is set to deny`,
      endedAt: Date.now()
    })
    throw new PermissionDenied(spec.detail, decision.deniedBy ?? `${spec.key} is set to deny`)
  }

  const needsAsk =
    decision.mode === 'ask' &&
    (!decision.preapproved || spec.forceAsk === true) &&
    !hasSessionGrant(ctx.sessionId, block.tool)
  if (!needsAsk) return

  const was = store.getBlock(ctx.sessionId, block.id)?.status
  store.updateBlock(ctx.sessionId, block.id, { status: 'awaiting-approval' })
  store.setSessionStatus(ctx.sessionId, 'awaiting-approval')
  const answer = await requestApproval({
    sessionId: ctx.sessionId,
    blockId: block.id,
    tool: block.tool,
    title: block.title,
    detail: spec.detail,
    summary: block.subtitle,
    preview: spec.preview,
    environmentId: ctx.environmentId,
    cwd: ctx.cwd
  })
  store.setSessionStatus(ctx.sessionId, 'running')
  if (answer === 'reject') {
    store.updateBlock(ctx.sessionId, block.id, {
      status: 'canceled',
      error: 'Rejected by the user',
      endedAt: Date.now()
    })
    throw new PermissionDenied(spec.detail)
  }
  store.updateBlock(ctx.sessionId, block.id, { status: was ?? 'running' })
}

/**
 * Wraps a tool run in the block lifecycle: create the block, ask for permission
 * when the config says so, run, then close the block. Everything the UI shows
 * (the collapsed one-liner, the live output, the status) comes from here.
 */
async function withBlock(
  ctx: ToolContext,
  spec: {
    tool: string
    title: string
    subtitle?: string
    input: Record<string, unknown>
    added?: number
    removed?: number
    permission?: PermissionSpec
  },
  run: (block: Block) => Promise<{ output: string; exitCode?: number }>
): Promise<string> {
  const messageId = ctx.currentMessageId()
  const block = store.createBlock({
    sessionId: ctx.sessionId,
    messageId,
    tool: spec.tool,
    title: spec.title,
    subtitle: spec.subtitle,
    input: spec.input,
    added: spec.added,
    removed: spec.removed,
    cwd: ctx.cwd,
    environmentId: ctx.environmentId,
    agentId: ctx.agent.id,
    parentBlockId: ctx.parentBlockId
  })
  store.pushPart(ctx.sessionId, messageId, { type: 'block', blockId: block.id })

  try {
    if (spec.permission) await askPermission(ctx, block, spec.permission)

    if (ctx.signal.aborted) {
      store.updateBlock(ctx.sessionId, block.id, { status: 'canceled', endedAt: Date.now() })
      throw new Error('Aborted by the user.')
    }

    store.updateBlock(ctx.sessionId, block.id, { status: 'running', startedAt: Date.now() })
    const result = await run(block)
    const failed = result.exitCode !== undefined && result.exitCode !== 0
    store.updateBlock(ctx.sessionId, block.id, {
      status: failed ? 'error' : 'success',
      exitCode: result.exitCode,
      endedAt: Date.now()
    })
    return truncate(result.output)
  } catch (err) {
    const current = store.getBlock(ctx.sessionId, block.id)
    if (current && current.status !== 'canceled' && current.status !== 'error') {
      store.updateBlock(ctx.sessionId, block.id, {
        status: 'error',
        error: (err as Error).message,
        endedAt: Date.now()
      })
    }
    throw err
  }
}

function enabled(ctx: ToolContext, name: string): boolean {
  return ctx.agent.tools?.[name] !== false
}

/**
 * How many subagents one agent may have working at once.
 *
 * `task` calls in the same step run concurrently — which is the point — but the
 * board's concurrency limit does not see them: two board tasks with three
 * subagents each is seven streams against a provider that was configured for
 * two. Slots are per parent agent, so a subagent's own children have their own
 * pool and nothing can wait on itself. Over the limit a call waits for a slot
 * and then runs; it is never dropped, and the block is created first so the
 * user sees the whole fan-out.
 */
const fanoutRunning = new Map<string, number>()
const fanoutQueue = new Map<string, (() => void)[]>()

function releaseFanoutSlot(parent: string): void {
  // The slot is handed to whoever is next rather than released and re-taken:
  // between those two steps another agent's call could take it.
  const next = fanoutQueue.get(parent)?.shift()
  if (next) return next()
  const left = (fanoutRunning.get(parent) ?? 1) - 1
  if (left > 0) fanoutRunning.set(parent, left)
  else fanoutRunning.delete(parent)
}

async function takeFanoutSlot(ctx: ToolContext): Promise<void> {
  const limit = Math.max(1, ctx.config.maxParallelSubagents ?? 4)
  const taken = fanoutRunning.get(ctx.sessionId) ?? 0
  if (taken < limit) {
    fanoutRunning.set(ctx.sessionId, taken + 1)
    return
  }

  await new Promise<void>((resolve, reject) => {
    const queue = fanoutQueue.get(ctx.sessionId) ?? []
    const start = (): void => {
      ctx.signal.removeEventListener('abort', onAbort)
      resolve()
    }
    function onAbort(): void {
      const pending = fanoutQueue.get(ctx.sessionId)
      const at = pending?.indexOf(start) ?? -1
      if (pending && at >= 0) pending.splice(at, 1)
      reject(new Error('Aborted by the user.'))
    }
    queue.push(start)
    fanoutQueue.set(ctx.sessionId, queue)
    ctx.signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Whether rtk is both asked for and actually there. Cached after the first
 * call, so every tool can ask without paying for it.
 */
async function rtkUsable(ctx: ToolContext): Promise<string | null> {
  if (!ctx.savings.rtk) return null
  const status = await rtkStatus(ctx.environmentId, ctx.runtime, ctx.cwd)
  return status.state === 'ready' ? (status.bin ?? 'rtk') : null
}

/**
 * The tools of the servers a session switched on, wrapped in this app's rules.
 *
 * The wrapping is the point: a call to somebody else's server gets a block in
 * the transcript like everything else, an approval prompt of its own by
 * default, and its output scrubbed of this app's own secrets on the way back.
 * A tool nobody can see is a tool nobody can refuse.
 */
export async function externalTools(
  ctx: ToolContext,
  servers: McpServerConfig[]
): Promise<ToolSet> {
  return mcpTools(servers, async (input) =>
    withBlock(
      ctx,
      {
        tool: 'mcp',
        title: input.tool,
        subtitle: input.serverName,
        input: { server: input.serverId, tool: input.tool, arguments: input.args },
        permission: {
          key: 'mcp',
          detail: `${input.serverName}: ${input.tool}`,
          /*
           * The arguments, because that is the decision. "Let the ticket
           * tracker do something" is not a question anybody can answer; "close
           * PROJ-412" is.
           */
          preview: `${input.description}\n\n${JSON.stringify(input.args, null, 2)}`
        }
      },
      async (block) => {
        const answer = await input.call()
        const safe = scrubSecrets(answer)
        store.appendBlockOutput(ctx.sessionId, block.id, safe)
        return { output: safe }
      }
    )
  )
}

export function createTools(ctx: ToolContext): ToolSet {
  const tools: ToolSet = {}

  if (enabled(ctx, 'bash')) {
    tools.bash = tool({
      description:
        'Run a shell command in the session working directory. Keep each call to a single ' +
        'purpose so it reads as one step. Use read/write/edit/grep/glob for file work instead.\n' +
        'Set run_in_background for anything you do not need the answer to right now. That covers ' +
        'commands that never return on their own — a log follow, a dev server, a watcher, where ' +
        'running in the foreground is simply wrong — but also a query, an export or a build that ' +
        'takes a while: start it, get on with something else, and read it later with ' +
        'bash_output. It hands back an id immediately; end it with bash_kill. Never use a ' +
        'timeout to escape a command that was always going to block.',
      inputSchema: z.object({
        command: z.string().describe('The shell command to run.'),
        description: z
          .string()
          .describe('A 3-8 word description of what this command does, shown in the UI.'),
        timeout: z.number().int().min(1000).max(900_000).optional().describe('Timeout in ms.'),
        run_in_background: z
          .boolean()
          .optional()
          .describe('Start it and return immediately, leaving it running.')
      }),
      execute: async ({ command, description, timeout, run_in_background }) => {
        if (run_in_background) {
          return withBlock(
            ctx,
            {
              tool: 'bash',
              title: command,
              subtitle: `${description} · background`,
              input: { command, description, run_in_background: true },
              permission: { key: 'bash', command, detail: command, preview: command }
            },
            async (block) => {
              const task = startBackgroundTask({
                sessionId: ctx.sessionId,
                command,
                description,
                cwd: ctx.cwd,
                environmentId: ctx.environmentId,
                agentId: ctx.agent.id
              })
              // Recorded on the block so the transcript can link to the task.
              store.updateBlock(ctx.sessionId, block.id, {
                input: { ...block.input, backgroundTaskId: task.id }
              })
              store.appendBlockOutput(
                ctx.sessionId,
                block.id,
                `started in the background as ${task.id}`
              )
              return {
                output:
                  `Started in the background with id ${task.id}. It is still running, and the ` +
                  `user can see it under Background tasks. Read what it produces with ` +
                  `bash_output("${task.id}") and end it with bash_kill("${task.id}").`
              }
            }
          )
        }
        /*
         * shunt mode: cat/head/tail on a large file is the same read by
         * another route, so it is refused the same way. Upstream's exemptions
         * hold — a pipe or a redirect means the output is not coming in here.
         */
        if (ctx.savings.shunt) {
          const target = bashReadTarget(command)
          if (target) {
            const path = ctx.runtime.resolve(ctx.cwd, target)
            const counted = await ctx.runtime
              .exec(`wc -l < ${shellQuote(path)}`, { cwd: ctx.cwd, timeoutMs: 15_000 })
              .catch(() => null)
            const lines = Number.parseInt((counted?.stdout ?? '').trim(), 10)
            const refusal = Number.isFinite(lines)
              ? readRefusal({ path, lines, minLines: ctx.config.shuntMinLines })
              : null
            if (refusal) throw new Error(refusal)
          }
        }

        /*
         * In rtk mode the command is handed to rtk before it runs, and the
         * decision to run it is still made about what the model asked for —
         * that is what the approval card shows and what the allowlist is
         * written against. `forceAsk` is rtk saying it wants a person
         * consulted, which can only ever add a prompt, never remove one.
         */
        const rewrite =
          ctx.savings.rtk
            ? await rewriteThroughRtk({
                environmentId: ctx.environmentId,
                runtime: ctx.runtime,
                cwd: ctx.cwd,
                command,
                permissions: ctx.permissions,
                signal: ctx.signal
              })
            : null

        return withBlock(
          ctx,
          {
            tool: 'bash',
            title: command,
            subtitle: description,
            input: {
              command,
              description,
              timeout,
              ...(rewrite?.rewritten ? { ranAs: rewrite.command } : {})
            },
            permission: {
              key: 'bash',
              command,
              detail: command,
              preview: command,
              forceAsk: rewrite?.forceAsk
            }
          },
          async (block) => {
            /*
             * The live view is scrubbed as it streams, holding back the tail.
             *
             * A key can straddle two reads of the pipe, and half a key matches
             * nothing — so the last stretch of each chunk waits for the next
             * one before it is shown. The whole output is scrubbed again at the
             * end, so what is stored and what the model reads are exact either
             * way; this is what stops a secret being briefly visible in the
             * transcript while a command is still running.
             */
            let held = ''
            const flush = (chunk: string, last = false): void => {
              held += chunk
              const safe = last ? held : held.slice(0, Math.max(0, held.length - 96))
              held = last ? '' : held.slice(safe.length)
              if (safe) store.appendBlockOutput(ctx.sessionId, block.id, scrubSecrets(safe))
            }
            const res = await ctx.runtime.exec(rewrite?.command ?? command, {
              cwd: ctx.cwd,
              timeoutMs: timeout ?? 180_000,
              signal: ctx.signal,
              onChunk: (chunk) => flush(chunk)
            })
            flush('', true)
            const raw = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
            const body = scrubSecrets(raw)
            // Only when something was actually redacted, so an ordinary
            // command's live output is left exactly as it streamed in.
            if (body !== raw) store.updateBlock(ctx.sessionId, block.id, { output: body })
            return {
              output: body || '(no output)',
              exitCode: res.exitCode
            }
          }
        )
      }
    })

    tools.bash_output = tool({
      description:
        'Read whatever a background task has produced since the last time you read it. ' +
        'Returns only the new output, so it is safe to poll.',
      inputSchema: z.object({
        id: z.string().describe('The id bash returned when it started in the background.')
      }),
      execute: async ({ id }) => {
        const result = readBackgroundOutput(id)
        if (!result) {
          const known = listBackgroundTasks(ctx.sessionId)
          throw new Error(
            known.length === 0
              ? `No background task ${id}; none are running in this session.`
              : `No background task ${id}. Running or finished here: ${known
                  .map((task) => `${task.id} (${task.description})`)
                  .join(', ')}`
          )
        }
        return withBlock(
          ctx,
          {
            tool: 'bash_output',
            title: result.task.description,
            subtitle: result.task.status,
            input: { id, command: result.task.command }
          },
          async (block) => {
            const chunk = scrubSecrets(result.chunk)
            store.appendBlockOutput(ctx.sessionId, block.id, chunk || '(nothing new)')
            return {
              output: `${describeForModel(result.task)}\n\nNew output:\n${
                chunk || '(nothing new since the last read)'
              }`
            }
          }
        )
      }
    })

    tools.bash_kill = tool({
      description: 'End a background task you started.',
      inputSchema: z.object({ id: z.string() }),
      execute: async ({ id }) => {
        const task = killBackgroundTask(id)
        if (!task) throw new Error(`No background task ${id}.`)
        return withBlock(
          ctx,
          {
            tool: 'bash_kill',
            title: task.description,
            subtitle: 'stopped',
            input: { id, command: task.command }
          },
          async () => ({ output: `Background task ${id} stopped.` })
        )
      }
    })
  }

  if (enabled(ctx, 'read')) {
    tools.read = tool({
      description: 'Read a text file. Returns the contents with line numbers.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path, or relative to the working directory.'),
        offset: z.number().int().min(1).optional().describe('First line to read (1-based).'),
        limit: z.number().int().min(1).max(4000).optional().describe('How many lines to read.')
      }),
      execute: async ({ path, offset, limit }) => {
        const resolved = ctx.runtime.resolve(ctx.cwd, path)
        return withBlock(
          ctx,
          {
            tool: 'read',
            title: shortPath(ctx.cwd, resolved),
            subtitle: offset || limit ? `lines ${offset ?? 1}–${(offset ?? 1) + (limit ?? 2000) - 1}` : undefined,
            input: { path: resolved, offset, limit },
            permission: { key: 'read', detail: `Read ${resolved}`, preview: resolved }
          },
          async (block) => {
            if (await ctx.runtime.isDirectory(resolved)) {
              const entries = await ctx.runtime.list(resolved)
              const listing = entries.map((e) => `${e.directory ? 'dir ' : 'file'} ${e.name}`).join('\n')
              store.appendBlockOutput(ctx.sessionId, block.id, listing)
              return { output: `${resolved} is a directory:\n${listing}` }
            }
            const content = await ctx.runtime.readFile(resolved)
            const all = content.split('\n')
            /*
             * shunt mode: a whole large file does not come in here. Checked
             * after reading it, because the line count is the threshold and
             * the file has to be read to be counted — it costs I/O, which is
             * not the resource this mode is protecting.
             *
             * This was briefly gated on there being a cheaper model to send it
             * to, on the assumption that `bulk_read` would be missing without
             * one. It is not: with no cheaper model the file goes to this
             * session's own model in a request that is thrown away, which
             * costs full price and still keeps the file out of the
             * conversation — and the conversation is what this switch is
             * mostly for. The gate would have quietly removed that.
             */
            const refusal =
              ctx.savings.shunt
                ? readRefusal({
                    path: resolved,
                    lines: all.length,
                    offset,
                    limit,
                    minLines: ctx.config.shuntMinLines
                  })
                : null
            if (refusal) throw new Error(refusal)
            const start = (offset ?? 1) - 1
            const end = Math.min(all.length, start + (limit ?? 2000))
            const slice = all.slice(start, end)
            const numbered = slice.map((line, i) => `${String(start + i + 1).padStart(6)}\t${line}`).join('\n')
            store.appendBlockOutput(ctx.sessionId, block.id, numbered)
            const more = end < all.length ? `\n[${all.length - end} more lines]` : ''
            return { output: `${numbered}${more}` }
          }
        )
      }
    })
  }

  if (enabled(ctx, 'write')) {
    tools.write = tool({
      description: 'Create a file, or replace its entire contents.',
      inputSchema: z.object({
        path: z.string().describe('Absolute path, or relative to the working directory.'),
        content: z.string().describe('The full file contents.')
      }),
      execute: async ({ path, content }) => {
        const resolved = ctx.runtime.resolve(ctx.cwd, path)
        const existed = await ctx.runtime.exists(resolved)
        const before = existed ? await ctx.runtime.readFile(resolved).catch(() => '') : ''
        const preview = existed
          ? renderDiff(before, content)
          : content.split('\n').slice(0, 60).map((l) => `+  ${l}`).join('\n')
        const stats = diffStats(before, content)
        return withBlock(
          ctx,
          {
            tool: 'write',
            title: shortPath(ctx.cwd, resolved),
            subtitle: existed ? `+${stats.added} −${stats.removed}` : `new file, ${content.split('\n').length} lines`,
            input: { path: resolved, content },
            added: stats.added,
            removed: stats.removed,
            permission: {
              key: 'write',
              detail: `${existed ? 'Overwrite' : 'Create'} ${resolved}`,
              preview
            }
          },
          async (block) => {
            // Asked before the write, so a clash is reported against whoever
            // got there first rather than against this call itself.
            const warning = writeWarning(ctx.sessionId, resolved)
            await ctx.runtime.writeFile(resolved, content)
            recordWrite(ctx.sessionId, resolved)
            store.appendBlockOutput(ctx.sessionId, block.id, preview)
            return {
              output:
                `${existed ? 'Overwrote' : 'Created'} ${resolved} (+${stats.added} −${stats.removed}).` +
                warning
            }
          }
        )
      }
    })
  }

  if (enabled(ctx, 'edit')) {
    tools.edit = tool({
      description:
        'Replace an exact string in a file. The old string must appear exactly once unless ' +
        'replace_all is set. Read the file first.',
      inputSchema: z.object({
        path: z.string(),
        old_string: z.string().describe('Exact text to replace, including indentation.'),
        new_string: z.string().describe('Replacement text.'),
        replace_all: z.boolean().optional().describe('Replace every occurrence.')
      }),
      execute: async ({ path, old_string, new_string, replace_all }) => {
        const resolved = ctx.runtime.resolve(ctx.cwd, path)
        const before = await ctx.runtime.readFile(resolved)
        const occurrences = before.split(old_string).length - 1
        if (occurrences === 0) {
          throw new Error(
            `old_string was not found in ${resolved}. Read the file again and match the exact text.`
          )
        }
        if (occurrences > 1 && !replace_all) {
          throw new Error(
            `old_string appears ${occurrences} times in ${resolved}. Add more surrounding context, or set replace_all.`
          )
        }
        const after = replace_all
          ? before.split(old_string).join(new_string)
          : before.replace(old_string, new_string)
        const preview = renderDiff(before, after)
        const stats = diffStats(before, after)
        return withBlock(
          ctx,
          {
            tool: 'edit',
            title: shortPath(ctx.cwd, resolved),
            subtitle: `+${stats.added} −${stats.removed}`,
            input: { path: resolved, old_string, new_string, replace_all },
            added: stats.added,
            removed: stats.removed,
            permission: { key: 'edit', detail: `Edit ${resolved}`, preview }
          },
          async (block) => {
            const warning = writeWarning(ctx.sessionId, resolved)
            await ctx.runtime.writeFile(resolved, after)
            recordWrite(ctx.sessionId, resolved)
            store.appendBlockOutput(ctx.sessionId, block.id, preview)
            return { output: `Edited ${resolved} (+${stats.added} −${stats.removed}).` + warning }
          }
        )
      }
    })
  }

  if (enabled(ctx, 'grep')) {
    tools.grep = tool({
      description: 'Search file contents with a regular expression. Prefer this over bash grep.',
      inputSchema: z.object({
        pattern: z.string().describe('Regular expression to search for.'),
        path: z.string().optional().describe('Directory or file to search. Defaults to the working directory.'),
        glob: z.string().optional().describe('Restrict to files matching this glob, e.g. "*.ts".'),
        max_results: z.number().int().min(1).max(500).optional()
      }),
      execute: async ({ pattern, path, glob, max_results }) => {
        const target = ctx.runtime.resolve(ctx.cwd, path ?? '.')
        const limit = max_results ?? 200
        const globArg = glob ? `--glob ${shellQuote(glob)}` : ''
        const grepInclude = glob ? `--include=${shellQuote(glob)}` : ''
        const own =
          `if command -v rg >/dev/null 2>&1; then ` +
          `rg --line-number --no-heading --color never --max-count 20 ${globArg} -e ${shellQuote(pattern)} ${shellQuote(target)} 2>/dev/null | head -n ${limit}; ` +
          `else grep -rnI --color=never ${grepInclude} -e ${shellQuote(pattern)} ${shellQuote(target)} 2>/dev/null | head -n ${limit}; fi`
        // rtk groups matches by file and truncates long lines. Only when no
        // glob was asked for: rtk grep takes no include filter, and quietly
        // searching more than was asked is worse than not saving the tokens.
        const bin = glob ? null : await rtkUsable(ctx)
        const viaRtk = bin !== null
        const command = bin
          ? (rtkListingCommand('grep', { pattern, path: target, bin }) ?? own)
          : own
        return withBlock(
          ctx,
          {
            tool: 'grep',
            title: pattern,
            subtitle: `in ${shortPath(ctx.cwd, target)}${glob ? ` · ${glob}` : ''}`,
            input: { pattern, path: target, glob, ...(viaRtk ? { ranAs: command } : {}) }
          },
          async (block) => {
            const res = await ctx.runtime.exec(command, { cwd: ctx.cwd, timeoutMs: 60_000, signal: ctx.signal })
            const body = res.stdout.trim()
            store.appendBlockOutput(ctx.sessionId, block.id, body || 'no matches')
            if (!body) return { output: 'No matches.' }
            if (viaRtk) return { output: body }
            const count = body.split('\n').length
            return { output: `${count} matching lines:\n${body}` }
          }
        )
      }
    })
  }

  if (enabled(ctx, 'glob')) {
    tools.glob = tool({
      description: 'Find files by name pattern, newest first.',
      inputSchema: z.object({
        pattern: z.string().describe('A glob such as "**/*.ts" or "Dockerfile".'),
        path: z.string().optional()
      }),
      execute: async ({ pattern, path }) => {
        const target = ctx.runtime.resolve(ctx.cwd, path ?? '.')
        const normalized = pattern.replace(/\*\*\//g, '*')
        const matcher = normalized.includes('/')
          ? `-path ${shellQuote(`*${normalized}`)}`
          : `-name ${shellQuote(normalized)}`
        const own =
          `find ${shellQuote(target)} -type d \\( -name node_modules -o -name .git -o -name dist -o -name out \\) -prune -o ` +
          `-type f ${matcher} -print 2>/dev/null | head -n 300`
        const bin = await rtkUsable(ctx)
        const viaRtk = bin !== null
        const command = bin
          ? (rtkListingCommand('glob', { pattern, path: target, bin }) ?? own)
          : own
        return withBlock(
          ctx,
          {
            tool: 'glob',
            title: pattern,
            subtitle: `in ${shortPath(ctx.cwd, target)}`,
            input: { pattern, path: target, ...(viaRtk ? { ranAs: command } : {}) }
          },
          async (block) => {
            const res = await ctx.runtime.exec(command, { cwd: ctx.cwd, timeoutMs: 60_000, signal: ctx.signal })
            const body = res.stdout.trim()
            store.appendBlockOutput(ctx.sessionId, block.id, body || 'no matches')
            return { output: body || 'No files matched.' }
          }
        )
      }
    })
  }

  if (enabled(ctx, 'list')) {
    tools.list = tool({
      description: 'List a directory.',
      inputSchema: z.object({ path: z.string().optional() }),
      execute: async ({ path }) => {
        const target = ctx.runtime.resolve(ctx.cwd, path ?? '.')
        // rtk ls is a tree with counts instead of one line per entry, which is
        // most of the saving on a directory anyone would call large.
        const bin = await rtkUsable(ctx)
        const command = bin ? rtkListingCommand('list', { path: target, bin }) : null
        return withBlock(
          ctx,
          {
            tool: 'list',
            title: shortPath(ctx.cwd, target) || '.',
            input: { path: target, ...(command ? { ranAs: command } : {}) }
          },
          async (block) => {
            if (command) {
              const res = await ctx.runtime.exec(command, {
                cwd: ctx.cwd,
                timeoutMs: 60_000,
                signal: ctx.signal
              })
              const listing = res.stdout.trim()
              if (listing) {
                store.appendBlockOutput(ctx.sessionId, block.id, listing)
                return { output: listing }
              }
              // rtk had nothing to say about it; the real listing still does.
            }
            const entries = await ctx.runtime.list(target)
            const body = entries
              .map((e) => `${e.directory ? 'dir ' : 'file'}  ${e.name}${e.directory ? '/' : ''}`)
              .join('\n')
            store.appendBlockOutput(ctx.sessionId, block.id, body)
            return { output: body || '(empty directory)' }
          }
        )
      }
    })
  }

  if (enabled(ctx, 'deliver')) {
    tools.deliver = tool({
      /*
       * The one way a finished file reaches the person.
       *
       * The interface already turns a document into a card you can open and
       * save — but it only knew about files written with `write` or `edit`,
       * which is not how a report gets made. A thirteen-page PDF and a
       * two-hundred-row CSV come out of a script the agent ran, and those sat
       * on disk with nothing in the conversation to say they existed. This is
       * the agent saying so.
       */
      description:
        'Hand finished files to the person: each one appears in the conversation as a card they ' +
        'can open or save. Use it for the thing they asked for — a report, an export, a chart, a ' +
        'screenshot — however it was made. A file written by a script you ran is invisible until ' +
        'you hand it over. Not for source files you changed: those are already in the diff.',
      inputSchema: z.object({
        paths: z
          .array(z.string())
          .min(1)
          .max(10)
          .describe('Paths to the finished files, in the order they should be shown.'),
        note: z
          .string()
          .optional()
          .describe('One short line about what they are, when the names do not say it.')
      }),
      execute: async ({ paths, note }) => {
        const resolved = paths.map((path) => ctx.runtime.resolve(ctx.cwd, path))
        return withBlock(
          ctx,
          {
            tool: 'deliver',
            title: note ?? resolved.map((path) => shortPath(ctx.cwd, path)).join(', '),
            subtitle: `${resolved.length} file${resolved.length === 1 ? '' : 's'}`,
            input: { paths: resolved, note }
          },
          async () => {
            /*
             * Every one of them has to be there. Handing over a path that does
             * not exist produces a card that fails when it is clicked, which
             * is a worse answer than saying so now — and a wrong path is the
             * likeliest mistake here, since the file was made by something
             * else.
             */
            const sized = await Promise.all(
              resolved.map(async (path) => ({
                path,
                stat: await ctx.runtime.stat(path).catch(() => null)
              }))
            )
            const missing = sized.filter((entry) => entry.stat === null).map((entry) => entry.path)
            if (missing.length > 0) {
              throw new Error(
                `Nothing at ${missing.join(', ')}. Check the path — a file made by a command is ` +
                  `wherever that command put it, not necessarily in the working directory.`
              )
            }
            const lines = sized.map(
              (entry) => `${shortPath(ctx.cwd, entry.path)} — ${fileSize(entry.stat?.size ?? 0)}`
            )
            return { output: lines.join('\n') }
          }
        )
      }
    })
  }

  if (enabled(ctx, 'fetch')) {
    tools.fetch = tool({
      description: 'Fetch a URL and return its text. Runs from the machine hosting OpenDesktop.',
      inputSchema: z.object({ url: z.string().url() }),
      execute: async ({ url }) =>
        withBlock(
          ctx,
          {
            tool: 'fetch',
            title: url,
            input: { url },
            permission: { key: 'fetch', detail: `Fetch ${url}`, preview: url }
          },
          async (block) => {
            const res = await fetch(url, { signal: ctx.signal, headers: { 'user-agent': 'OpenDesktop' } })
            const text = await res.text()
            const body = scrubSecrets(
              text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
            )
            store.appendBlockOutput(ctx.sessionId, block.id, body.slice(0, 20_000))
            return { output: `HTTP ${res.status}\n\n${body}`, exitCode: res.ok ? 0 : 1 }
          }
        )
    })
  }

  /*
   * shunt mode's two tools. Present only in that mode: a tool the agent cannot
   * use is a tool it will try to use anyway, and a description explaining that
   * the feature is off is worse than the tokens it costs.
   */
  if (ctx.savings.shunt) {
    /*
     * Who does the work. Named in the settings, or worked out: the cheapest
     * model that clears the capability floor for reading and writing, the most
     * capable one for planning. Decided per turn rather than once, because an
     * allowance running out changes the answer.
     */
    const spent = spentLookup(ctx.config)
    const worker = workerModelRef(ctx.config, ctx.modelRef, spent)
    const planner = plannerModelRef(ctx.config, ctx.modelRef, spent)

    /** Spends another model's tokens against this session, priced as that model. */
    const credit = (ref: string, usage: { input: number; output: number }): string => {
      const cost = costOf(ctx.config, ref, usage)
      store.creditUsage(ctx.sessionId, { ...usage, cost: cost ?? 0 })
      meterRecord(ref, { ...usage, cost: cost ?? 0 })
      return `${ref}: ${usage.input} in, ${usage.output} out`
    }

    /*
     * All of them at once. Reading a corpus one file at a time is one round
     * trip per file, and on a remote target a round trip is most of the cost of
     * a small file — the whole point of handing a list over is that it is a
     * list. Order is preserved, since the answer quotes them back.
     */
    const gather = async (paths: string[]): Promise<{ path: string; text: string }[]> =>
      Promise.all(
        paths.map(async (path) => {
          const text = await ctx.runtime.readFile(path).catch(() => null)
          if (text === null) throw new Error(`Cannot read ${path}. Check the path and try again.`)
          return { path, text }
        })
      )

    if (enabled(ctx, 'bulk_read')) {
      tools.bulk_read = tool({
        description:
          'Ask a question about one or more files without reading them into this conversation. ' +
          'The files go to another model, which answers and is then forgotten; only its answer ' +
          'comes back here. Use it for anything you are reading to understand rather than to ' +
          'edit: a large file, a question spanning several files, a long diff.\n' +
          'Every call stands alone, so asking again with the same paths costs you nothing — ask ' +
          'one thing at a time instead of one question about everything. The answer is ' +
          'second-hand: before you edit or quote anything, read that part with read and an ' +
          'offset, which is always allowed.',
        inputSchema: z.object({
          question: z.string().describe('One specific question about these files.'),
          paths: z
            .array(z.string())
            .min(1)
            .max(25)
            .describe('The files to send. Absolute, or relative to the working directory.')
        }),
        execute: async ({ question, paths }) => {
          const resolved = paths.map((path) => ctx.runtime.resolve(ctx.cwd, path))
          return withBlock(
            ctx,
            {
              tool: 'bulk_read',
              title: question,
              subtitle: `${resolved.length} file${resolved.length === 1 ? '' : 's'} · ${worker}`,
              input: { question, paths: resolved, model: worker },
              permission: {
                key: 'read',
                detail: `Read ${resolved.length} file${resolved.length === 1 ? '' : 's'}`,
                preview: resolved.join('\n')
              }
            },
            async (block) => {
              const files = await gather(resolved)
              const corpus = packFiles(files)
              // What this worker can hold, not what a hosted one could.
              const limit = payloadLimitFor(ctx.config, worker)
              if (corpus.length > limit) {
                throw new Error(
                  payloadRefusal({ chars: corpus.length, limit, worker, files: files.length })
                )
              }
              store.appendBlockOutput(
                ctx.sessionId,
                block.id,
                `asking ${worker} about ${files.length} file${files.length === 1 ? '' : 's'}…\n\n`
              )
              const answer = await askWorker({
                config: ctx.config,
                modelRef: worker,
                system: BULK_READER_INSTRUCTIONS,
                prompt: `<question>\n${question}\n</question>\n\n${corpus}`,
                signal: ctx.signal
              })
              const paid = credit(worker, answer.usage)
              const kept = Math.round(corpus.length / 4)
              store.appendBlockOutput(
                ctx.sessionId,
                block.id,
                `${answer.text}\n\n— ${paid}. About ${kept.toLocaleString('en-US')} tokens of ` +
                  `file stayed out of this conversation.`
              )
              return { output: answer.text || '(the worker returned nothing)' }
            }
          )
        }
      })
    }

    /*
     * The other direction. If the cheap model does the reading, the expensive
     * one should do the thinking — and only the thinking, which is a few
     * hundred tokens of question and a page of answer, so it is affordable on
     * a model nobody would run a whole session on.
     *
     * Not offered when the session is already on the most capable model there
     * is: asking itself for a plan is a round trip that returns its own
     * judgement, which it can have for free by thinking.
     */
    if (enabled(ctx, 'plan') && planner !== ctx.modelRef) {
      tools.plan = tool({
        description:
          `Ask a stronger model (${planner}) how to do something hard, before starting it. ` +
          'Use it when the work has several moving parts, when the order matters, or when a ' +
          'wrong approach would be expensive to undo — not for anything you already know how ' +
          'to do. It has no tools and cannot see this conversation, so put everything it needs ' +
          'in the request: what you are trying to achieve, what you have found out so far, and ' +
          'the constraints. What comes back is a plan, not work: you carry it out.',
        inputSchema: z.object({
          task: z.string().describe('What needs doing, in full, standing on its own.'),
          context: z
            .string()
            .optional()
            .describe('What you already know: files, findings, constraints, what has been tried.')
        }),
        execute: async ({ task, context }) =>
          withBlock(
            ctx,
            {
              tool: 'plan',
              title: task.replace(/\s+/g, ' ').slice(0, 90),
              subtitle: `planned by ${planner}`,
              input: { task, context, model: planner }
            },
            async (block) => {
              store.appendBlockOutput(ctx.sessionId, block.id, `asking ${planner}…\n\n`)
              const answer = await askWorker({
                config: ctx.config,
                modelRef: planner,
                system: PLANNER_INSTRUCTIONS,
                prompt:
                  `<task>\n${task}\n</task>` +
                  (context ? `\n\n<what-is-already-known>\n${context}\n</what-is-already-known>` : ''),
                signal: ctx.signal
              })
              const paid = credit(planner, answer.usage)
              if (!answer.text.trim()) throw new Error(`${planner} returned no plan.`)
              store.appendBlockOutput(ctx.sessionId, block.id, `${answer.text}\n\n— ${paid}`)
              return {
                output:
                  `${answer.text}\n\n(That plan is ${planner}'s, not yours to hand back to the ` +
                  `user as an answer. Carry it out, and say so if you find it is wrong.)`
              }
            }
          )
      })
    }

    if (enabled(ctx, 'code_write')) {
      tools.code_write = tool({
        description:
          'Generate a file from a spec and a reference file, without the generated code passing ' +
          'through this conversation. For work that is mostly predictable from something that ' +
          'already exists: tests alongside existing tests, config beside config, stubs, ' +
          'docstrings. A reference is required — without one the result matches nothing in the ' +
          'project. Give a target to have it written, or leave it out to read it back here. ' +
          'Not for work that needs judgement: do that yourself with write and edit.',
        inputSchema: z.object({
          spec: z.string().describe('What to generate, in as much detail as you have.'),
          reference: z
            .array(z.string())
            .min(1)
            .max(10)
            .describe('Existing files whose patterns and style the result must match.'),
          target: z.string().optional().describe('Where to write it. Omitted, it comes back here.')
        }),
        execute: async ({ spec, reference, target }) => {
          const references = reference.map((path) => ctx.runtime.resolve(ctx.cwd, path))
          const destination = target ? ctx.runtime.resolve(ctx.cwd, target) : null
          return withBlock(
            ctx,
            {
              tool: 'code_write',
              title: destination ? shortPath(ctx.cwd, destination) : spec,
              subtitle: destination ? spec : `${worker} · to this conversation`,
              input: { spec, reference: references, target: destination, model: worker }
            },
            async (block) => {
              const files = await gather(references)
              const corpus = packFiles(files)
              const limit = payloadLimitFor(ctx.config, worker)
              if (corpus.length > limit) {
                throw new Error(
                  payloadRefusal({ chars: corpus.length, limit, worker, files: files.length })
                )
              }
              store.appendBlockOutput(ctx.sessionId, block.id, `asking ${worker} to write it…\n\n`)
              const answer = await askWorker({
                config: ctx.config,
                modelRef: worker,
                system: CODE_WRITER_INSTRUCTIONS,
                prompt:
                  `<spec>\n${spec}\n</spec>\n\n<reference>\n${corpus}\n</reference>` +
                  (destination ? `\n\nWrite the complete contents of ${destination}.` : ''),
                signal: ctx.signal
              })
              const paid = credit(worker, answer.usage)
              const code = stripFences(answer.text)
              if (!code.trim()) throw new Error(`${worker} returned nothing. Try a clearer spec.`)

              if (!destination) {
                store.appendBlockOutput(ctx.sessionId, block.id, `${code}\n\n— ${paid}`)
                return { output: code }
              }

              /*
               * Asked here rather than before the run, and this is the reason
               * the tool is written this way: an approval for a write has to
               * show the diff, and there is no diff until the worker has
               * answered. The generation is cheap; the write is the part that
               * needs consent.
               */
              const existed = await ctx.runtime.exists(destination)
              const before = existed ? await ctx.runtime.readFile(destination).catch(() => '') : ''
              const preview = existed
                ? renderDiff(before, code)
                : code
                    .split('\n')
                    .slice(0, 60)
                    .map((line) => `+  ${line}`)
                    .join('\n')
              const stats = diffStats(before, code)
              await askPermission(ctx, block, {
                key: 'write',
                detail: `${existed ? 'Overwrite' : 'Create'} ${destination}`,
                preview
              })

              const warning = writeWarning(ctx.sessionId, destination)
              await ctx.runtime.writeFile(destination, code)
              recordWrite(ctx.sessionId, destination)
              store.updateBlock(ctx.sessionId, block.id, {
                added: stats.added,
                removed: stats.removed
              })
              store.appendBlockOutput(ctx.sessionId, block.id, `${preview}\n\n— ${paid}`)
              return {
                output:
                  `${existed ? 'Overwrote' : 'Created'} ${destination} ` +
                  `(+${stats.added} −${stats.removed}, ${code.split('\n').length} lines). ` +
                  `The code did not pass through this conversation — read the parts you intend ` +
                  `to change before changing them.` +
                  warning
              }
            }
          )
        }
      })
    }
  }

  // Subagents. Depth-limited so a misbehaving agent cannot fork forever.
  const subagents = Object.values(ctx.config.agent).filter(
    (a) => a.mode === 'subagent' || a.mode === 'all'
  )
  if (enabled(ctx, 'task') && ctx.spawnSubagent && ctx.depth < 2 && subagents.length > 0) {
    tools.task = tool({
      description:
        'Delegate a self-contained piece of work to another agent. Available agents:\n' +
        subagents.map((a) => `- ${a.id}: ${a.description}`).join('\n') +
        '\nThe subagent does not see this conversation, so the prompt must stand alone. ' +
        'Launch independent subagents in the same step to run them in parallel.\n' +
        'Hand over what you already know with `context_paths` and `context_notes`: the files ' +
        'are read for it and put in front of it, so it starts where you are instead of ' +
        'rediscovering the repository. That is most of what delegating costs.',
      inputSchema: z.object({
        agent: z.string().describe(`One of: ${subagents.map((a) => a.id).join(', ')}`),
        description: z.string().describe('A 3-8 word label for the UI.'),
        prompt: z.string().describe('The full, self-contained task for the subagent.'),
        context_paths: z
          .array(z.string())
          .optional()
          .describe(
            'Files you have already read that it will need. They are read and handed to it ' +
              'with the brief; it does not have to read them again.'
          ),
        context_notes: z
          .string()
          .optional()
          .describe(
            'What you already know that is not in those files: conventions, what you have ' +
              'ruled out, how the thing is wired.'
          )
      }),
      execute: async ({ agent, description, prompt, context_paths, context_notes }) => {
        const target = ctx.config.agent[agent]
        if (!target || !(target.mode === 'subagent' || target.mode === 'all')) {
          throw new Error(`Unknown subagent "${agent}". Available: ${subagents.map((a) => a.id).join(', ')}`)
        }
        return withBlock(
          ctx,
          {
            tool: 'task',
            title: description,
            subtitle: `${target.name} subagent`,
            // The handover is part of the brief, so it belongs on the block:
            // a delegation is meant to be inspectable, and "what did the lead
            // hand over" is the first thing to ask when a subagent goes wrong.
            input: {
              agent,
              description,
              prompt,
              ...(context_paths?.length ? { context_paths } : {}),
              ...(context_notes ? { context_notes } : {})
            }
          },
          async (block) => {
            await takeFanoutSlot(ctx)
            const { sessionId, report } = await ctx
              .spawnSubagent!({
                agentId: agent,
                prompt,
                description,
                parentBlockId: block.id,
                contextPaths: context_paths,
                contextNotes: context_notes
              })
              .finally(() => releaseFanoutSlot(ctx.sessionId))
            // Recorded on the block so the UI can open the subagent's own
            // transcript; two subagents can share a description, an id cannot.
            store.updateBlock(ctx.sessionId, block.id, {
              input: { ...block.input, childSessionId: sessionId }
            })
            store.appendBlockOutput(ctx.sessionId, block.id, report)
            return { output: report }
          }
        )
      }
    })
  }

  /**
   * The Blocked column's other half. Approvals already land a task there, but
   * plenty of work stops for a reason no approval covers: a form to fill in, a
   * credential only a person has, a decision that is not the agent's to make.
   * Without this the agent's only options are to guess or to give up quietly.
   */
  tools.need_human = tool({
    description:
      'Stop and hand this task back to a person. Use when you cannot continue without ' +
      'something only they can do — filling in a form, granting access, choosing between ' +
      'options that are genuinely theirs to choose. Say exactly what you need. Do not use ' +
      'this to ask permission to run a command; that is handled for you.',
    inputSchema: z.object({
      reason: z.string().describe('What you need from them, in one or two sentences.')
    }),
    execute: async ({ reason }) => {
      store.updateSession(ctx.sessionId, { status: 'blocked', blockedReason: reason })
      return {
        output:
          `Handed back to the user: ${reason}\n\n` +
          'Stop here. Do not keep working around it — they have been asked and the task is ' +
          'now waiting on them.'
      }
    }
  })

  return tools
}

/**
 * The tools that change something, as opposed to reading it.
 *
 * Named here rather than in the prompt that talks about them, so an agent's
 * system prompt and this file cannot drift into disagreeing about which tools
 * a read-only agent is missing.
 */
export const MUTATING_TOOLS = ['write', 'edit', 'bash'] as const

export function toolNames(): string[] {
  return [
    'bash',
    'bash_output',
    'bash_kill',
    'read',
    'write',
    'edit',
    'grep',
    'glob',
    'list',
    'fetch',
    'task',
    'bulk_read',
    'code_write',
    'plan'
  ]
}

export { basename }
