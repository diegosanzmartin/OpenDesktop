import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { AgentConfig, AgentMode, Permissions } from '@shared/types'
import { CONFIG_DIR } from './config'
import { parseDocument, stringifyDocument } from './frontmatter'

/**
 * Agents live one per file in ~/.config/opendesktop/agents, in the same
 * markdown-with-frontmatter shape these agent files use: the
 * header is the configuration and the body is the system prompt. Keeping to
 * that format means an agent written for either tool works in both, and
 * importing is a copy rather than a conversion.
 */
export const AGENTS_DIR = join(CONFIG_DIR, 'agents')
const CLAUDE_AGENTS_DIR = join(homedir(), '.claude', 'agents')

interface AgentFrontmatter {
  name: string
  description: string
  mode: AgentMode
  model: string
  temperature: number
  color: string
  /** Some tools write this as a comma-separated allow-list of tool names. */
  tools: string | Record<string, boolean>
  permissions: Partial<Permissions>
}

const ALL_TOOLS = ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'list', 'fetch', 'task']

/** A `tools: read, grep` header means "only these"; expand it to our map. */
function normalizeTools(value: AgentFrontmatter['tools'] | undefined): Record<string, boolean> | undefined {
  if (!value) return undefined
  if (typeof value !== 'string') return value
  const allowed = value
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean)
  if (allowed.length === 0) return undefined
  return Object.fromEntries(ALL_TOOLS.map((tool) => [tool, allowed.includes(tool)]))
}

function toolsToFrontmatter(tools: Record<string, boolean> | undefined): string | undefined {
  if (!tools) return undefined
  const allowed = ALL_TOOLS.filter((tool) => tools[tool] !== false)
  return allowed.length === ALL_TOOLS.length ? undefined : allowed.join(', ')
}

function slug(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
}

export function parseAgentFile(id: string, text: string): AgentConfig {
  const { data, body } = parseDocument<AgentFrontmatter>(text)
  return {
    id,
    name: data.name?.trim() || id,
    description: data.description?.trim() ?? '',
    mode: data.mode ?? 'all',
    model: data.model,
    temperature: typeof data.temperature === 'number' ? data.temperature : undefined,
    tools: normalizeTools(data.tools),
    permissions: data.permissions,
    color: data.color,
    prompt: body || undefined
  }
}

export function serializeAgent(agent: AgentConfig): string {
  return stringifyDocument(
    {
      name: agent.name,
      description: agent.description,
      mode: agent.mode,
      model: agent.model,
      temperature: agent.temperature,
      tools: toolsToFrontmatter(agent.tools),
      permissions: agent.permissions,
      color: agent.color
    },
    agent.prompt ?? ''
  )
}

/* ---------------- the built-in set ---------------- */

const BUILTINS: AgentConfig[] = [
  {
    id: 'build',
    name: 'Build',
    description: 'Full-access engineer that reads, writes and runs commands.',
    mode: 'all',
    color: '#d97757',
    prompt: `You are a senior software engineer working inside OpenDesktop.
Work directly in the user's project: read files before editing them, make the smallest
correct change, and verify with the project's own tooling when it exists.
Prefer the grep/glob tools over shelling out to find. Keep bash commands short and
single-purpose so each one reads clearly as its own step.
Answer in English.`
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only architect that designs the change before any code is written.',
    mode: 'all',
    color: '#6a9bcc',
    tools: { write: false, edit: false },
    permissions: { write: 'deny', edit: 'deny' },
    prompt: `You are a software architect working inside OpenDesktop.
Investigate the codebase read-only and produce a concrete implementation plan:
the files to touch, the order of the work, and the trade-offs you rejected.
You must not modify, create or delete files. Answer in English.`
  },
  {
    id: 'review',
    name: 'Review',
    description: 'Read-only reviewer that hunts correctness bugs in the current diff.',
    mode: 'all',
    color: '#b08cc4',
    tools: { write: false, edit: false },
    permissions: { write: 'deny', edit: 'deny' },
    prompt: `You are a meticulous code reviewer working inside OpenDesktop.
Review the pending changes for correctness bugs first, then for reuse and simplification.
Report each finding with the file, the line and a concrete failure scenario.
You must not modify files. Answer in English.`
  },
  {
    id: 'explore',
    name: 'Explore',
    description: 'Fast read-only search agent for locating code across many files.',
    mode: 'subagent',
    color: '#7fa88b',
    tools: { write: false, edit: false, task: false },
    permissions: { write: 'deny', edit: 'deny' },
    prompt: `You are a read-only research agent. Locate the relevant code and
report a tight summary with file:line references. Do not modify anything. Answer in English.`
  },
  {
    id: 'infra',
    name: 'Infrastructure',
    description:
      'Terraform and cloud infrastructure: plans, reviews and applies changes to IaC.',
    mode: 'all',
    color: '#d3a84c',
    prompt: `You are an infrastructure engineer working with Terraform and cloud providers.
Read the existing modules and follow the conventions already in the repository rather than
introducing your own. Always run a plan and show it before proposing an apply, and never
apply without the user asking for it in so many words. Answer in English.`
  },
  {
    id: 'docs',
    name: 'Docs',
    description: 'Writes and edits documentation, READMEs and runbooks.',
    mode: 'all',
    color: '#6fa8a0',
    prompt: `You write documentation that a colleague can act on.
Read the code before describing it, prefer concrete commands and paths over prose, and keep
the existing document's voice. Answer in English.`
  }
]

export function seedBuiltins(): void {
  mkdirSync(AGENTS_DIR, { recursive: true })
  for (const agent of BUILTINS) {
    const path = join(AGENTS_DIR, `${agent.id}.md`)
    // Never overwrite: an edited built-in is the user's file now.
    if (!existsSync(path)) writeFileSync(path, serializeAgent(agent), 'utf8')
  }
}

/* ---------------- reading and writing ---------------- */

export function listAgents(): Record<string, AgentConfig> {
  mkdirSync(AGENTS_DIR, { recursive: true })
  const out: Record<string, AgentConfig> = {}
  for (const file of readdirSync(AGENTS_DIR)) {
    if (!file.endsWith('.md')) continue
    const id = file.slice(0, -3)
    try {
      out[id] = parseAgentFile(id, readFileSync(join(AGENTS_DIR, file), 'utf8'))
    } catch {
      // A broken file should not take the whole set down.
    }
  }
  return out
}

export function saveAgent(agent: AgentConfig): AgentConfig {
  mkdirSync(AGENTS_DIR, { recursive: true })
  const id = slug(agent.id || agent.name)
  const next = { ...agent, id }
  writeFileSync(join(AGENTS_DIR, `${id}.md`), serializeAgent(next), 'utf8')
  return next
}

export function deleteAgent(id: string): void {
  const path = join(AGENTS_DIR, `${slug(id)}.md`)
  if (existsSync(path)) rmSync(path)
}

export function agentFilePath(id: string): string {
  return join(AGENTS_DIR, `${slug(id)}.md`)
}

/**
 * Moves agents that were declared in config.json into files, once. Without this
 * an existing install would silently lose its customised agents.
 */
export function migrateFromConfig(fromConfig: Record<string, AgentConfig> | undefined): number {
  if (!fromConfig) return 0
  mkdirSync(AGENTS_DIR, { recursive: true })
  let moved = 0
  for (const [id, agent] of Object.entries(fromConfig)) {
    const path = join(AGENTS_DIR, `${slug(id)}.md`)
    if (existsSync(path)) continue
    writeFileSync(path, serializeAgent({ ...agent, id }), 'utf8')
    moved++
  }
  return moved
}

/* ---------------- import ---------------- */

export function importableAgents(dir = CLAUDE_AGENTS_DIR): { id: string; name: string; description: string }[] {
  if (!existsSync(dir)) return []
  const out: { id: string; name: string; description: string }[] = []
  for (const file of readdirSync(dir)) {
    if (!file.endsWith('.md')) continue
    const id = file.slice(0, -3)
    try {
      const agent = parseAgentFile(id, readFileSync(join(dir, file), 'utf8'))
      out.push({ id, name: agent.name, description: agent.description })
    } catch {
      /* skip */
    }
  }
  return out
}

export function importAgents(ids: string[], dir = CLAUDE_AGENTS_DIR): number {
  mkdirSync(AGENTS_DIR, { recursive: true })
  let imported = 0
  for (const id of ids) {
    const source = join(dir, `${id}.md`)
    if (!existsSync(source)) continue
    writeFileSync(join(AGENTS_DIR, `${slug(id)}.md`), readFileSync(source, 'utf8'), 'utf8')
    imported++
  }
  return imported
}
