/**
 * Things this app does when the agent does something, without telling it.
 *
 * Everything else that shapes a turn is text the model reads and pays for in
 * every step's prefix: a rule in the prompt, a tool schema, a note from a
 * neighbour. A hook is the other kind of lever — it runs on the machine, not
 * in the conversation, so it costs nothing to have and the model never spends
 * attention on it. Formatting after an edit, staging what changed, running the
 * tests when a file is touched, refusing to write somewhere: none of that is
 * the model's business, and until now all of it had to be asked for in words
 * and hoped for.
 *
 * Three moments, deliberately few:
 *
 *   before  a tool runs. A non-zero exit refuses the call, and what the hook
 *           printed becomes the reason the agent is given — the one case where
 *           a hook does reach the conversation, because a refusal it cannot
 *           read is a refusal it will retry for ever.
 *   after   a tool has run, for the side effects. Its output is kept on the
 *           block for you and never sent to the model.
 *   turn    once the turn is over, for the things that are about the whole of
 *           it: a notification, a commit, a sweep.
 *
 * They run on the session's own execution target, in its working directory, so
 * a hook belonging to a session attached to a remote host runs there — which
 * is the only place "the file that just changed" means anything.
 */
import type { AppConfig, HookConfig, HookEvent } from '@shared/types'
import { shellQuote, type Runtime } from './runtime'
import { logLine } from './log'

/** Long enough for a formatter, short enough not to be mistaken for the work. */
const DEFAULT_TIMEOUT_MS = 15_000
const MAX_TIMEOUT_MS = 120_000

export interface HookContext {
  event: HookEvent
  /** The tool this is about, or `turn` for the end of one. */
  tool: string
  sessionId: string
  cwd: string
  /** The file a write, edit or read is about, when there is one. */
  path?: string
  /** The command a bash call is about, when there is one. */
  command?: string
  /** For `after`: whether the tool succeeded. */
  ok?: boolean
}

export interface HookOutcome {
  /** Set when a `before` hook refused the call. */
  refusal?: string
  /** What the hooks printed, for the block. Never sent to the model. */
  notes: string[]
}

/**
 * Whether this hook is about this call.
 *
 * The matcher is a regular expression over the tool name, because that is what
 * the events are about and anything cleverer would be a second little language
 * to learn. No matcher means every tool of that event.
 */
export function matches(hook: HookConfig, tool: string): boolean {
  if (hook.enabled === false) return false
  if (!hook.matcher) return true
  try {
    return new RegExp(`^(${hook.matcher})$`, 'i').test(tool)
  } catch {
    // A matcher that does not compile matches nothing, and says so once.
    logLine('warn', `hook ${hook.id}: "${hook.matcher}" is not a valid matcher`)
    return false
  }
}

export function hooksFor(config: AppConfig, event: HookEvent, tool: string): HookConfig[] {
  return (config.hooks ?? []).filter((hook) => hook.event === event && matches(hook, tool))
}

/**
 * What the hook is told, as environment variables.
 *
 * Variables rather than arguments so a hook is a line of shell somebody can
 * paste, and prefixed so they cannot be mistaken for the machine's own.
 */
export function hookEnvironment(context: HookContext): Record<string, string> {
  return {
    OPENDESKTOP_EVENT: context.event,
    OPENDESKTOP_TOOL: context.tool,
    OPENDESKTOP_SESSION: context.sessionId,
    OPENDESKTOP_CWD: context.cwd,
    ...(context.path ? { OPENDESKTOP_PATH: context.path } : {}),
    ...(context.command ? { OPENDESKTOP_COMMAND: context.command } : {}),
    ...(context.ok === undefined ? {} : { OPENDESKTOP_OK: context.ok ? '1' : '0' })
  }
}

/**
 * `export A=1; <command>` — set for this shell only, on whatever host runs it.
 *
 * Exports rather than the shorter `A=1 command` prefix, which only works in
 * front of a simple command: a hook is a line of shell somebody pasted and
 * half of those start with `if` or `case`, where a prefix is a parse error
 * with the hook's name on it. Found exactly that way.
 */
export function withEnvironment(command: string, env: Record<string, string>): string {
  const exports = Object.entries(env)
    .map(([key, value]) => `export ${key}=${shellQuote(value)};`)
    .join(' ')
  return exports ? `${exports} ${command}` : command
}

/**
 * Runs the hooks for one moment, in the order they are declared.
 *
 * A `before` hook that exits non-zero stops the call there and no later hook
 * runs: the first refusal is the answer, and running the rest would be doing
 * work whose result has already been overruled. Anywhere else a failing hook
 * is noted and the work carries on — a formatter that broke is not a reason to
 * throw away an edit that succeeded.
 */
export async function runHooks(
  config: AppConfig,
  runtime: Runtime,
  context: HookContext
): Promise<HookOutcome> {
  const hooks = hooksFor(config, context.event, context.tool)
  const outcome: HookOutcome = { notes: [] }
  if (hooks.length === 0) return outcome

  const env = hookEnvironment(context)
  for (const hook of hooks) {
    const timeoutMs = Math.min(hook.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS)
    const started = Date.now()
    const result = await runtime
      .exec(withEnvironment(hook.command, env), { cwd: context.cwd, timeoutMs })
      .catch((err: Error) => ({ stdout: '', stderr: err.message, exitCode: 1, truncated: false }))

    const said = `${result.stdout}${result.stderr}`.trim()
    const label = hook.name || hook.id
    const took = Date.now() - started

    if (result.exitCode !== 0) {
      if (context.event === 'before') {
        outcome.refusal =
          said ||
          `A hook on this session ("${label}") refused this ${context.tool} call and said nothing about why.`
        logLine('info', `hook ${hook.id} refused ${context.tool}: ${said.slice(0, 200)}`)
        return outcome
      }
      outcome.notes.push(`${label} failed (${result.exitCode}): ${said || 'no output'}`)
      logLine('warn', `hook ${hook.id} on ${context.event} failed: ${said.slice(0, 200)}`)
      continue
    }

    if (said) outcome.notes.push(`${label}: ${said}`)
    if (took > 2_000) logLine('info', `hook ${hook.id} took ${took}ms on ${context.tool}`)
  }

  return outcome
}
