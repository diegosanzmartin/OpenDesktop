import type { EnvironmentConfig } from './types'

type Workstation = NonNullable<EnvironmentConfig['workstation']>

/**
 * Parses a `gcloud workstations ssh` command straight from the clipboard, so a
 * workstation can be added by pasting the line the docs or a colleague gave you
 * instead of transcribing five flags by hand.
 */
export function parseGcloudCommand(input: string): Partial<Workstation> | null {
  const text = input.replace(/\\\s*\n/g, ' ').trim()
  if (!/gcloud\s+workstations\s+(ssh|start-tcp-tunnel)/.test(text)) return null

  const flag = (name: string): string | undefined => {
    const match = new RegExp(`--${name}[=\\s]+("[^"]+"|'[^']+'|[^\\s]+)`).exec(text)
    return match?.[1]?.replace(/^["']|["']$/g, '')
  }

  const out: Partial<Workstation> = {}
  const project = flag('project')
  const region = flag('region')
  const cluster = flag('cluster')
  const config = flag('config')
  const user = flag('user')
  if (project) out.project = project
  if (region) out.region = region
  if (cluster) out.cluster = cluster
  if (config) out.config = config
  if (user) out.user = user

  // The workstation is the positional argument: the last token that is neither
  // a flag, a flag value, nor the trailing port of start-tcp-tunnel.
  const tokens = text.split(/\s+/)
  for (let i = tokens.length - 1; i >= 0; i--) {
    const token = tokens[i]
    if (!token || token.startsWith('-') || /^\d+$/.test(token)) continue
    if (['gcloud', 'workstations', 'ssh', 'start-tcp-tunnel'].includes(token)) break
    const previous = tokens[i - 1]
    // Skip a value that belongs to a space-separated flag.
    if (previous?.startsWith('--') && !previous.includes('=')) continue
    out.workstation = token.replace(/^["']|["']$/g, '')
    break
  }

  return Object.keys(out).length > 0 ? out : null
}

/** How the connection is authenticated, derived from what the entry carries. */
type AuthMode = 'agent' | 'key' | 'password'

function authModeOf(env: EnvironmentConfig): AuthMode {
  if (env.ssh?.password) return 'password'
  if (env.ssh?.privateKey) return 'key'
  return 'agent'
}
