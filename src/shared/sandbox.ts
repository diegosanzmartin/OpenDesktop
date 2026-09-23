/**
 * The contract for the pentesting sandbox, shared by main and renderer.
 *
 * Pure: no Node imports, so the renderer can hold the same types and helpers the
 * main process builds. The sandbox is a new environment kind — `container` — so
 * a pentesting session is "a session that runs inside a throwaway Docker
 * container", and everything the app already does over an environment (tools,
 * Files, Changes, hooks, workspaces, the editor) works over it unchanged.
 *
 * The security model lives in `src/main/sandbox.ts`; this file only carries the
 * shapes and the small decisions that both sides must agree on — the image name,
 * what a target is allowed to look like, and how a container and network are
 * named after a session.
 */

/**
 * The image is built locally from `build/pentest/Dockerfile`, not pulled. The
 * tag is ours; the base image inside the Dockerfile is what is pinned by digest,
 * because that is the thing coming from a registry we do not control.
 */
export const SANDBOX_IMAGE = 'opendesktop/pentest:1'

/** The unprivileged user the agent's commands run as. Root is the app's alone. */
export const SANDBOX_USER = 'pentester'

/** Where work, loot and evidence live inside the container. */
export const SANDBOX_WORKDIR = '/work'

/**
 * The security tools baked into the image, named here so the settings panel can
 * say what a session can reach for without shelling into a container to look.
 * The Dockerfile is the source of truth; this list is what it installs.
 */
export const SANDBOX_TOOLS: { name: string; blurb: string }[] = [
  { name: 'nmap', blurb: 'Port and service discovery' },
  { name: 'httpx', blurb: 'Fast HTTP probing' },
  { name: 'ffuf', blurb: 'Content and parameter fuzzing' },
  { name: 'gobuster', blurb: 'Directory and DNS brute force' },
  { name: 'nuclei', blurb: 'Templated vulnerability scanning' },
  { name: 'sqlmap', blurb: 'SQL injection' },
  { name: 'whatweb', blurb: 'Web technology fingerprinting' },
  { name: 'nikto', blurb: 'Web server checks' },
  { name: 'curl', blurb: 'The obvious one' },
  { name: 'wordlists', blurb: 'dirb lists under /usr/share/dirb/wordlists' }
]

export type SandboxStage = 'absent' | 'building' | 'ready' | 'failed'

export interface SandboxProgress {
  /** A line from `docker build`, trimmed, for the row while it runs. */
  label: string
  /** 0..1 when it can be estimated from the build steps, else omitted. */
  fraction?: number
}

export interface SandboxStatus {
  stage: SandboxStage
  /** False when Docker is not installed or its daemon is not reachable. */
  supported: boolean
  /** Whether the image is built and ready to run a session. */
  imageBuilt: boolean
  image: string
  tools: { name: string; blurb: string }[]
  progress?: SandboxProgress
  /** What happened, for the row and for the log. Also the "why not" for supported=false. */
  message?: string
}

/**
 * What a session is allowed to reach, and the record that it was allowed.
 *
 * `targets` is empty until the person declares one, which is the whole point:
 * an empty scope means the container has no network at all. `authorizedNote` is
 * what they typed to confirm they may test it — kept so the report and the log
 * can show that a human said so, and when.
 */
export interface SandboxScope {
  targets: string[]
  authorizedAt?: number
  authorizedNote?: string
}

/** A container is named after its session, so a stray one names the chat that left it. */
export function containerName(sessionId: string): string {
  return `opendesktop-sbx-${sanitiseId(sessionId)}`
}

/** Its network, likewise. One user-defined bridge per session, torn down with it. */
export function networkName(sessionId: string): string {
  return `opendesktop-sbx-${sanitiseId(sessionId)}`
}

/** Session ids are nanoid, but docker names are stricter; keep it defensive. */
function sanitiseId(sessionId: string): string {
  return sessionId.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 48) || 'unknown'
}

/**
 * Whether a string is something we will let through the scope gate.
 *
 * A hostname, an IPv4 address, or an IPv4 CIDR. Deliberately strict: this string
 * becomes a firewall rule and a tool argument, so anything with a space, a shell
 * metacharacter or a scheme is refused rather than sanitised. No URLs — a target
 * is a host, not a page.
 */
export function isValidTarget(raw: string): boolean {
  const target = raw.trim()
  if (target.length === 0 || target.length > 255) return false
  if (/[^A-Za-z0-9_.:/-]/.test(target)) return false

  const cidr = target.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/)
  if (cidr) {
    return isIpv4(cidr[1]) && Number(cidr[2]) >= 0 && Number(cidr[2]) <= 32
  }
  if (isIpv4(target)) return true
  // A dotted-numeric string that is not a valid IPv4 is a mistyped address, not
  // a hostname — 999.1.1.1 must not sneak through the hostname pattern below.
  if (/^\d+(\.\d+)+$/.test(target)) return false
  // A hostname: labels of letters, digits and hyphens, dots between them.
  return /^(?=.{1,253}$)([A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)(\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/.test(
    target
  )
}

function isIpv4(value: string): boolean {
  const parts = value.split('.')
  return parts.length === 4 && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)
}

/**
 * The targets that survive validation, trimmed and de-duplicated. Whatever does
 * not pass is dropped here rather than reaching a firewall rule, and the caller
 * compares lengths to tell the person which ones it refused.
 */
export function normaliseTargets(raw: string[]): string[] {
  const seen = new Set<string>()
  for (const entry of raw) {
    const target = entry.trim()
    if (isValidTarget(target)) seen.add(target)
  }
  return [...seen]
}
