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

export const CONFIG_DIR = join(homedir(), '.config', 'opendesktop')
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json')
export const DATA_DIR = join(homedir(), '.local', 'share', 'opendesktop')

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
  denylist: ['rm -rf /*', ':(){*', 'mkfs*', 'dd if=*of=/dev/*', 'shutdown*', 'reboot*']
}

const BUILD_PROMPT = `You are a senior software engineer working inside OpenDesktop.
Work directly in the user's project: read files before editing them, make the smallest
correct change, and verify with the project's own tooling when it exists.
Prefer the grep/glob tools over shelling out to find. Keep bash commands short and
single-purpose so each one reads clearly as its own step.
Answer in English.`

const PLAN_PROMPT = `You are a software architect working inside OpenDesktop.
Investigate the codebase read-only and produce a concrete implementation plan:
the files to touch, the order of the work, and the trade-offs you rejected.
You must not modify, create or delete files. Answer in English.`

const REVIEW_PROMPT = `You are a meticulous code reviewer working inside OpenDesktop.
Review the pending changes for correctness bugs first, then for reuse and simplification.
Report each finding with the file, the line and a concrete failure scenario.
You must not modify files. Answer in English.`

const EXPLORE_PROMPT = `You are a read-only research agent. Locate the relevant code and
report a tight summary with file:line references. Do not modify anything. Answer in English.`

const DEFAULT_AGENTS: Record<string, AgentConfig> = {
  build: {
    id: 'build',
    name: 'Build',
    description: 'Full-access agent that reads, writes and runs commands.',
    mode: 'primary',
    prompt: BUILD_PROMPT,
    color: '#d97757'
  },
  plan: {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only architect that designs the change before any code is written.',
    mode: 'primary',
    prompt: PLAN_PROMPT,
    tools: { write: false, edit: false, bash: true },
    permissions: { write: 'deny', edit: 'deny' },
    color: '#6a9bcc'
  },
  review: {
    id: 'review',
    name: 'Review',
    description: 'Read-only reviewer that hunts correctness bugs in the current diff.',
    mode: 'all',
    prompt: REVIEW_PROMPT,
    tools: { write: false, edit: false },
    permissions: { write: 'deny', edit: 'deny' },
    color: '#b08cc4'
  },
  explore: {
    id: 'explore',
    name: 'Explore',
    description: 'Fast read-only search agent for locating code across many files.',
    mode: 'subagent',
    prompt: EXPLORE_PROMPT,
    tools: { write: false, edit: false, task: false },
    permissions: { write: 'deny', edit: 'deny' },
    color: '#7fa88b'
  }
}

const DEFAULT_PROVIDERS: Record<string, ProviderConfig> = {
  helmcode: {
    id: 'helmcode',
    npm: '@ai-sdk/openai-compatible',
    name: 'Helmcode',
    options: {
      baseURL: 'https://api.helmcode.com/v1',
      apiKey: '{env:HELMCODE_API_KEY}'
    },
    models: {
      'glm5.3-flash': { id: 'glm5.3-flash', name: 'GLM 5.3 Flash', contextWindow: 200000, toolCall: true }
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
    agent: DEFAULT_AGENTS,
    permissions: DEFAULT_PERMISSIONS,
    maxSteps: 60,
    theme: 'dark'
  }
}

/** Expands `{env:VAR}` and `{file:/path}` placeholders inside a config string. */
export function expandPlaceholders(value: string): string {
  return value
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

function expandDeep<T>(value: T): T {
  if (typeof value === 'string') return expandPlaceholders(value) as unknown as T
  if (Array.isArray(value)) return value.map(expandDeep) as unknown as T
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = expandDeep(v)
    return out as T
  }
  return value
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
    permissions: { ...base.permissions, ...((raw.permissions as Partial<Permissions>) ?? {}) },
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
      kind: e.kind ?? (e.ssh ? 'ssh' : 'local'),
      cwd: e.cwd,
      ssh: e.ssh
    }
  }
  if (!merged.environment.local) merged.environment.local = DEFAULT_ENVIRONMENTS.local

  const rawAgents = (raw.agent as Record<string, Partial<AgentConfig>>) ?? base.agent
  for (const [id, a] of Object.entries(rawAgents)) {
    merged.agent[id] = {
      id,
      name: a.name ?? id,
      description: a.description ?? '',
      mode: a.mode ?? 'primary',
      model: a.model,
      prompt: a.prompt,
      temperature: a.temperature,
      tools: a.tools,
      permissions: a.permissions,
      color: a.color
    }
  }
  if (Object.keys(merged.agent).length === 0) merged.agent = DEFAULT_AGENTS

  return merged
}

let cached: AppConfig | null = null

export function loadConfig(force = false): AppConfig {
  if (cached && !force) return cached
  if (!existsSync(CONFIG_PATH)) {
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig(), null, 2), 'utf8')
    cached = defaultConfig()
    return cached
  }
  try {
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Record<string, unknown>
    cached = normalizeConfig(raw)
  } catch (err) {
    cached = defaultConfig()
    cached.$schema = `invalid config at ${CONFIG_PATH}: ${(err as Error).message}`
  }
  return cached
}

/** The config with secrets resolved. Never send this to the renderer. */
export function resolvedConfig(): AppConfig {
  return expandDeep(loadConfig())
}

/** The config as written on disk, placeholders intact. Safe for the renderer. */
export function rawConfig(): AppConfig {
  return loadConfig()
}

export function saveConfig(next: AppConfig): AppConfig {
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(next, null, 2), 'utf8')
  cached = normalizeConfig(next as unknown as Record<string, unknown>)
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
  return normalized
}

export function effectivePermissions(config: AppConfig, agentId: string): Permissions {
  const agent = config.agent[agentId]
  return { ...config.permissions, ...(agent?.permissions ?? {}) }
}
