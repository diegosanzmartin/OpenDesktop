/**
 * Filtered command output: rtk-ai/rtk, used as itself rather than reimplemented.
 *
 * rtk is a single Rust binary that filters the output of about a hundred
 * development commands before an agent reads it — a tree with counts instead of
 * one line per file, failures instead of a whole test run, `ok abc1234` instead
 * of git's progress report. Its README puts the reduction at up to 90% of bash
 * output.
 *
 * The rewrite rules live in rtk's own registry and it exposes them as
 * `rtk rewrite <command>`, which is what its editor plugins call. We call the
 * same thing. That is the whole integration: no table of commands to copy, and
 * nothing to keep in step as rtk grows. Its documented exit codes are the
 * protocol:
 *
 *   0 + stdout  a rewrite, and rtk's own rules are happy with it
 *   1           rtk has no equivalent — run what was asked
 *   2           rtk's deny rules matched — run nothing on its say-so
 *   3 + stdout  a rewrite, but rtk wants a person asked first
 *
 * What we do *not* take from rtk is permission. The user's allowlist is about
 * the command the model asked for, and that is the command shown on the
 * approval card, so that is the command the decision is made about. The rewrite
 * happens afterwards, and `acceptRewrite` below is the narrow gate it has to
 * fit through.
 */
import { deniedSegment, hasOpaqueShellSyntax, splitCommand } from './approvals'
import { shellQuote, type Runtime } from './runtime'
import type { Permissions } from '@shared/types'

/** `rtk rewrite` was added in 0.23.0; older binaries have no protocol at all. */
const MIN_VERSION = [0, 23, 0] as const

export interface RtkStatus {
  /** `unknown` means nobody has looked yet — not that rtk is missing. */
  state: 'ready' | 'missing' | 'too-old' | 'unknown'
  version?: string
  /** Shown to the user as-is when the state is not `ready`. */
  message?: string
}

const statuses = new Map<string, RtkStatus>()
const probes = new Map<string, Promise<RtkStatus>>()

export function cachedRtkStatus(environmentId: string): RtkStatus {
  return statuses.get(environmentId) ?? { state: 'unknown' }
}

export function forgetRtkStatus(environmentId?: string): void {
  if (environmentId) {
    statuses.delete(environmentId)
    probes.delete(environmentId)
    return
  }
  statuses.clear()
  probes.clear()
}

function olderThanMinimum(version: string): boolean {
  const parts = version.split('.').map((n) => Number.parseInt(n, 10))
  for (let i = 0; i < MIN_VERSION.length; i++) {
    const mine = Number.isFinite(parts[i]) ? parts[i] : 0
    if (mine > MIN_VERSION[i]) return false
    if (mine < MIN_VERSION[i]) return true
  }
  return false
}

/** Parses `rtk 0.28.2` — and tolerates anything else by reporting nothing. */
export function parseRtkVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+)/.exec(output.trim())
  return match ? match[1] : null
}

/**
 * Whether rtk can be used on this target, asked once per environment.
 *
 * One probe, cached: the answer cannot change while the app is running unless
 * someone installs rtk, and `forgetRtkStatus` covers that.
 */
export async function rtkStatus(
  environmentId: string,
  runtime: Runtime,
  cwd: string
): Promise<RtkStatus> {
  const known = statuses.get(environmentId)
  if (known) return known
  const running = probes.get(environmentId)
  if (running) return running

  const probe = (async (): Promise<RtkStatus> => {
    let status: RtkStatus
    try {
      const res = await runtime.exec('rtk --version', { cwd, timeoutMs: 15_000 })
      const version = parseRtkVersion(`${res.stdout} ${res.stderr}`)
      if (res.exitCode !== 0 || !version) {
        status = {
          state: 'missing',
          message:
            'rtk is not on the PATH of this execution target. Install it with ' +
            '`brew install rtk`, then reopen this session.'
        }
      } else if (olderThanMinimum(version)) {
        status = {
          state: 'too-old',
          version,
          message: `rtk ${version} is too old to rewrite commands; 0.23.0 or newer is needed.`
        }
      } else {
        status = { state: 'ready', version }
      }
    } catch (err) {
      status = { state: 'missing', message: (err as Error).message }
    }
    statuses.set(environmentId, status)
    probes.delete(environmentId)
    return status
  })()

  probes.set(environmentId, probe)
  return probe
}

export interface Rewrite {
  /** What to run. The original, unless a rewrite was both offered and accepted. */
  command: string
  /** True when `command` is rtk's and not the model's. */
  rewritten: boolean
  /** rtk asked for a person to be consulted: never skip the prompt. */
  forceAsk: boolean
  /** Why a rewrite was not used, when one came back. For the log, not the model. */
  rejected?: string
}

/**
 * The gate a rewrite has to fit through before it runs in place of what the
 * model asked for and the user approved.
 *
 * rtk is a program the user installed, so this is not a defence against rtk.
 * It is a defence against running something the approval card did not show:
 * the card says `git status`, and the only thing that may run instead is
 * `git status` handed to rtk. So each segment either comes back untouched or
 * comes back as the same environment prefix followed by an `rtk` invocation —
 * `LANG=C ls -la` becoming `LANG=C rtk ls -la` is a rewrite; anything that
 * adds a segment, a redirect or a substitution is not.
 */
export function acceptRewrite(original: string, candidate: string): { ok: boolean; reason?: string } {
  const next = candidate.trim()
  if (!next) return { ok: false, reason: 'rtk returned nothing' }
  if (next === original.trim()) return { ok: false, reason: 'unchanged' }
  if (next.length > 8000) return { ok: false, reason: 'implausibly long' }
  if (hasOpaqueShellSyntax(next) && !hasOpaqueShellSyntax(original)) {
    return { ok: false, reason: 'adds shell syntax the model did not ask for' }
  }

  const before = splitCommand(original)
  const after = splitCommand(next)
  if (after.length !== before.length) return { ok: false, reason: 'changes how many commands run' }

  for (let i = 0; i < before.length; i++) {
    if (after[i] === before[i]) continue
    const mine = leadingAssignments(before[i])
    const theirs = leadingAssignments(after[i])
    if (mine.prefix !== theirs.prefix) {
      return { ok: false, reason: 'changes the environment the command runs in' }
    }
    if (!/^rtk(\s|$)/.test(theirs.rest)) return { ok: false, reason: 'is not an rtk command' }
  }

  return { ok: true }
}

/** Splits `NODE_ENV=test CI=1 npm run x` into its assignments and the rest. */
function leadingAssignments(segment: string): { prefix: string; rest: string } {
  const words = segment.trim().split(/\s+/)
  let i = 0
  while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i++
  return { prefix: words.slice(0, i).join(' '), rest: words.slice(i).join(' ') }
}

/**
 * Asks rtk what to run instead, and falls back to the original for every
 * reason there is: rtk missing, rtk declining, rtk erroring, or a rewrite that
 * does not fit through the gate above.
 */
export async function rewriteThroughRtk(input: {
  environmentId: string
  runtime: Runtime
  cwd: string
  command: string
  permissions: Permissions
  signal?: AbortSignal
}): Promise<Rewrite> {
  const unchanged: Rewrite = { command: input.command, rewritten: false, forceAsk: false }

  const status = await rtkStatus(input.environmentId, input.runtime, input.cwd)
  if (status.state !== 'ready') return { ...unchanged, rejected: status.message }

  let res
  try {
    res = await input.runtime.exec(`rtk rewrite ${shellQuote(input.command)}`, {
      cwd: input.cwd,
      timeoutMs: 20_000,
      signal: input.signal
    })
  } catch (err) {
    return { ...unchanged, rejected: (err as Error).message }
  }

  // 1: no rtk equivalent. 2: rtk's own deny rules matched, and it is not this
  // layer's business to refuse — the user's denylist already had its say.
  if (res.exitCode !== 0 && res.exitCode !== 3) return unchanged

  const verdict = acceptRewrite(input.command, res.stdout)
  if (!verdict.ok) return { ...unchanged, rejected: verdict.reason }

  const candidate = res.stdout.trim()
  const denied = deniedSegment(input.permissions, candidate)
  if (denied) return { ...unchanged, rejected: `the rewrite matches the denylist (${denied})` }

  return { command: candidate, rewritten: true, forceAsk: res.exitCode === 3 }
}

/**
 * rtk's own equivalents for the tools that do not go through bash.
 *
 * Upstream this is a known hole: the hook only sees Bash calls, so an agent
 * with first-class read/grep/glob tools bypasses rtk entirely. Here the tools
 * are ours, so they can be routed too — but only the ones whose output is a
 * *listing*. A file's contents are not routed, at any level: `edit` matches an
 * exact string against what `read` returned, and a summary of a file is not the
 * file.
 */
export function rtkListingCommand(
  tool: 'grep' | 'glob' | 'list',
  input: { pattern?: string; path: string; limit?: number }
): string | null {
  if (tool === 'list') return `rtk ls ${shellQuote(input.path)}`
  if (tool === 'grep' && input.pattern) {
    return `rtk grep ${shellQuote(input.pattern)} ${shellQuote(input.path)}`
  }
  if (tool === 'glob' && input.pattern) {
    return `rtk find ${shellQuote(input.pattern)} ${shellQuote(input.path)}`
  }
  return null
}
