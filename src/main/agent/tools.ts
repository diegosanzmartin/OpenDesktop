import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { basename, relative } from 'node:path'
import type { AgentConfig, AppConfig, Block, Permissions } from '@shared/types'
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

export interface ToolContext {
  config: AppConfig
  agent: AgentConfig
  permissions: Permissions
  sessionId: string
  environmentId: string
  cwd: string
  runtime: Runtime
  signal: AbortSignal
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
    permission?: {
      key: keyof Omit<Permissions, 'allowlist' | 'denylist'>
      command?: string
      detail: string
      preview?: string
    }
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
    if (spec.permission) {
      const decision = decide(ctx.permissions, spec.permission.key, spec.permission.command)
      if (decision.mode === 'deny') {
        store.updateBlock(ctx.sessionId, block.id, {
          status: 'error',
          error: 'Not permitted by configuration',
          endedAt: Date.now()
        })
        throw new PermissionDenied(spec.permission.detail)
      }
      const needsAsk =
        decision.mode === 'ask' &&
        !decision.preapproved &&
        !hasSessionGrant(ctx.sessionId, spec.tool)

      if (needsAsk) {
        store.updateBlock(ctx.sessionId, block.id, { status: 'awaiting-approval' })
        store.setSessionStatus(ctx.sessionId, 'awaiting-approval')
        const answer = await requestApproval({
          sessionId: ctx.sessionId,
          blockId: block.id,
          tool: spec.tool,
          title: spec.title,
          detail: spec.permission.detail,
          summary: spec.subtitle,
          preview: spec.permission.preview,
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
          throw new PermissionDenied(spec.permission.detail)
        }
      }
    }

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
        return withBlock(
          ctx,
          {
            tool: 'bash',
            title: command,
            subtitle: description,
            input: { command, description, timeout },
            permission: { key: 'bash', command, detail: command, preview: command }
          },
          async (block) => {
            const res = await ctx.runtime.exec(command, {
              cwd: ctx.cwd,
              timeoutMs: timeout ?? 180_000,
              signal: ctx.signal,
              onChunk: (chunk) => store.appendBlockOutput(ctx.sessionId, block.id, chunk)
            })
            const body = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
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
            store.appendBlockOutput(ctx.sessionId, block.id, result.chunk || '(nothing new)')
            return {
              output: `${describeForModel(result.task)}\n\nNew output:\n${
                result.chunk || '(nothing new since the last read)'
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
        const command =
          `if command -v rg >/dev/null 2>&1; then ` +
          `rg --line-number --no-heading --color never --max-count 20 ${globArg} -e ${shellQuote(pattern)} ${shellQuote(target)} 2>/dev/null | head -n ${limit}; ` +
          `else grep -rnI --color=never ${grepInclude} -e ${shellQuote(pattern)} ${shellQuote(target)} 2>/dev/null | head -n ${limit}; fi`
        return withBlock(
          ctx,
          {
            tool: 'grep',
            title: pattern,
            subtitle: `in ${shortPath(ctx.cwd, target)}${glob ? ` · ${glob}` : ''}`,
            input: { pattern, path: target, glob }
          },
          async (block) => {
            const res = await ctx.runtime.exec(command, { cwd: ctx.cwd, timeoutMs: 60_000, signal: ctx.signal })
            const body = res.stdout.trim()
            store.appendBlockOutput(ctx.sessionId, block.id, body || 'no matches')
            const count = body ? body.split('\n').length : 0
            return { output: body ? `${count} matching lines:\n${body}` : 'No matches.' }
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
        const command =
          `find ${shellQuote(target)} -type d \\( -name node_modules -o -name .git -o -name dist -o -name out \\) -prune -o ` +
          `-type f ${matcher} -print 2>/dev/null | head -n 300`
        return withBlock(
          ctx,
          { tool: 'glob', title: pattern, subtitle: `in ${shortPath(ctx.cwd, target)}`, input: { pattern, path: target } },
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
        return withBlock(
          ctx,
          { tool: 'list', title: shortPath(ctx.cwd, target) || '.', input: { path: target } },
          async (block) => {
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
            const body = text.replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
            store.appendBlockOutput(ctx.sessionId, block.id, body.slice(0, 20_000))
            return { output: `HTTP ${res.status}\n\n${body}`, exitCode: res.ok ? 0 : 1 }
          }
        )
    })
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
        'Launch independent subagents in the same step to run them in parallel.',
      inputSchema: z.object({
        agent: z.string().describe(`One of: ${subagents.map((a) => a.id).join(', ')}`),
        description: z.string().describe('A 3-8 word label for the UI.'),
        prompt: z.string().describe('The full, self-contained task for the subagent.')
      }),
      execute: async ({ agent, description, prompt }) => {
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
            input: { agent, description, prompt }
          },
          async (block) => {
            const { sessionId, report } = await ctx.spawnSubagent!({
              agentId: agent,
              prompt,
              description,
              parentBlockId: block.id
            })
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
    'task'
  ]
}

export { basename }
