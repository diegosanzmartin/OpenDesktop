import type { AppConfig, Session } from '@shared/types'
import { generateText } from 'ai'
import { z } from 'zod'
import * as store from './store'
import { resolveModel } from './providers'

/**
 * Keeps concurrent tasks from working past each other.
 *
 * Two mechanisms, deliberately different in kind:
 *
 *  - A **claim registry**, which is fact. Every write and edit records the path
 *    it touched. When another running task writes a file someone else has
 *    already changed in this run, the tool result says so, naming the task.
 *    That reaches the agent through the channel it already reads — no new
 *    plumbing, and it cannot be wrong, because it only reports writes that
 *    actually happened.
 *
 *  - A **relatedness judgement**, which is a guess. Before a queued task
 *    starts, the model is asked whether it overlaps with what is already
 *    running. Predicted file overlap holds the task back until the other
 *    finishes; a shared subject only adds a note to its prompt. The judgement
 *    is a guess, so the consequence is scaled to it: never silently drop work,
 *    and prefer telling an agent about its neighbour over blocking it.
 */

interface Claim {
  sessionId: string
  path: string
  at: number
}

const claims: Claim[] = []
const CLAIM_CAP = 2000

export function recordWrite(sessionId: string, path: string): void {
  claims.push({ sessionId, path, at: Date.now() })
  if (claims.length > CLAIM_CAP) claims.splice(0, claims.length - CLAIM_CAP)
}

export function clearClaims(sessionId: string): void {
  for (let i = claims.length - 1; i >= 0; i--) {
    if (claims[i].sessionId === sessionId) claims.splice(i, 1)
  }
}

export function pathsWrittenBy(sessionId: string): string[] {
  return [...new Set(claims.filter((claim) => claim.sessionId === sessionId).map((c) => c.path))]
}

/**
 * A warning to append to a write's result when another task that is still
 * running has already changed the same file. Empty when there is no clash,
 * which is the normal case, so this costs nothing to call on every write.
 */
export function writeWarning(sessionId: string, path: string): string {
  const others = claims.filter((claim) => claim.path === path && claim.sessionId !== sessionId)
  if (others.length === 0) return ''

  const names = [...new Set(others.map((claim) => claim.sessionId))]
    .map((id) => {
      const session = store.getSession(id)
      if (!session) return null
      const live = session.status === 'running' || session.status === 'awaiting-approval'
      return { session, live }
    })
    .filter((entry): entry is { session: Session; live: boolean } => entry !== null)

  if (names.length === 0) return ''
  const live = names.filter((entry) => entry.live)
  const relevant = live.length > 0 ? live : names

  return (
    `\n\nHeads up: ${relevant
      .map((entry) => `"${entry.session.title}" (task ${entry.session.id}${entry.live ? ', still running' : ''})`)
      .join(' and ')} also changed this file. ` +
    `Re-read it before you assume your edit is the only one, and do not undo work you did not make.`
  )
}

/* ---------------- relatedness ---------------- */

export interface Relatedness {
  sessionId: string
  /** Same code: hold the queued task until the running one finishes. */
  sameFiles: boolean
  /** Same subject: start, but tell each side about the other. */
  sameTopic: boolean
  why: string
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'to', 'for', 'of', 'in', 'on', 'with', 'from', 'by', 'at',
  'add', 'fix', 'update', 'create', 'make', 'new', 'task', 'please', 'that', 'this', 'it',
  'la', 'el', 'los', 'las', 'de', 'del', 'un', 'una', 'y', 'o', 'para', 'con', 'en', 'que'
])

export function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9_./-]+/)
      .filter((word) => word.length > 2 && !STOP_WORDS.has(word))
  )
}

/**
 * A cheap prefilter. Asking a model about every pair of tasks would cost a call
 * per pair on every dequeue, and most pairs share nothing at all — this throws
 * those out before any network round trip.
 */
export function shareSurface(a: string, b: string): boolean {
  const left = keywords(a)
  for (const word of keywords(b)) if (left.has(word)) return true
  return false
}

const JUDGEMENT = z.object({
  related: z.boolean(),
  same_files: z.boolean(),
  reason: z.string()
})

type Judge = (input: { candidate: string; other: string; cwd: string }) => Promise<{
  related: boolean
  same_files: boolean
  reason: string
}>

let judgeOverride: Judge | null = null

/** Test seam: lets the headless test drive the whole path without a provider. */
export function setRelatednessJudge(judge: Judge | null): void {
  judgeOverride = judge
}

async function judge(config: AppConfig, input: { candidate: string; other: string; cwd: string }) {
  if (judgeOverride) return judgeOverride(input)

  const resolved = await resolveModel(config, config.model)
  const result = await generateText({
    model: resolved.model,
    system:
      'You decide whether two software tasks would collide if run at the same time by ' +
      'different agents. Answer with JSON only: {"related":bool,"same_files":bool,"reason":"one short sentence"}. ' +
      'same_files means they would very likely edit the same files or the same resource. ' +
      'related means they concern the same subject even if the files differ. Be strict: ' +
      'unrelated work in the same repository is not related.',
    prompt:
      `Working directory: ${input.cwd}\n\n` +
      `Task A (about to start): ${input.candidate}\n` +
      `Task B (already running): ${input.other}\n\n` +
      'JSON:'
  })

  const match = result.text.match(/\{[\s\S]*\}/)
  if (!match) return { related: false, same_files: false, reason: '' }
  return JUDGEMENT.parse(JSON.parse(match[0]))
}

/**
 * How a task about to start relates to the ones already running. Only tasks on
 * the same folder and environment are considered: two agents on different
 * machines cannot tread on each other.
 */
export async function assessRelated(
  config: AppConfig,
  candidate: Session,
  running: Session[]
): Promise<Relatedness[]> {
  const describe = (session: Session): string =>
    `${session.title}${session.queuedPrompt ? ` — ${session.queuedPrompt.slice(0, 400)}` : ''}`

  const peers = running.filter(
    (other) =>
      other.id !== candidate.id &&
      other.cwd === candidate.cwd &&
      other.environmentId === candidate.environmentId
  )

  const out: Relatedness[] = []
  for (const other of peers) {
    if (!shareSurface(describe(candidate), describe(other))) continue
    try {
      const verdict = await judge(config, {
        candidate: describe(candidate),
        other: describe(other),
        cwd: candidate.cwd
      })
      if (!verdict.related && !verdict.same_files) continue
      out.push({
        sessionId: other.id,
        sameFiles: verdict.same_files,
        sameTopic: verdict.related,
        why: verdict.reason
      })
    } catch {
      // The judgement is an optimisation, not a gate. If the model is
      // unreachable the keyword overlap already told us they share a surface,
      // so say so and let both run rather than stalling the queue.
      out.push({
        sessionId: other.id,
        sameFiles: false,
        sameTopic: true,
        why: 'they mention the same things (the model could not be reached to check further)'
      })
    }
  }
  return out
}

/**
 * The paragraph handed to an agent whose task overlaps with live work. It names
 * the other tasks and what they have already touched, so the agent can read
 * their files before it writes over them.
 */
export function coordinationNote(related: Relatedness[]): string {
  if (related.length === 0) return ''
  const lines = related.map((entry) => {
    const session = store.getSession(entry.sessionId)
    if (!session) return null
    const paths = pathsWrittenBy(entry.sessionId).slice(0, 12)
    return (
      `- "${session.title}" (task ${session.id}, ${session.status})` +
      `${entry.why ? ` — ${entry.why}` : ''}` +
      (paths.length > 0 ? `\n  Files it has already changed: ${paths.join(', ')}` : '')
    )
  })
  const body = lines.filter(Boolean).join('\n')
  if (!body) return ''

  return `

# Other agents are working nearby
These tasks are running now and overlap with yours:
${body}

Read those files before you change them, keep your edits additive where you can,
and say in your summary anything the other agent needs to know. Do not revert
their work. If your change would undo theirs, stop and report it instead.`
}
