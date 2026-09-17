import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import type {
  AgentConfig,
  AppConfig,
  EnvironmentConfig,
  Permissions,
  ProviderConfig
} from '@shared/types'
import { rememberSecret } from '@shared/errors'
import { PROVIDER_PRESETS } from '@shared/catalog'

/**
 * Everything the app stores lives under one root, and the root is overridable.
 *
 * Without that, anything that exercises the real config and store — the
 * headless test above all — writes to the config of whoever is running it.
 * That is not a hypothetical: the smoke test resets the config when it
 * finishes, which quietly replaced a real machine's providers and hosts with
 * the defaults every time it ran.
 */
const ROOT = process.env.OPENDESKTOP_HOME

export const CONFIG_DIR = ROOT ? join(ROOT, 'config') : join(homedir(), '.config', 'opendesktop')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
export const DATA_DIR = ROOT ? join(ROOT, 'data') : join(homedir(), '.local', 'share', 'opendesktop')

/**
 * Removals nobody ever means, as patterns.
 *
 * This list used to be one entry, `rm -rf /*`, and the patterns are globs — so
 * it refused every `rm -rf` with an absolute path in it, `/tmp/build` included.
 * Agents met it as "Not permitted by configuration", could not tell a policy
 * from a broken tool, and left their scratch directories and a `node_modules`
 * behind in the repository. What it was written to stop is the root, the system
 * directories and the home directory; a path inside the project is what the
 * approval prompt is for.
 */
const CATASTROPHIC = [
  'rm -rf /',
  // A single character after the slash: `/*` as the shell wrote it, and `/x`.
  'rm -rf /?',
  'rm -rf /Users*',
  'rm -rf /System*',
  'rm -rf /Library*',
  'rm -rf /Applications*',
  'rm -rf /etc*',
  'rm -rf /usr*',
  'rm -rf /var*',
  'rm -rf /bin*',
  'rm -rf /sbin*',
  'rm -rf /opt*',
  'rm -rf ~*',
  'rm -rf $HOME*'
]

const DEFAULT_PERMISSIONS: Permissions = {
  bash: 'ask',
  edit: 'ask',
  write: 'ask',
  read: 'allow',
  fetch: 'ask',
  allowlist: [
    'ls *',
    'cat *',
    'head *',
    'tail *',
    'pwd',
    'git status*',
    'git diff*',
    'git log*',
    'grep *',
    'rg *',
    'find *',
    'wc *',
    'which *',
    'echo *'
  ],
  denylist: [...CATASTROPHIC, ':(){*', 'mkfs*', 'dd if=*of=/dev/*', 'shutdown*', 'reboot*']
}

const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  /*
   * Anthropic ships declared, from the catalogue the settings page adds providers
   * from — one list of what this app knows about a provider, rather than a copy
   * here and another there to drift apart.
   */
  anthropic: {
    id: 'anthropic',
    npm: '@ai-sdk/anthropic',
    name: 'Anthropic',
    options: { apiKey: '{secret:anthropic}' },
    models: PROVIDER_PRESETS.find((preset) => preset.id === 'anthropic')?.models ?? {}
  },
  helmcode: {
    id: 'helmcode',
    npm: '@ai-sdk/openai-compatible',
    name: 'Helmcode',
    options: {
      baseURL: 'https://api.helmcode.com/v1',
      apiKey: '{env:HELMCODE_API_KEY}'
    },
    models: {
      'glm5.3-flash': {
        id: 'glm5.3-flash',
        name: 'GLM 5.3 Flash',
        contextWindow: 200000,
        toolCall: true,
        vision: true
      }
    }
  }
}

const DEFAULT_ENVIRONMENTS: Record<string, EnvironmentConfig> = {
  local: { id: 'local', name: 'Local', kind: 'local', cwd: homedir() }
}

export function defaultConfig(): AppConfig {
  return {
    $schema: 'https://opendesktop.dev/config.json',
    model: 'helmcode/glm5.3-flash',
    provider: DEFAULT_PROVIDERS,
    environment: DEFAULT_ENVIRONMENTS,
    agent: {},
    permissions: DEFAULT_PERMISSIONS,
    maxSteps: 60,
    maxConcurrentTasks: 2,
    maxParallelSubagents: 4,
    maxTurnTokens: 750_000,
    maxTurnMs: 1_800_000,
    savings: { rtk: false, shunt: false },
    autoApprove: false,
    shuntMinLines: 350,
    dehydrateAtFraction: 0.5,
    compactAtFraction: 0.7,
    keepRecentMessages: 8,
    dehydrateAfterTurns: 2,
    dehydrateOverChars: 800,
    smoothStreamMs: 10,
    theme: 'dark'
  }
}

/**
 * Reads a stored secret by name. Injected by the secrets module so that config
 * loading has no dependency on electron, which keeps it testable under plain node.
 */
let secretResolver: (name: string) => string | undefined = () => undefined

export function setSecretResolver(fn: (name: string) => string | undefined): void {
  secretResolver = fn
}

/** Expands `{env:VAR}`, `{file:/path}` and `{secret:NAME}` placeholders. */
export function expandPlaceholders(value: string): string {
  return value
    .replace(/\{secret:([A-Za-z0-9_.-]+)\}/g, (_m, name: string) => secretResolver(name) ?? '')
    .replace(/\{env:([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name: string) => process.env[name] ?? '')
    .replace(/\{file:([^}]+)\}/g, (_m, p: string) => {
      const target = p.startsWith('~') ? join(homedir(), p.slice(1)) : p
      try {
        return readFileSync(target, 'utf8').trim()
      } catch {
        return ''
      }
    })
}

/**
 * Config keys whose value is a credential, whatever the value looks like.
 *
 * What is expanded under one of these is remembered, so it can be recognised
 * and redacted later: the same key reaches a shell command's environment, and a
 * command's output is not somewhere a key can be predicted by shape.
 */
const CREDENTIAL_KEY = /key|token|secret|password|passphrase|credential/i

function expandDeep<T>(value: T, key?: string): T {
  if (typeof value === 'string') {
    const expanded = expandPlaceholders(value)
    if (key && CREDENTIAL_KEY.test(key)) rememberSecret(expanded)
    return expanded as unknown as T
  }
  if (Array.isArray(value)) return value.map((entry) => expandDeep(entry, key)) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandDeep(v, k)
    return out as T
  }
  return value
}

/**
 * Replaces the over-broad `rm -rf /*` entry every config written before this
 * carries, since it was shipped as a default rather than typed on purpose.
 *
 * Anything else in the list is left exactly as it is: a denylist is a standing
 * instruction, and rewriting one somebody wrote would be a worse bug than the
 * one this fixes.
 */
function upgradeDenylist(permissions: Permissions): Permissions {
  const legacy = permissions.denylist.indexOf('rm -rf /*')
  if (legacy === -1) return permissions
  const rest = permissions.denylist.filter((entry) => entry !== 'rm -rf /*')
  return {
    ...permissions,
    denylist: [...CATASTROPHIC.filter((entry) => !rest.includes(entry)), ...rest]
  }
}

/**
 * Normalizes a user-authored config (opencode-compatible shape) into an AppConfig.
 * Keys become ids, so `provider.helmcode.models["glm5.3-flash"]` needs no explicit id.
 */
export function normalizeConfig(raw: Record<string, unknown>): AppConfig {
  const base = defaultConfig()
  const merged: AppConfig = {
    ...base,
    ...(raw as Partial<AppConfig>),
    permissions: upgradeDenylist({
      ...base.permissions,
      ...((raw.permissions as Partial<Permissions>) ?? {})
    }),
    // Only ever true when it says true: a config is hand-editable, and
    // "yes" or 1 must not be what turns the prompts off.
    autoApprove: raw.autoApprove === true,
    // Only the two switches this app has, and only as booleans: a config is
    // hand-editable, and `"rtk": "yes"` should not switch anything on.
    savings: {
      rtk: raw.savings ? (raw.savings as Record<string, unknown>).rtk === true : base.savings?.rtk,
      shunt: raw.savings
        ? (raw.savings as Record<string, unknown>).shunt === true
        : base.savings?.shunt
    },
    provider: {},
    environment: {},
    agent: {}
  }

  const rawProviders = (raw.provider as Record<string, Partial<ProviderConfig>>) ?? base.provider
  for (const [id, p] of Object.entries(rawProviders)) {
    const models: Record<string, ProviderConfig['models'][string]> = {}
    for (const [mid, m] of Object.entries(p.models ?? {})) {
      models[mid] = { ...m, id: mid, name: m?.name ?? mid }
    }
    merged.provider[id] = {
      // Everything the config said, then the fields this shape guarantees.
      // Rebuilding a provider from a fixed list of keys silently dropped
      // anything added since it was written — which is how a spend limit
      // declared on a key disappeared on the first load, leaving the models
      // that were supposed to share it with no limit at all.
      ...p,
      id,
      npm: p.npm ?? '@ai-sdk/openai-compatible',
      name: p.name ?? id,
      options: p.options ?? {},
      models
    }
  }

  const rawEnvs = (raw.environment as Record<string, Partial<EnvironmentConfig>>) ?? base.environment
  for (const [id, e] of Object.entries(rawEnvs)) {
    merged.environment[id] = {
      id,
      name: e.name ?? id,
      kind: e.kind ?? (e.workstation ? 'gcp-workstation' : e.ssh ? 'ssh' : 'local'),
      cwd: e.cwd,
      ssh: e.ssh,
      workstation: e.workstation
    }
  }
  if (!merged.environment.local) merged.environment.local = DEFAULT_ENVIRONMENTS.local

  // Agents are files on disk now, not part of this document. The loader fills
  // them in; normalizeConfig is also used by tests with no agent directory, so
  // a caller-supplied set is still honoured.
  const rawAgents = (raw.agent as Record<string, Partial<AgentConfig>> | undefined) ?? {}
  for (const [id, a] of Object.entries(rawAgents)) {
    merged.agent[id] = {
      id,
      name: a.name ?? id,
      description: a.description ?? '',
      mode: a.mode ?? 'all',
      model: a.model,
      prompt: a.prompt,
      temperature: a.temperature,
      tools: a.tools,
      permissions: a.permissions,
      color: a.color
    }
  }

  return merged
}

/** Injected by the agent store so config loading keeps no import cycle. */
let agentLoader: (() => Record<string, AgentConfig>) | null = null

export function setAgentLoader(fn: () => Record<string, AgentConfig>): void {
  agentLoader = fn
}

let cached: AppConfig | null = null

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    const fresh = defaultConfig()
    // Written the same way saveConfig writes it: agents live in their own
    // files, so the document must not carry an `agent` key even an empty one.
    const { agent: _agent, ...document } = fresh
    writeFileSync(CONFIG_PATH, JSON.stringify(document, null, 2), 'utf8')
    cached = fresh
    // ...and the agents still have to be merged in. Returning early without
    // this gave the first load of a fresh install no agents at all, which is
    // the roster the manager is told it can delegate to.
    if (agentLoader) cached.agent = agentLoader()
    return cached
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
    cached = normalizeConfig(raw)
  } catch (err) {
    cached = defaultConfig()
    cached.$schema = `invalid config at ${CONFIG_PATH}: ${(err as Error).message}`
  }
  if (agentLoader) cached.agent = agentLoader()
  return cached
}

/**
 * The config with secrets resolved. Never send this to the renderer.
 *
 * Only the two subtrees that are documented to take placeholders are expanded:
 * a provider's options and an environment's connection settings. Expanding the
 * whole document also expanded agent prompts — and an agent is a file, which
 * can be imported from elsewhere. One containing `{secret:helmcode}` in its
 * prompt had the real key substituted in and could simply print it.
 */
export function resolvedConfig(): AppConfig {
  const config = loadConfig()
  return {
    ...config,
    provider: expandDeep(config.provider),
    environment: expandDeep(config.environment)
  }
}

/** The config as written on disk, placeholders intact. Safe for the renderer. */
export function rawConfig(): AppConfig {
  return loadConfig()
}

export function saveConfig(next: AppConfig): AppConfig {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  // Agents are not written here; they have their own files.
  const { agent: _agent, ...document } = next
  writeFileSync(CONFIG_PATH, JSON.stringify(document, null, 2), 'utf8')
  cached = normalizeConfig(document as unknown as Record<string, unknown>)
  if (agentLoader) cached.agent = agentLoader()
  return cached
}

export function readConfigText(): string {
  loadConfig()
  return readFileSync(CONFIG_PATH, 'utf8')
}

export function writeConfigText(text: string): AppConfig {
  const parsed = JSON.parse(text) as Record<string, unknown>
  const normalized = normalizeConfig(parsed)
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, text, 'utf8')
  cached = normalized
  if (agentLoader) cached.agent = agentLoader()
  return cached
}

export function effectivePermissions(config: AppConfig, agentId: string): Permissions {
  const agent = config.agent[agentId]
  return { ...config.permissions, ...(agent?.permissions ?? {}) }
}
