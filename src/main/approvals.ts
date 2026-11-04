import { nanoid } from 'nanoid'
import type {
  ApprovalRequest,
  AppConfig,
  PermissionMode,
  Permissions,
  Session
} from '@shared/types'
import { bus } from './bus'
import { rawConfig } from './config'
import { getSession, rootOf } from './store'

export type ApprovalAnswer = 'once' | 'always' | 'reject'

/** What a person decided; `note` is the reason they typed when they said no. */
export interface ApprovalDecision {
  answer: ApprovalAnswer
  note?: string
}

interface Pending {
  request: ApprovalRequest
  resolve: (decision: ApprovalDecision) => void
}

const pending = new Map<string, Pending>()
/** Per-session grants keyed by `tool` or `tool:signature`, from "Always allow". */
const sessionGrants = new Map<string, Set<string>>()

export class PermissionDenied extends Error {
  /**
   * `why` is for a refusal that was not a person's: the denylist. An agent told
   * only "not permitted" cannot tell a policy from a broken tool, and what it
   * does next is try the same thing another way — so the rule that refused it is
   * named, and the sentence says who refused.
   */
  constructor(what: string, why?: string, note?: string) {
    super(
      why
        ? `Refused by this machine's configuration (${why}): ${what}. Do not retry it and do not ` +
          `work around it; tell the user what you needed and why.`
        : note
          ? `Denied by the user: ${what}. Their reason: ${note}. Do what that says; do not retry ` +
            `the same thing another way.`
          : `Denied by the user: ${what}. Do not retry this; tell the user what you needed and why.`
    )
    this.endsTurn = !why && !note
  }

  /**
   * A bare "no" from a person ends the turn. Told "do not retry", models still
   * reached the same end another way (mv to /tmp, then cp to /tmp): the next
   * move has to be the person's.
   */
  readonly endsTurn: boolean
}

export function listPending(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.request)
}

export function grantForSession(sessionId: string, key: string): void {
  const set = sessionGrants.get(sessionId) ?? new Set<string>()
  set.add(key)
  sessionGrants.set(sessionId, set)
}

export function hasSessionGrant(sessionId: string, key: string): boolean {
  return sessionGrants.get(sessionId)?.has(key) ?? false
}

/**
 * What an "always" covers: the tool, or for a command each program in it (`bash:git`).
 * Null when the line hides a command or writes a file — that is never granted ahead.
 */
function grantKeys(tool: string, command?: string): string[] | null {
  if (!command) return [tool]
  const segments = splitCommand(command)
  if (segments.length === 0 || hasOpaqueShellSyntax(command) || segments.some(escalates)) return null
  return segments.map((segment) => `${tool}:${segment.split(/\s+/)[0]}`)
}

export function isGranted(sessionId: string, tool: string, command?: string): boolean {
  const keys = grantKeys(tool, command)
  return keys !== null && keys.every((key) => hasSessionGrant(sessionId, key))
}

export function resolveApproval(approvalId: string, answer: ApprovalAnswer, note?: string): void {
  const entry = pending.get(approvalId)
  if (!entry) return
  pending.delete(approvalId)
  bus.emit({ type: 'approval.resolved', approvalId })
  if (answer === 'always') {
    for (const key of grantKeys(entry.request.tool, entry.request.command) ?? []) {
      grantForSession(entry.request.sessionId, key)
    }
  }
  const reason = answer === 'reject' ? note?.trim() : undefined
  entry.resolve(reason ? { answer, note: reason } : { answer })
}

/** Rejects everything outstanding for a session, e.g. when the user stops the turn. */
export function cancelSessionApprovals(sessionId: string): void {
  for (const [id, entry] of [...pending.entries()]) {
    if (entry.request.sessionId !== sessionId) continue
    pending.delete(id)
    bus.emit({ type: 'approval.resolved', approvalId: id })
    entry.resolve({ answer: 'reject' })
  }
}

/**
 * Whether a conversation runs without asking, read at the moment a call would ask.
 * The switch can be flipped while a turn runs; a subagent follows the conversation it works for.
 */
export function autoApproving(config: AppConfig, sessionId: string): boolean {
  const session = getSession(sessionId)
  if (!session) return false
  const container = config.environment[session.environmentId]?.kind === 'container'
  return autoApproveNow(rootOf(session), config, container)
}

/** Once the switch is on, what that conversation and its subagents are waiting on goes through. */
export function approveWaiting(config: AppConfig, sessionId: string): void {
  if (!autoApproving(config, sessionId)) return
  for (const [id, entry] of [...pending.entries()]) {
    const owner = getSession(entry.request.sessionId)
    if (owner && rootOf(owner).id === sessionId) resolveApproval(id, 'once')
  }
}

export function requestApproval(input: {
  sessionId: string
  blockId: string
  tool: string
  title: string
  detail: string
  summary?: string
  preview?: string
  /** For a shell call: what "always" is granted against. */
  command?: string
  outside?: string[]
  /** Why a person is asked although the session runs without asking. */
  note?: string
  environmentId: string
  cwd: string
}): Promise<ApprovalDecision> {
  const request: ApprovalRequest = { ...input, id: nanoid(10), createdAt: Date.now() }
  return new Promise<ApprovalDecision>((resolve) => {
    pending.set(request.id, { request, resolve })
    bus.emit({ type: 'approval.requested', request })
  })
}

/**
 * Answers everything already waiting, for sessions that have just been told
 * not to ask.
 *
 * Turning the switch on has to reach the card that is on screen, or the switch
 * is a lie: the turn is stopped at a prompt, the person clicks "run without
 * asking", and the prompt they were looking at goes on asking. Nothing else in
 * the app can resolve it — the runner is parked on a promise, not polling.
 *
 * Each request is answered as `once`, not `always`: the grant map is for
 * programs a person named one at a time, and a blanket allow is neither what
 * was shown nor what auto-approve means. The denylist already had its say when
 * the question was raised, so what is released here is something the session is
 * now allowed to do anyway.
 */
export function releaseAutoApproved(
  autoApproves: (sessionId: string) => boolean
): number {
  let released = 0
  for (const [id, entry] of [...pending.entries()]) {
    // A card with a note was raised although the session runs without asking:
    // the judge could not answer, or stopped judging. It is the person's alone.
    if (entry.request.note || !autoApproves(entry.request.sessionId)) continue
    pending.delete(id)
    bus.emit({ type: 'approval.resolved', approvalId: id })
    entry.resolve({ answer: 'once' })
    released++
  }
  return released
}

/**
 * Releases whatever is waiting, using the live answer: the conversation's switch
 * (a subagent follows the one it works for), the app-wide default, the sandbox.
 * Called when either switch changes; with nothing pending it does nothing.
 */
export function releasePending(): number {
  return releaseAutoApproved((sessionId) => autoApproving(rawConfig(), sessionId))
}

// The store announces every session change here; listening, rather than being called
// by the store, keeps store -> approvals -> store from becoming an import cycle.
// Only a change of the switch releases anything: a draft typed, a status or a todo
// list updated says nothing about whether this session should stop asking.
const switches = new Map<string, boolean | undefined>()
bus.subscribe((event) => {
  if (event.type !== 'session.updated') return
  const { id, autoApprove } = event.session
  const changed = switches.has(id) && switches.get(id) !== autoApprove
  switches.set(id, autoApprove)
  if (changed) releasePending()
})

/* ---------------- pattern matching ---------------- */

// `ls *` covers a bare `ls` too: models run it without arguments as often as with.
function patternToRegExp(pattern: string): RegExp {
  const bare = pattern.endsWith(' *')
  const body = bare ? pattern.slice(0, -2) : pattern
  const escaped = body.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}${bare ? '(?: .*)?' : ''}$`)
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => patternToRegExp(p.trim()).test(value.trim()))
}

// Redirections that touch no file: into /dev/null, or one stream into another (`2>&1`).
// `>&1x` is not a stream: with a word after `>&`, bash writes that file.
const HARMLESS_REDIRECT = /(?:\d*>>?|&>>?)\s*\/dev\/null(?![\w/.])|\d*>&\d+(?![\w./-])/g

/**
 * The line as the shell parses it, same length, with quoted text blanked.
 * `'…'` and `$'…'` are all data; `"…"` still runs `$(…)` and backquotes, so
 * those stay. A comment is blanked up to its newline, which still separates.
 * `open` says a quote never closed: the shell would read past what is shown.
 */
function scan(command: string): { mask: string; open: boolean } {
  let out = ''
  let quote = ''
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i]
    const next = command[i + 1]
    if (char === '\\' && quote !== "'") {
      out += quote ? '_' : '\\'
      if (next !== undefined) out += '_'
      i += 1
    } else if (!quote) {
      if (char === '$' && next === "'") {
        // ANSI-C quoting: `$'\''` is one quote character, not the end of the string.
        quote = "$'"
        out += "$'"
        i += 1
      } else if (char === '#' && (i === 0 || /[\s;&|()<>]/.test(out[i - 1]))) {
        // Read from the mask: after an escaped space (`\ #`) the `#` is mid-word, not a comment.
        while (i < command.length && command[i] !== '\n') {
          out += '_'
          i += 1
        }
        i -= 1
      } else {
        if (char === "'" || char === '"') quote = char
        out += char
      }
    } else if (char === quote || (quote === "$'" && char === "'")) {
      quote = ''
      out += char
    } else if (quote === '"' && char === '$' && next === '(') {
      out += '$('
      i += 1
    } else {
      out += quote === '"' && char === '`' ? '`' : '_'
    }
  }
  return { mask: out, open: quote !== '' }
}

function unquoted(command: string): string {
  return scan(command).mask
}

/** Whitespace-separated words, a quoted argument staying one word. */
function words(text: string): string[] {
  return [...unquoted(text).matchAll(/\S+/g)].map((m) => text.slice(m.index, m.index + m[0].length))
}

/**
 * Splits a compound shell command so an allowlist entry cannot be smuggled past
 * by chaining. Every segment has to stand on its own.
 *
 * `&` and a bare newline are separators too. Without them, `cat x & rm -rf ~`
 * was one segment that matched `cat *` and went through without asking.
 * Operators inside quotes are text (`grep "a;b"`), and `2>&1` is not a `&`.
 */
export function splitCommand(command: string): string[] {
  const line = command.replace(HARMLESS_REDIRECT, ' ')
  const segments: string[] = []
  let start = 0
  for (const match of unquoted(line).matchAll(/&&|\|\||;|\||&|\r?\n/g)) {
    segments.push(line.slice(start, match.index))
    start = match.index + match[0].length
  }
  segments.push(line.slice(start))
  return segments.map((s) => s.trim()).filter(Boolean)
}

const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
// Words that run the command after them: `env rm …` runs `rm …`.
const WRAPPERS = new Set(['sudo', 'env', 'command', 'builtin', 'exec', 'nohup', 'time', 'nice', 'timeout', 'stdbuf', 'if', 'elif', 'then', 'else', 'while', 'until', 'do', '!'])

/** The command a segment runs once grouping, wrappers, assignments and the program's directory are off. */
// Wrapper flags whose value is the next word: `sudo -u root rm …` runs `rm …`.
const WRAPPER_ARGS: Record<string, string[]> = {
  sudo: ['-u', '-g', '-U', '-C', '-h', '-p', '-r', '-t', '-D', '-T'],
  env: ['-u', '-C', '-S'],
  nice: ['-n'],
  timeout: ['-s', '-k'],
  stdbuf: ['-i', '-o', '-e']
}

function unwrapped(segment: string): string {
  const all = words(segment.replace(/^[\s({]+|[\s)}]+$/g, ''))
  let index = 0
  while (index < all.length) {
    if (WRAPPERS.has(all[index])) {
      const takesValue = WRAPPER_ARGS[all[index]] ?? []
      index += 1
      while (index < all.length && /^(?:-|\d+[smhd]?$)/.test(all[index])) {
        index += takesValue.includes(all[index]) ? 2 : 1
      }
    } else if (/^[A-Za-z_]\w*=/.test(all[index])) {
      index += 1
    } else break
  }
  const rest = all.slice(index)
  if (rest.length > 0) rest[0] = rest[0].replace(/^\\/, '').replace(/^.*\//, '')
  return rest.join(' ')
}

function dequoted(text: string): string {
  return text.trim().replace(/^(['"])([\s\S]*)\1$/, '$2')
}

/** What `$(…)` and backquotes run, where the shell would run them (not inside '…'). */
function substitutions(command: string): string[] {
  const mask = unquoted(command)
  const found: string[] = []
  for (let i = mask.indexOf('$('); i !== -1; i = mask.indexOf('$(', i + 2)) {
    let depth = 0
    let end = i + 1
    for (; end < command.length; end += 1) {
      if (command[end] === '(') depth += 1
      if (command[end] === ')' && --depth === 0) break
    }
    found.push(command.slice(i + 2, end))
  }
  const ticks = [...mask.matchAll(/`/g)].map((m) => m.index)
  for (let t = 0; t + 1 < ticks.length; t += 2) found.push(command.slice(ticks[t] + 1, ticks[t + 1]))
  return found
}

/** Command lines carried inside this one: substitutions, `sh -c '…'`, `eval …`, `find -exec … \;`. */
function innerCommands(command: string): string[] {
  const found = substitutions(command)
  for (const m of command.matchAll(/\s-exec(?:dir)?\s+([\s\S]+?)\s+(?:\\;|';'|";"|\+)/g)) found.push(m[1])
  for (const segment of splitCommand(command)) {
    const [program, ...rest] = words(unwrapped(segment))
    if (program === 'eval') found.push(dequoted(rest.join(' ')))
    const script = SHELLS.has(program) ? rest.findIndex((word) => /^-[a-z]*c$/.test(word)) : -1
    if (script !== -1 && rest[script + 1]) found.push(dequoted(rest[script + 1]))
  }
  return found
}

/**
 * Every command the line would run, a few wrappers deep, for the denylist.
 * ponytail: a tripwire, not a sandbox — `base64 -d | sh`, `python -c` or `xargs` (arguments
 * from stdin) still get past it; a real boundary is the container environment.
 */
function everyCommand(command: string, depth = 0): string[] {
  const segments = splitCommand(command)
  const all = [...segments, ...segments.map(unwrapped)]
  if (depth < 4) for (const inner of innerCommands(command)) all.push(...everyCommand(inner, depth + 1))
  return all
}

/**
 * Whether the command does something the text does not show.
 *
 * An allowlist entry like `echo *` is a statement about what `echo` does. It
 * stops being true the moment the line can run another program inside itself or
 * write over a file: `echo $(rm -rf ~)` and `echo x > ~/.zshrc` both matched
 * that pattern and were approved silently.
 *
 * These are not denied — a person may well want them. They just never skip the
 * prompt, because the prompt is the only place the real effect is visible.
 */
export function hasOpaqueShellSyntax(command: string): boolean {
  const syntax = unquoted(command.replace(HARMLESS_REDIRECT, ' '))
  return (
    syntax.includes('$(') || // command substitution
    syntax.includes('`') || // the older spelling of the same thing
    syntax.includes('>') || // truncates or appends to a file
    syntax.includes('<(') || // process substitution
    syntax.includes('<<') || // heredoc: the payload is not on this line
    scan(command).open // a quote left open: the shell would read on past it
  )
}

// Programs whose path arguments are all written, moved or removed.
const WRITERS = new Set(['mv', 'rm', 'mkdir', 'touch', 'tee', 'truncate', 'chmod', 'chown'])
// Programs that read their first paths and write the last one, or the one after `-t`.
const COPIERS = new Set(['cp', 'ln', 'rsync', 'install'])

function absolute(path: string, home: string): string | null {
  const bare = path.replace(/^['"]|['"]$/g, '')
  if (bare === '~' || bare.startsWith('~/')) return home + bare.slice(1)
  return bare.startsWith('/') ? bare : null
}

/**
 * Absolute paths a command writes outside `cwd`: redirection targets, and the
 * path arguments of programs that write. Relative paths stay inside by
 * definition here; `cd elsewhere && …` is not followed.
 */
export function pathsWrittenOutside(cwd: string, command: string, home: string): string[] {
  const line = command.replace(HARMLESS_REDIRECT, ' ')
  const targets = [...unquoted(line).matchAll(/(?:&>>?|\d?>>?)\s*/g)].map(
    (match) => words(line.slice(match.index + match[0].length))[0] ?? ''
  )
  for (const segment of splitCommand(line)) {
    const [program, ...args] = words(segment)
    const paths = args.filter((arg) => !arg.startsWith('-'))
    if (WRITERS.has(program)) targets.push(...paths)
    const into = args.indexOf('-t')
    if (COPIERS.has(program)) targets.push((into !== -1 ? args[into + 1] : paths.at(-1)) ?? '')
  }
  const inside = (path: string): boolean => path === cwd || path.startsWith(cwd.endsWith('/') ? cwd : `${cwd}/`)
  return targets
    .map((target) => absolute(target, home))
    .filter((path): path is string => path !== null && !path.startsWith('/dev/') && !inside(path))
}

/**
 * Whether a shell command changes files, for the check after edits: models
 * edit with `sed -i`, `tee` or a redirect as often as with the edit tool.
 */
export function changesFiles(command: string): boolean {
  const syntax = unquoted(command.replace(HARMLESS_REDIRECT, ' '))
  if (/(?:^|[^<])>/.test(syntax)) return true
  return splitCommand(command).some((segment) => {
    const [program, ...args] = words(unwrapped(segment))
    if (WRITERS.has(program) || COPIERS.has(program)) return true
    return (program === 'sed' || program === 'perl') && args.some((arg) => /^-[a-zA-Z]*i/.test(arg))
  })
}

// Flags that turn an allowlisted reader (find, rg, git diff/log) into something that runs code or writes files.
const RUNS_OR_WRITES = ['-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint', '-fprint0', '-fprintf', '-fls', '--pre', '--pre-glob', '--output']

export function escalates(segment: string): boolean {
  return segment
    .replace(/['"\\]/g, '')
    .split(/\s+/)
    .some((word) => RUNS_OR_WRITES.some((flag) => word === flag || word.startsWith(`${flag}=`)))
}

/**
 * The segment of a command that the denylist refuses, or null.
 *
 * Shared by the agent's own bash calls and by the run button on a code block:
 * the button needs no approval prompt, since clicking it is the approval, but
 * the denylist is about things that should not run however they were asked for.
 */
export function deniedSegment(permissions: Permissions, command: string): string | null {
  return everyCommand(command).find((segment) => matchesAny(segment, permissions.denylist)) ?? null
}

/**
 * The same permissions, minus the questions.
 *
 * Auto-approve lifts `ask` to `allow` and does nothing else. It is not a
 * blanket "run anything": a tool the user set to `deny` stays denied, and the
 * denylist is checked before any mode is consulted, so a command nobody should
 * ever run still cannot run. What it removes is the prompt, not the policy —
 * which is also why it is a property of one session rather than an edit to the
 * config: a standing policy should not be changed by wanting to be left alone
 * for an afternoon.
 */
export function withoutPrompts(permissions: Permissions): Permissions {
  const lift = (mode: PermissionMode): PermissionMode => (mode === 'ask' ? 'allow' : mode)
  /*
   * Every mode, not a list of them.
   *
   * This used to name the five keys it knew about, so a key added later was
   * silently left asking — and an auto-approving session that hits one waits
   * for an answer from a dialog nobody is looking at, for as long as the turn
   * ceiling allows. That is how `mcp` arrived: the turn simply stopped. A
   * `deny` still denies, which is the whole point of lifting only `ask`.
   */
  const out: Permissions = { ...permissions }
  for (const [key, value] of Object.entries(permissions)) {
    if (value === 'ask' || value === 'allow' || value === 'deny') {
      ;(out as unknown as Record<string, PermissionMode>)[key] = lift(value)
    }
  }
  return out
}

/**
 * Whether this session is running without prompts, asked at the moment of the
 * question rather than once when the turn began.
 *
 * Read live because of what the switch is for: it is turned on *while* a turn
 * sits at a prompt, and a value captured at the start of the turn made the
 * switch look broken — the person clicked it, and the card in front of them
 * went on asking. The same reason applies to the app-wide default: a session
 * that never chose for itself must follow it whenever it changes, not the
 * value the config happened to hold on the day the session was made.
 *
 * The sandbox is the one override that stays: an agent inside a container is
 * being watched on purpose, so the container kind keeps the prompts whatever
 * either switch says.
 */
export function autoApproveNow(
  session: Pick<Session, 'autoApprove'> | undefined,
  config: Pick<AppConfig, 'autoApprove'>,
  container: boolean
): boolean {
  if (container) return false
  return session?.autoApprove ?? config.autoApprove ?? false
}

export interface PermissionDecision {
  mode: PermissionMode
  /** True when an allowlist entry short-circuits the prompt. */
  preapproved: boolean
  /** The denylist pattern that refused it, when that is what happened. */
  deniedBy?: string
}

export function decide(
  permissions: Permissions,
  tool: keyof Omit<Permissions, 'allowlist' | 'denylist'>,
  command?: string
): PermissionDecision {
  const mode = permissions[tool] ?? 'ask'
  if (command) {
    const commands = everyCommand(command)
    const pattern = permissions.denylist.find((entry) => commands.some((each) => matchesAny(each, [entry])))
    if (pattern !== undefined) {
      return { mode: 'deny', preapproved: false, deniedBy: `denylist pattern "${pattern}"` }
    }
    // `cd` only moves where the next command reads; models put `cd <repo> &&` before everything.
    const segments = splitCommand(command)
    if (
      segments.length > 0 &&
      !hasOpaqueShellSyntax(command) &&
      segments.every((s) => /^cd(?:\s|$)/.test(s) || (matchesAny(s, permissions.allowlist) && !escalates(s)))
    ) {
      return { mode, preapproved: true }
    }
  }
  return { mode, preapproved: false }
}
