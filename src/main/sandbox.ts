/**
 * The pentesting sandbox: a throwaway Docker container per session, and the
 * hard gate that keeps it off the network until a human authorises a target.
 *
 * This is the third module of the shape `local-model.ts` established — a
 * supervisor of an external process, with a status published on the bus, a
 * `supported` flag from a one-time preflight, and a disposer wired into
 * `before-quit`. What it supervises is `docker`, not a downloaded binary.
 *
 * The security model, top to bottom:
 *
 *  1. Isolation from the host. Every container runs `--cap-drop ALL`,
 *     `--security-opt no-new-privileges`, with pid/memory/cpu limits and **no
 *     bind mounts of the host**. Files live inside the container and are read
 *     out with `docker exec`/`docker cp`; nothing on the Mac is mounted in.
 *
 *  2. The hard network gate. A container starts with `--network none`: no
 *     egress at all, which is a fact `docker` enforces, not a rule we hope
 *     holds. It stays offline until the session declares a target and a human
 *     confirms in writing that they may test it. Only then does the app connect
 *     it to a per-session bridge and install an nftables allowlist that permits
 *     exactly that target (plus DNS) and drops the rest.
 *
 *  3. The agent is an unprivileged tenant. The app is the container's admin;
 *     the agent is not. The entrypoint (root) owns the firewall, and every
 *     command the agent runs goes through `docker exec --user pentester` — no
 *     caps, no NET_ADMIN — so it cannot alter the rules of its own netns. The
 *     app updates them with `exec --user root` when the scope changes. The
 *     price: without root, nmap's raw scans fall back to TCP connect scans;
 *     everything else works.
 *
 * The container is created lazily on first use (like SSH connects lazily) and
 * removed when the session is deleted.
 */
import { execFile, spawn } from 'node:child_process'
import {
  SANDBOX_IMAGE,
  SANDBOX_TOOLS,
  SANDBOX_USER,
  SANDBOX_WORKDIR,
  containerName,
  networkName,
  normaliseTargets,
  type SandboxScope,
  type SandboxStage,
  type SandboxStatus
} from '@shared/sandbox'
import { bus } from './bus'
import { logLine } from './log'
import { getSession, updateSession } from './store'

/* ---------------- docker, wrapped ---------------- */

/** A DNS resolver the sandbox is allowed to reach once a scope is open. */
const SANDBOX_DNS = '1.1.1.1'

const HARDENING = [
  '--cap-drop',
  'ALL',
  '--security-opt',
  'no-new-privileges',
  '--pids-limit',
  '512',
  '--memory',
  '2g',
  '--cpus',
  '2'
]

interface Run {
  ok: boolean
  stdout: string
  stderr: string
  code: number
}

/**
 * One docker command, collected. Never throws for a non-zero exit — the caller
 * reads `ok`, because "the container is not there" is an answer, not a crash.
 */
function docker(args: string[], input?: string, timeoutMs = 60_000): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      'docker',
      args,
      { timeout: timeoutMs, maxBuffer: 16_000_000 },
      (err, stdout, stderr) => {
        const code = (err as { code?: number } | null)?.code
        resolve({
          ok: !err,
          stdout: stdout ?? '',
          stderr: stderr ?? '',
          code: typeof code === 'number' ? code : err ? 1 : 0
        })
      }
    )
    if (input !== undefined) {
      child.stdin?.end(input)
    }
  })
}

/* ---------------- status ---------------- */

interface State {
  stage: SandboxStage
  supported: boolean
  imageBuilt: boolean
  message?: string
  progress?: { label: string; fraction?: number }
}

const state: State = { stage: 'absent', supported: false, imageBuilt: false }
let preflightDone = false
let building: Promise<SandboxStatus> | null = null

export function sandboxStatus(): SandboxStatus {
  return {
    stage: state.stage,
    supported: state.supported,
    imageBuilt: state.imageBuilt,
    image: SANDBOX_IMAGE,
    tools: SANDBOX_TOOLS,
    progress: state.progress,
    message: state.message
  }
}

let lastEmit = 0
function publish(force = true): void {
  const now = Date.now()
  if (!force && now - lastEmit < 250) return
  lastEmit = now
  bus.emit({ type: 'sandbox.status', status: sandboxStatus() })
}

function fail(message: string): SandboxStatus {
  state.stage = 'failed'
  state.progress = undefined
  state.message = message
  logLine('warn', `sandbox: ${message}`)
  publish()
  return sandboxStatus()
}

/**
 * Whether Docker is usable, and whether the image is already built. Cheap to
 * call; the real work runs once and the answer is cached, because `docker
 * version` and `image inspect` are the kind of thing the settings panel asks on
 * every open.
 */
export async function refreshSandbox(force = false): Promise<SandboxStatus> {
  if (preflightDone && !force) return sandboxStatus()

  const version = await docker(['version', '--format', '{{.Server.Version}}'], undefined, 10_000)
  preflightDone = true
  if (!version.ok) {
    state.supported = false
    state.imageBuilt = false
    // The daemon being down and docker being absent read differently, and the
    // fix differs too, so say which.
    const absent = /not found|ENOENT|command not found/i.test(version.stderr)
    state.stage = 'absent'
    state.message = absent
      ? 'Docker is not installed. The sandbox needs Docker to run each session in a container.'
      : 'Docker is installed but its daemon is not running. Start Docker Desktop and try again.'
    publish()
    return sandboxStatus()
  }

  state.supported = true
  const image = await docker(['image', 'inspect', SANDBOX_IMAGE], undefined, 15_000)
  state.imageBuilt = image.ok
  state.stage = image.ok ? 'ready' : 'absent'
  state.message = image.ok
    ? undefined
    : 'The sandbox image is not built yet. Build it once before starting a pentesting session.'
  publish()
  return sandboxStatus()
}

/* ---------------- lifecycle, keyed by session ---------------- */

/** Sessions whose container has been created this run, so we do not re-create it. */
const created = new Set<string>()
const starting = new Map<string, Promise<void>>()

/**
 * Ensures the session's container exists and is running, offline. Idempotent and
 * de-duplicated: two tool calls landing at once share one create.
 */
export async function ensureContainer(sessionId: string): Promise<void> {
  const inFlight = starting.get(sessionId)
  if (inFlight) return inFlight
  const work = createContainer(sessionId).finally(() => starting.delete(sessionId))
  starting.set(sessionId, work)
  return work
}

async function createContainer(sessionId: string): Promise<void> {
  await refreshSandbox()
  if (!state.supported) throw new Error(sandboxStatus().message ?? 'Docker is not available.')
  if (!state.imageBuilt) {
    throw new Error('The sandbox image is not built yet. Build it in Settings before running a session.')
  }

  const name = containerName(sessionId)

  // Already up from earlier in this run? Nothing to do.
  const running = await docker(['ps', '-q', '-f', `name=^${name}$`], undefined, 10_000)
  if (running.ok && running.stdout.trim()) {
    created.add(sessionId)
    return
  }
  // A stopped leftover with the same name would block `run`; clear it.
  await docker(['rm', '-f', name], undefined, 20_000)

  /*
   * The container is attached to a per-session bridge from the start, and the
   * offline guarantee is the firewall, not a missing interface.
   *
   * This is not the first design: `--network none` plus `docker network connect`
   * on authorisation is what it looked like, and Docker refuses it —
   * "container cannot be connected to multiple networks with one of the networks
   * in private (none) mode". So the network is always there and the entrypoint
   * installs a default-drop OUTPUT firewall at boot; nothing gets out until a
   * scope adds an allow rule. Proven by hand: on a fresh bridge with the drop
   * policy in place, curl to any address times out until its address is allowed.
   */
  const net = networkName(sessionId)
  await docker(['network', 'create', net], undefined, 20_000)

  const args = [
    'run',
    '-d',
    '--name',
    name,
    '--hostname',
    'sandbox',
    '--network',
    net,
    ...HARDENING,
    // The entrypoint needs NET_ADMIN to install the firewall; the agent never
    // gets it, because its commands run as --user pentester. Root inside a
    // container that is capless but for NET_ADMIN, no-new-privileges and with
    // nothing of the host mounted is not root on the host.
    '--cap-add',
    'NET_ADMIN',
    '--cap-add',
    'NET_RAW',
    '-w',
    SANDBOX_WORKDIR,
    SANDBOX_IMAGE
  ]
  const run = await docker(args, undefined, 60_000)
  if (!run.ok) {
    throw new Error(`could not start the sandbox container: ${run.stderr.trim().slice(0, 200)}`)
  }

  /*
   * Fail closed. The whole safety story rests on that default-drop firewall
   * being in place, so confirm it is before letting anything run — poll for the
   * drop policy the entrypoint installs. If it never appears (nft could not
   * load), the container is stopped and the session refuses to start rather than
   * running with a door open.
   */
  const armed = await waitForFirewall(name)
  if (!armed) {
    await docker(['rm', '-f', name], undefined, 20_000)
    await docker(['network', 'rm', net], undefined, 20_000)
    throw new Error(
      'The sandbox firewall did not come up, so the container was stopped rather than run with open egress.'
    )
  }

  created.add(sessionId)
  logLine('info', `sandbox ${sessionId}: container up, offline (default-drop firewall armed)`)
}

/** Polls for the entrypoint's default-drop policy. The proof the gate is closed. */
async function waitForFirewall(name: string): Promise<boolean> {
  for (let i = 0; i < 20; i++) {
    const res = await docker(['exec', '--user', 'root', name, 'nft', 'list', 'ruleset'], undefined, 8_000)
    if (res.ok && /policy drop/.test(res.stdout)) return true
    await new Promise((r) => setTimeout(r, 250))
  }
  return false
}

/** The `docker exec` prefix for an agent command: unprivileged, in the workdir. */
export function agentExecPrefix(sessionId: string): string[] {
  return ['exec', '--user', SANDBOX_USER, '-w', SANDBOX_WORKDIR, containerName(sessionId)]
}

/* ---------------- the hard network gate ---------------- */

/**
 * Opens egress to exactly the declared targets, and records the authorisation.
 *
 * Everything an agent could touch is decided here and nowhere else. The order
 * matters: rules first, connectivity second, so there is never a window in which
 * the container is on the network with no firewall. The firewall is installed by
 * root inside the container; the agent, running as pentester, cannot undo it.
 */
export async function openScope(
  sessionId: string,
  targets: string[],
  note: string
): Promise<{ error?: string; scope?: SandboxScope }> {
  const session = getSession(sessionId)
  if (!session) return { error: 'no such session' }

  const clean = normaliseTargets(targets)
  if (clean.length === 0) {
    return { error: 'No valid target. Give a hostname, an IPv4 address or a CIDR.' }
  }
  if (!note.trim()) {
    return { error: 'Say, in writing, that you are authorised to test these targets.' }
  }

  await ensureContainer(sessionId)
  const name = containerName(sessionId)

  // The network is already attached; opening a scope is only a firewall rewrite.
  // The allowlist is applied by root inside the container's own netns — the
  // agent, as pentester, has no NET_ADMIN and cannot change it.
  const rules = buildNftRules(clean)
  const install = await docker(
    ['exec', '--user', 'root', '-i', name, 'sh', '-c', 'nft -f -'],
    rules,
    20_000
  )
  if (!install.ok) {
    return { error: `could not open the scope: ${install.stderr.trim().slice(0, 200)}` }
  }

  const scope: SandboxScope = {
    targets: clean,
    authorizedAt: Date.now(),
    authorizedNote: note.trim().slice(0, 500)
  }
  updateSession(sessionId, { sandbox: scope })
  logLine('info', `sandbox ${sessionId}: scope opened to ${clean.join(', ')}`)
  return { scope }
}

/** Puts the container back offline by resetting the firewall to default-drop. */
export async function closeScope(sessionId: string): Promise<void> {
  const name = containerName(sessionId)
  // Back to drop-everything. The network stays attached; the firewall is the
  // gate, so a default-drop ruleset is what "offline" means here.
  await docker(['exec', '--user', 'root', '-i', name, 'sh', '-c', 'nft -f -'], buildNftRules([]), 20_000)
  if (getSession(sessionId)) updateSession(sessionId, { sandbox: undefined })
  logLine('info', `sandbox ${sessionId}: scope closed, back to default-drop`)
}

/**
 * The nftables ruleset for a scope: drop everything outbound except DNS to our
 * resolver and new/related traffic to the declared targets. Built as text and
 * piped to `nft -f -`, so the whole set is applied atomically.
 */
export function buildNftRules(targets: string[]): string {
  const hosts = targets.filter((t) => !t.includes('/'))
  const nets = targets.filter((t) => t.includes('/'))
  const lines = [
    'flush ruleset',
    'table inet filter {',
    '  chain output {',
    '    type filter hook output priority 0; policy drop;',
    '    ct state established,related accept',
    '    oifname "lo" accept'
  ]
  // DNS only when there is a target to resolve; an empty scope is fully offline.
  if (targets.length > 0) {
    lines.push(`    ip daddr ${SANDBOX_DNS} udp dport 53 accept`)
    lines.push(`    ip daddr ${SANDBOX_DNS} tcp dport 53 accept`)
  }
  if (hosts.length > 0) lines.push(`    ip daddr { ${hosts.join(', ')} } accept`)
  for (const cidr of nets) lines.push(`    ip daddr ${cidr} accept`)
  lines.push('  }', '}')
  return lines.join('\n') + '\n'
}

/* ---------------- teardown ---------------- */

/** Removes the session's container and network. Called when a session is deleted. */
export async function removeContainer(sessionId: string): Promise<void> {
  if (!created.has(sessionId)) {
    // Might still exist from a previous run; try anyway, quietly.
  }
  const name = containerName(sessionId)
  const net = networkName(sessionId)
  await docker(['rm', '-f', name], undefined, 30_000)
  await docker(['network', 'rm', net], undefined, 20_000)
  created.delete(sessionId)
}

/**
 * Builds the image from build/pentest, streaming progress to the bus.
 *
 * De-duplicated behind one promise, like the local model's install: two clicks
 * do not start two builds. `contextDir` is passed in by the caller because only
 * the main entry knows where the app's resources landed.
 */
export function buildImage(contextDir: string): Promise<SandboxStatus> {
  if (building) return building
  building = runBuild(contextDir).finally(() => {
    building = null
  })
  return building
}

async function runBuild(contextDir: string): Promise<SandboxStatus> {
  await refreshSandbox(true)
  if (!state.supported) return fail(sandboxStatus().message ?? 'Docker is not available.')

  state.stage = 'building'
  state.message = undefined
  state.progress = { label: 'Starting the build…' }
  publish()

  return new Promise<SandboxStatus>((resolve) => {
    const child = spawn(
      'docker',
      ['build', '-t', SANDBOX_IMAGE, '-f', `${contextDir}/Dockerfile`, contextDir],
      { env: { ...process.env, DOCKER_BUILDKIT: '1' } }
    )
    let tail = ''
    const onData = (buf: Buffer): void => {
      const text = buf.toString('utf8')
      tail = (tail + text).slice(-4000)
      const line = text.trim().split('\n').filter(Boolean).pop()
      if (line) {
        state.progress = { label: line.replace(/^#\d+\s*/, '').slice(0, 120) }
        publish(false)
      }
    }
    child.stdout.on('data', onData)
    child.stderr.on('data', onData)
    child.on('error', (err) => resolve(fail(`could not run docker build: ${err.message}`)))
    child.on('close', (code) => {
      if (code === 0) {
        state.stage = 'ready'
        state.imageBuilt = true
        state.progress = undefined
        state.message = undefined
        logLine('info', 'sandbox: image built')
        publish()
        resolve(sandboxStatus())
      } else {
        resolve(fail(`docker build failed (exit ${code}): ${tail.trim().split('\n').slice(-2).join(' ')}`))
      }
    })
  })
}

/**
 * Removes every container and network this app made, on quit. Best-effort and
 * bounded: a container that will not die is not worth hanging the shutdown over.
 */
export async function disposeSandbox(): Promise<void> {
  const ids = [...created]
  created.clear()
  await Promise.all(
    ids.map((id) =>
      Promise.race([removeContainer(id), new Promise((r) => setTimeout(r, 5_000))]).catch(
        () => undefined
      )
    )
  )
}
