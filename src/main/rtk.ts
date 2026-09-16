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
  /**
   * How to invoke it: `rtk` when it is on the PATH, an absolute path when it
   * is the copy this app put there. Nothing else should assume the bare name
   * resolves — the whole point of provisioning into our own directory is that
   * it does not have to.
   */
  bin?: string
}

/**
 * Where this app puts rtk when it provisions one, on any target.
 *
 * Its own directory rather than rtk's default `~/.local/bin`: that one is
 * usually on the user's PATH, and writing an executable into a directory the
 * shell searches is a bigger thing to do to someone's machine than they asked
 * for. Nothing needs it there, because every invocation here is by path.
 */
export const RTK_DIR = '.opendesktop/bin'

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
      /*
       * Two places, one call, and the answer says which: a host provisioned
       * from here has no rtk on its PATH by design, so looking only at the
       * PATH would report it missing every time. The first line is how to
       * invoke it; the rest is its version banner.
       */
      const res = await runtime.exec(
        `if rtk --version >/dev/null 2>&1; then printf 'rtk\\n'; rtk --version; ` +
          `else printf '%s\\n' "$HOME/${RTK_DIR}/rtk"; "$HOME/${RTK_DIR}/rtk" --version; fi`,
        { cwd, timeoutMs: 20_000 }
      )
      const [reported = '', ...banner] = `${res.stdout}`.trim().split('\n')
      const version = parseRtkVersion(`${banner.join(' ')} ${res.stderr}`)
      if (res.exitCode !== 0 || !version) {
        status = {
          state: 'missing',
          message:
            'rtk is not on this execution target. It has to be there to filter anything — it ' +
            'runs the commands itself — but it does not have to be installed by hand: ' +
            'OpenDesktop can put it in your home directory on this host, from the savings menu ' +
            'beside the composer.'
        }
      } else if (olderThanMinimum(version)) {
        status = {
          state: 'too-old',
          version,
          message: `rtk ${version} is too old to rewrite commands; 0.23.0 or newer is needed.`
        }
      } else {
        status = { state: 'ready', version, bin: reported.trim() || 'rtk' }
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

/* ---------------- putting one there ---------------- */

/** rtk's release targets, as its own installer decides them. */
export function releaseTarget(uname: string, machine: string): string | null {
  const os = /darwin/i.test(uname) ? 'darwin' : /linux/i.test(uname) ? 'linux' : null
  const arch = /x86_64|amd64/i.test(machine)
    ? 'x86_64'
    : /arm64|aarch64/i.test(machine)
      ? 'aarch64'
      : null
  if (!os || !arch) return null
  if (os === 'darwin') return `${arch}-apple-darwin`
  return arch === 'x86_64' ? 'x86_64-unknown-linux-musl' : 'aarch64-unknown-linux-gnu'
}

/**
 * The script that fetches rtk onto a target, in rtk's own terms.
 *
 * A transcription of `install.sh` from the rtk repository, with two
 * deliberate differences: it installs into this app's own directory rather
 * than onto the PATH, and it never skips the checksum. Downloading an
 * executable onto somebody's server is the sort of thing that gets done
 * exactly the way upstream documents it or not at all — so the SHA-256 is
 * checked against the release's `checksums.txt`, and an archive containing an
 * absolute path or a `..` is refused rather than extracted.
 *
 * Returned as text rather than run here so it can be read in a test, and in
 * the log, before it is ever sent to a machine.
 */
export function installScript(target: string, dir: string): string {
  const asset = `rtk-${target}.tar.gz`
  return [
    'set -e',
    `dir="$HOME/${dir}"`,
    'tmp=$(mktemp -d)',
    'trap \'rm -rf "$tmp"\' EXIT',
    // The redirect on /releases/latest, which is what upstream prefers: no API
    // call, so no anonymous rate limit to run into.
    'version=$(curl -sI https://github.com/rtk-ai/rtk/releases/latest | ' +
      "grep -i '^location:' | sed -E 's|.*/tag/([^[:space:]]+).*|\\1|' | tr -d '\\r')",
    '[ -n "$version" ] || { echo "could not resolve the latest rtk version" >&2; exit 1; }',
    `curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/$version/${asset}" -o "$tmp/${asset}"`,
    'curl -fsSL "https://github.com/rtk-ai/rtk/releases/download/$version/checksums.txt" -o "$tmp/checksums.txt"',
    `expected=$(grep "[[:space:]]${asset}$" "$tmp/checksums.txt" | awk '{print $1}')`,
    '[ -n "$expected" ] || { echo "no checksum published for this target" >&2; exit 1; }',
    'if command -v sha256sum >/dev/null 2>&1; then',
    `  actual=$(sha256sum "$tmp/${asset}" | awk '{print $1}')`,
    'elif command -v shasum >/dev/null 2>&1; then',
    `  actual=$(shasum -a 256 "$tmp/${asset}" | awk '{print $1}')`,
    'else',
    '  echo "no sha256sum or shasum on this host — refusing to install unverified" >&2; exit 1',
    'fi',
    '[ "$expected" = "$actual" ] || { echo "checksum mismatch — refusing to install" >&2; exit 1; }',
    `tar -tzf "$tmp/${asset}" | grep -qE '^/|(^|/)\\.\\.(/|$)' && ` +
      '{ echo "archive contains unsafe paths — refusing to extract" >&2; exit 1; }',
    `tar -xzf "$tmp/${asset}" -C "$tmp"`,
    'mkdir -p "$dir"',
    'src=$(find "$tmp" -type f -name rtk -perm -u+x | head -n 1)',
    '[ -n "$src" ] || { echo "no rtk binary in the archive" >&2; exit 1; }',
    'mv "$src" "$dir/rtk"',
    'chmod +x "$dir/rtk"',
    '"$dir/rtk" --version'
  ].join('\n')
}

export interface Installed {
  ok: boolean
  version?: string
  /** What happened, for a toast and for the log. */
  message: string
}

/**
 * Fetches rtk onto a target, once, into this app's own directory.
 *
 * Never automatic. rtk has to be on the machine whose commands it filters —
 * it is the thing that runs them — so the binary cannot be avoided; what can
 * be avoided is somebody installing it by hand on every host. That is a
 * download and an executable on someone else's server, so it happens when
 * they ask for it and not a moment before.
 *
 * It needs the host to be able to reach github.com. When it cannot, the error
 * says so rather than being reported as "rtk is missing" a second time.
 */
export async function installRtk(
  environmentId: string,
  runtime: Runtime,
  cwd: string
): Promise<Installed> {
  await runtime.connect()

  const uname = await runtime
    .exec('uname -s && uname -m', { cwd, timeoutMs: 15_000 })
    .catch(() => null)
  const [system = '', machine = ''] = (uname?.stdout ?? '').trim().split('\n')
  const target = releaseTarget(system, machine)
  if (!target) {
    return { ok: false, message: `rtk publishes no build for ${system || '?'} ${machine || '?'}.` }
  }

  const res = await runtime
    .exec(installScript(target, RTK_DIR), { cwd, timeoutMs: 300_000 })
    .catch((err: Error) => ({ stdout: '', stderr: err.message, exitCode: 1, truncated: false }))

  const version = parseRtkVersion(`${res.stdout} ${res.stderr}`)
  forgetRtkStatus(environmentId)

  if (res.exitCode !== 0 || !version) {
    const detail = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ')
    return {
      ok: false,
      message: `rtk could not be installed on this target: ${detail || 'the install produced no version'}`
    }
  }
  return { ok: true, version, message: `rtk ${version} installed for ${target}` }
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
 * Points each `rtk` in a rewrite at the binary we actually have.
 *
 * rtk writes `rtk git status`, which needs `rtk` to be on the PATH when the
 * shell runs it. A copy this app provisioned deliberately is not, so the token
 * is replaced by its path — only at the start of a segment, and only after any
 * environment assignments, which is the one shape `acceptRewrite` allows.
 */
export function invocation(bin: string | undefined): string {
  return !bin || bin === 'rtk' ? 'rtk' : shellQuote(bin)
}

export function useBinary(command: string, bin: string): string {
  if (!bin || bin === 'rtk') return command
  const quoted = shellQuote(bin)
  return command.replace(
    /(^|[;&|]\s*)((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)rtk(\s|$)/g,
    (_match, before: string, assignments: string, after: string) =>
      `${before}${assignments}${quoted}${after}`
  )
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
    res = await input.runtime.exec(`${invocation(status.bin)} rewrite ${shellQuote(input.command)}`, {
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

  /*
   * The gate first, on what rtk wrote — it is the shape `rtk …` that is being
   * allowed. Then the binary is substituted in, and the denylist runs over the
   * result, so what is checked is exactly what runs.
   */
  const verdict = acceptRewrite(input.command, res.stdout)
  if (!verdict.ok) return { ...unchanged, rejected: verdict.reason }

  const candidate = useBinary(res.stdout.trim(), status.bin ?? 'rtk')
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
  input: { pattern?: string; path: string; limit?: number; bin?: string }
): string | null {
  const rtk = invocation(input.bin)
  if (tool === 'list') return `${rtk} ls ${shellQuote(input.path)}`
  if (tool === 'grep' && input.pattern) {
    return `${rtk} grep ${shellQuote(input.pattern)} ${shellQuote(input.path)}`
  }
  if (tool === 'glob' && input.pattern) {
    return `${rtk} find ${shellQuote(input.pattern)} ${shellQuote(input.path)}`
  }
  return null
}
