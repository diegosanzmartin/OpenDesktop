/**
 * The sandbox's flight recorder.
 *
 * While a pentesting container is up, this samples what is happening inside it —
 * every process, every live connection, how many packets the firewall has
 * dropped, and whether the firewall is still the one the app installed — and
 * appends each sample to a per-session log. It runs in the main process, on a
 * timer, with no model in the loop: watching a container is cheap and constant,
 * and paying a language model to poll `docker top` every ten seconds would be
 * neither. The agent comes later, reads the log, and reasons about it.
 *
 * The point is a record that outlives the moment. A reverse shell that lived for
 * one sample, an egress attempt the firewall dropped, a process that ran as root
 * when everything the agent does runs as pentester — none of these leave a trace
 * once the container is gone, and the container is gone the instant the session
 * is deleted. So they are written down as they happen, and the forensic agent
 * has something to find a breach in.
 *
 * It is also, deliberately, on the host. The samples never enter the container,
 * so the tenant whose behaviour is being recorded cannot edit the recording.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { execFile } from 'node:child_process'
import { join } from 'node:path'
import {
  containerName,
  type ForensicFinding,
  type ForensicReport,
  type ForensicSample
} from '@shared/sandbox'
import { DATA_DIR } from './config'
import { getSession } from './store'
import { logLine } from './log'

const FORENSICS_DIR = join(DATA_DIR, 'forensics')

/** How often a running container is sampled. Cheap, so often enough to catch a blip. */
const SAMPLE_MS = 10_000

/**
 * The tools the image ships and the shells and helpers a session legitimately
 * uses. A process whose command is none of these is worth the agent's attention
 * — not proof of a breach, but the thing a breach would look like.
 */
const EXPECTED = new Set([
  'sleep', 'sh', 'bash', 'dash', 'nft', 'ps', 'ss', 'cat', 'find', 'base64', 'grep',
  'nmap', 'httpx', 'ffuf', 'gobuster', 'dirb', 'nuclei', 'sqlmap', 'whatweb', 'nikto',
  'curl', 'wget', 'dig', 'nslookup', 'ping', 'host', 'python3', 'python', 'perl', 'jq',
  'git', 'docker-init', 'tini'
])

interface Recorder {
  sessionId: string
  timer: NodeJS.Timeout
}

const recorders = new Map<string, Recorder>()

function logPath(sessionId: string): string {
  return join(FORENSICS_DIR, `${sessionId}.jsonl`)
}

function docker(args: string[], timeoutMs = 8_000): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('docker', args, { timeout: timeoutMs, maxBuffer: 4_000_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}` })
    })
  })
}

/**
 * Starts recording a session's container. Idempotent — called every time the
 * container is ensured, which is often, so a second call is a no-op.
 */
export function startRecording(sessionId: string): void {
  if (recorders.has(sessionId)) return
  try {
    mkdirSync(FORENSICS_DIR, { recursive: true })
  } catch {
    /* a recorder that cannot write is not a reason to fail a turn */
  }
  const timer = setInterval(() => {
    void sample(sessionId)
  }, SAMPLE_MS)
  // Never hold the process open for a sample; the container going away ends this.
  timer.unref?.()
  recorders.set(sessionId, { sessionId, timer })
  // One immediately, so a short-lived container still leaves a first frame.
  void sample(sessionId)
  logLine('info', `forensics ${sessionId}: recording started`)
}

export function stopRecording(sessionId: string): void {
  const rec = recorders.get(sessionId)
  if (!rec) return
  clearInterval(rec.timer)
  recorders.delete(sessionId)
  logLine('info', `forensics ${sessionId}: recording stopped`)
}

/** Removes a session's forensic log. Called when the session is deleted. */
export function removeForensics(sessionId: string): void {
  stopRecording(sessionId)
  try {
    rmSync(logPath(sessionId), { force: true })
  } catch {
    /* nothing to remove */
  }
}

async function sample(sessionId: string): Promise<void> {
  const name = containerName(sessionId)

  // Processes, with user and full command, straight from the host's view of the
  // container — `docker top` does not run anything inside it.
  const top = await docker(['top', name, '-eo', 'pid,user,comm,args'])
  if (!top.ok) {
    // The container is gone (removed, crashed). Stop rather than poll a corpse.
    stopRecording(sessionId)
    return
  }
  const processes = parseTop(top.out)

  // Connections and the firewall, read as root — the agent (pentester) could not
  // read the ruleset, but the recorder is the app, and the app is admin.
  const conn = await docker(['exec', '--user', 'root', name, 'sh', '-c', 'ss -tunp 2>/dev/null || true'])
  const connections = conn.out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^Netid/.test(l))
    .slice(0, 200)

  const ruleset = await docker(['exec', '--user', 'root', name, 'nft', 'list', 'ruleset'])
  const firewallArmed = ruleset.ok && /policy drop/.test(ruleset.out)
  const drops = firewallArmed ? parseDropCounter(ruleset.out) : 0

  const entry: ForensicSample = {
    t: Date.now(),
    processes,
    connections,
    drops,
    firewallArmed,
    scope: getSession(sessionId)?.sandbox?.targets ?? []
  }
  try {
    appendFileSync(logPath(sessionId), JSON.stringify(entry) + '\n')
  } catch {
    /* the record is a convenience, not a reason to crash the sampler */
  }
}

function parseTop(out: string): ForensicSample['processes'] {
  const lines = out.split('\n').filter(Boolean)
  // The first line is the header docker prints; skip it.
  const rows = lines.slice(1)
  const processes: ForensicSample['processes'] = []
  for (const row of rows) {
    const parts = row.trim().split(/\s+/)
    if (parts.length < 4) continue
    const [pid, user, comm, ...rest] = parts
    processes.push({ pid, user, comm, args: rest.join(' ').slice(0, 300) })
  }
  return processes
}

/** Sums the packet counts on the firewall's drop counter(s). */
function parseDropCounter(ruleset: string): number {
  let total = 0
  // `counter packets N bytes M` — added to the drop rule by buildNftRules.
  const re = /counter packets (\d+) bytes \d+/g
  let m: RegExpExecArray | null
  while ((m = re.exec(ruleset)) !== null) total += Number(m[1]) || 0
  return total
}

/* ---------------- reading it back, for the agent and the panel ---------------- */

/** Reads the log for a session. Empty when there is nothing recorded. */
export function readSamples(sessionId: string): ForensicSample[] {
  try {
    const text = readFileSync(logPath(sessionId), 'utf8')
    return text
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as ForensicSample)
  } catch {
    return []
  }
}

/**
 * The deterministic pass over a session's recording.
 *
 * These are the signals a rule can catch without judgement, so they are caught
 * here rather than spent on a model: a process that is not a known tool, a
 * process running as root, a firewall that stopped being armed, and egress the
 * firewall dropped (with the sharper case of drops while no scope was even
 * open — something tried to phone home before anyone authorised anything). The
 * forensic agent builds on these; it does not have to rediscover them.
 */
export function analyseForensics(sessionId: string): ForensicReport {
  const samples = readSamples(sessionId)
  const findings: ForensicFinding[] = []
  if (samples.length === 0) {
    return { sessionId, samples: 0, findings }
  }

  const unexpected = new Set<string>()
  const rootProcs = new Set<string>()
  let firewallDropped = false
  let maxDrops = 0
  let droppedWithNoScope = false

  for (const s of samples) {
    if (!s.firewallArmed) firewallDropped = true
    maxDrops = Math.max(maxDrops, s.drops)
    if (s.drops > 0 && s.scope.length === 0) droppedWithNoScope = true
    for (const p of s.processes) {
      // The entrypoint's `sleep infinity` runs as root by design; everything
      // else running as root is worth a look.
      if (p.user === 'root' && p.comm !== 'sleep' && p.comm !== 'tini' && p.comm !== 'docker-init') {
        rootProcs.add(`${p.comm} (${p.args})`)
      }
      if (!EXPECTED.has(p.comm)) unexpected.add(`${p.comm} (${p.args})`)
    }
  }

  if (firewallDropped) {
    findings.push({
      severity: 'alert',
      what: 'The egress firewall was not armed in at least one sample — the container may have had open network.'
    })
  }
  if (droppedWithNoScope) {
    findings.push({
      severity: 'alert',
      what: 'Traffic was dropped while no scope was authorised: something tried to reach the network before any target was allowed.'
    })
  } else if (maxDrops > 0) {
    findings.push({
      severity: 'warn',
      what: `The firewall dropped outbound traffic (${maxDrops} packets) — attempts to reach something outside the authorised scope.`
    })
  }
  for (const proc of rootProcs) {
    findings.push({ severity: 'warn', what: `A process ran as root: ${proc}` })
  }
  for (const proc of unexpected) {
    findings.push({ severity: 'info', what: `An unrecognised process ran: ${proc}` })
  }
  if (findings.length === 0) {
    findings.push({ severity: 'info', what: 'Nothing anomalous in the recording: known tools only, firewall armed throughout.' })
  }

  return {
    sessionId,
    samples: samples.length,
    window: { from: samples[0].t, to: samples[samples.length - 1].t },
    findings,
    latest: samples[samples.length - 1]
  }
}

/** Stops every recorder, on quit. */
export function disposeForensics(): void {
  for (const id of [...recorders.keys()]) stopRecording(id)
}
