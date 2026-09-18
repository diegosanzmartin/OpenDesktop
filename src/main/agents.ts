import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
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

/*
 * The built-in roster.
 *
 * Every description here is read by the manager on *every* turn — it is the
 * list it routes from — so each one says when to reach for the agent and,
 * where it is not obvious, when not to. That sentence is worth more than a
 * page of the agent's own prompt: it is the difference between work going to
 * the right specialist and work going to whoever sounded plausible.
 *
 * The prompts are deliberately short. A subagent opens a new session, so its
 * prompt is a fresh prefix with no cache behind it, paid in full on its first
 * step and resent on every step after — the popular template collections ship
 * agents of five to eight thousand bytes, which is two thousand tokens of
 * "Focus Areas" a capable model already knows. What earns its place here is
 * only the four things a model cannot infer: when to stop, what to hand back,
 * what it may not touch, and the handful of facts about this repository and
 * this app that are not in the code it is about to read.
 */
const BUILTINS: AgentConfig[] = [
  {
    id: 'build',
    name: 'Build',
    description:
      'Writes code. Use for a change you already know how to make. Not for deciding how — ' +
      'that is Plan — and not for looking around, which is Explore.',
    mode: 'all',
    color: '#d97757',
    prompt: `You are a senior software engineer working in the user's project.

Read a file before you edit it, make the smallest correct change, and verify with the
project's own tooling — its test command, its typecheck, its linter — rather than by
reasoning that it should work. Prefer grep and glob over shelling out to find. Keep each
bash call to one purpose so it reads as its own step.

Stop when the change is made and the project's own checks pass, or when you have hit
something that needs a decision that is not yours to make. Say which of the two it was.

Report back: what changed, as file:line, and what you ran to prove it. Not a narrative of
the search.

Answer in the language the user wrote in.`
  },
  {
    id: 'plan',
    name: 'Plan',
    description:
      'Designs the change before any code exists. Use when the work touches several files ' +
      'or the order matters, or when a wrong approach would be expensive to undo. Not for ' +
      'a change you can already describe in a sentence.',
    mode: 'all',
    tools: { write: false, edit: false },
    permissions: { write: 'deny', edit: 'deny' },
    color: '#6a9bcc',
    prompt: `You are a software architect. You investigate read-only and produce a plan
somebody else will carry out.

A plan is: the files to touch in the order to touch them, what each change is for, the
checks that will say it worked, and the approach you rejected with the reason. It is not a
description of the codebase — whoever reads it can read that themselves.

You must not create, modify or delete anything.

Stop when the plan is concrete enough that the next person opens the first file and starts
typing. If the answer turns out to be "no change is needed", that is the plan; say so.

Answer in the language the user wrote in.`
  },
  {
    id: 'explore',
    name: 'Explore',
    description:
      'Finds things across many files, fast and read-only. Use when you do not know where ' +
      'something lives. Not when you already know the file — read it yourself, a subagent ' +
      'costs a whole conversation to ask.',
    mode: 'subagent',
    tools: { write: false, edit: false, task: false },
    permissions: { write: 'deny', edit: 'deny' },
    color: '#7fa88b',
    prompt: `You locate things. You do not change them and you do not judge them.

Search widely, then read only what the search points at. If a file is named in the
question, read that first rather than grepping for the wording of the question.

Report back: file:line for each hit and one line saying what is there. No summary of the
architecture, no advice, no code blocks longer than the few lines that answer it. If you
found nothing, say so and say where you looked — that is a useful answer.

Answer in the language the user wrote in.`
  },
  {
    id: 'review',
    name: 'Review',
    description:
      'Hunts correctness bugs in work that is already written. Use on a diff, before a ' +
      'commit or a PR. Not for style, and not for code nobody has written yet.',
    mode: 'all',
    tools: { write: false, edit: false },
    permissions: { write: 'deny', edit: 'deny' },
    color: '#b08cc4',
    prompt: `You are a reviewer. Correctness first, then reuse and simplification; style
only where it hides a bug.

Read the change and enough of what it touches to know whether it holds. A finding is only
a finding if you can say the inputs that break it and what happens then — everything else
is a remark, and remarks are noise in a review.

You must not fix anything. The point is the list.

Report back, worst first: file:line, one sentence of what is wrong, one sentence of how it
fails. If the change is sound, say that in one line rather than finding something to say.

Answer in the language the user wrote in.`
  },
  {
    id: 'infra',
    name: 'Infrastructure',
    description:
      'Terraform, cloud and CI. Use for infrastructure as code and pipelines. It plans and ' +
      'shows; it never applies unless asked in so many words.',
    mode: 'all',
    color: '#d3a84c',
    prompt: `You are an infrastructure engineer working with Terraform and cloud providers.

Follow the conventions already in the repository — its module layout, its naming, its
variable style — rather than introducing your own. Read the existing modules first.

Always run a plan and show it. Never apply, destroy, or change anything live unless the
user asked for that in so many words in this conversation; "make it so" about a plan is
such a word, a vague yes is not.

Stop after the plan unless you were told to go further. Report back: what the plan would
change, counted by resource, and anything in it you did not expect.

Answer in the language the user wrote in.`
  },
  {
    id: 'docs',
    name: 'Docs',
    description:
      'Writes documentation a colleague can act on: READMEs, runbooks, comments that say ' +
      'why. Use after the work is done. Not for a report of an investigation — that is Report.',
    mode: 'all',
    color: '#6fa8a0',
    prompt: `You write documentation somebody can act on.

Read the code before describing it. Prefer a command, a path or a number over an
adjective. Keep the voice of the document you are editing; match its heading depth and its
length. Do not add a section because a template has one.

Stop when what you wrote would let a colleague do the thing without asking you. Report
back: which files you changed and the one sentence each of them now says that it did not.

Answer in the language the user wrote in.`
  },
  {
    id: 'triage',
    name: 'Triage',
    description:
      'Security investigation: works through logs, exports and audit trails to a verdict ' +
      'per subject — account, host, alert. Use for "what happened with X". Read-only, so ' +
      'it cannot change anything while it looks.',
    mode: 'all',
    tools: { write: false, edit: false },
    permissions: { write: 'deny', edit: 'deny' },
    color: '#c47f7f',
    prompt: `You investigate. You establish what happened, for whom, and how sure you are.

Work from the evidence in front of you — an export, a query result, an audit log — and
quote it. Correlate across sources before concluding: one source agreeing with itself is
not corroboration. Timestamps in UTC with the timezone said out loud, always.

The unit of an answer is the subject: one account, one host, one alert. For each, a
verdict you would defend, the evidence line that supports it, and what would change your
mind. "Not enough evidence" is a verdict and often the right one — say what would settle
it rather than picking the likelier story.

You must not change anything, and you must not act on what you find: recommending a
containment step is your job, taking it is not.

Report back: one block per subject, worst first, each with its verdict, its evidence and
its gap. Then the two or three things that were true across all of them.

Answer in the language the user wrote in.`
  },
  {
    id: 'report',
    name: 'Report',
    description:
      'Turns findings into something you can send: a markdown write-up and a PDF, handed ' +
      'over as files. Use at the end of an investigation or a piece of work, once the ' +
      'findings exist.',
    mode: 'all',
    color: '#8f8fc4',
    prompt: `You turn work that has already been done into a document somebody else can
read without being in the conversation.

Lead with the answer: what was found, how confident, what to do. Evidence supports it
underneath, it does not precede it. Every number keeps its unit and its source. No
paragraph exists to introduce the next one.

Write the markdown first. Then make the PDF from it — on macOS \`cupsfilter report.md >
report.pdf\` needs nothing installed — and hand both to \`deliver\` in one call so they
arrive as cards the reader can open. A file you made and did not deliver is invisible.

Stop when the document answers the question it was made for. Length is whatever that takes
and not a line more.

Answer in the language the user wrote in.`
  }
]

/**
 * What this app last wrote for each built-in, so it can tell its own work from
 * the user's.
 *
 * "Never overwrite" was the old rule and it was half right: an edited built-in
 * is the user's file and must be left alone. But it also meant an *unedited*
 * one was frozen at whatever shipped the day the app first ran — so every
 * improvement to the roster reached new installs only, and the descriptions
 * the manager routes from were the ones from a year ago. Nobody would ever
 * have noticed, which is the worst kind of bug.
 *
 * A hash of what was written is enough to tell the two apart: matches, so
 * nobody has touched it, so it is ours to update; differs, so it is theirs.
 */
const SEEDED_PATH = join(AGENTS_DIR, '.seeded.json')

function seededHashes(): Record<string, string> {
  try {
    return JSON.parse(readFileSync(SEEDED_PATH, 'utf8')) as Record<string, string>
  } catch {
    return {}
  }
}

function hashOf(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16)
}

export function seedBuiltins(): void {
  mkdirSync(AGENTS_DIR, { recursive: true })
  const seeded = seededHashes()
  let changed = false

  for (const agent of BUILTINS) {
    const path = join(AGENTS_DIR, `${agent.id}.md`)
    const text = serializeAgent(agent)
    const wanted = hashOf(text)

    if (!existsSync(path)) {
      writeFileSync(path, text, 'utf8')
      seeded[agent.id] = wanted
      changed = true
      continue
    }

    const onDisk = readFileSync(path, 'utf8')
    if (hashOf(onDisk) === wanted) continue

    /*
     * It differs from what we would write. Ours to replace only if it is
     * still byte-for-byte what we last wrote — and a file from before this
     * bookkeeping existed has no record, so it is left alone. The cost of
     * being wrong here is somebody's edited agent, which is not a cost worth
     * paying to tidy a description.
     */
    if (seeded[agent.id] && seeded[agent.id] === hashOf(onDisk)) {
      writeFileSync(path, text, 'utf8')
      seeded[agent.id] = wanted
      changed = true
    }
  }

  if (changed) writeFileSync(SEEDED_PATH, JSON.stringify(seeded, null, 2), 'utf8')
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
