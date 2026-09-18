import { mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, Neighbour, Session } from '@shared/types'
import { generateText } from 'ai'
import { z } from 'zod'
import * as store from './store'
import { bus } from './bus'
import { DATA_DIR } from './config'
import { readChanges } from './git'
import { resolveModel } from './providers'

/**
 * Keeps concurrent tasks from working past each other.
 *
 * Two mechanisms, deliberately different in kind:
 *
 *  - A **claim registry**, which is fact. Every write and edit records the path
 *    it touched. When another running task writes a file someone else has
 *    already changed, the tool result says so, naming the task. That reaches
 *    the agent through the channel it already reads — no new plumbing, and it
 *    cannot be wrong, because it only reports writes that actually happened.
 *    The registry is on disk: a change somebody made before lunch is still
 *    there after a restart, and it is the restart that used to lose it.
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
const CLAIMS_PATH = join(DATA_DIR, 'claims.json')

/**
 * Written a moment after the fact, not on the write itself.
 *
 * A turn that rewrites twenty files would otherwise serialise the whole
 * registry twenty times while the agent is waiting on the disk it is also
 * writing code to. Losing the last half-second of claims to a crash costs one
 * warning; blocking every write does not.
 */
let saveTimer: NodeJS.Timeout | null = null
function save(): void {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    flushClaims()
  }, 500)
}

export function flushClaims(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(CLAIMS_PATH, JSON.stringify({ version: 1, claims }), 'utf8')
  } catch {
    /* A claim that did not reach the disk is a warning nobody gets, which is
       where this feature started. It is not a reason to fail a write. */
  }
}

/**
 * Reads the registry back at startup, keeping only claims whose session still
 * exists — a deleted conversation's writes are nobody's business, and the
 * paths would otherwise name a task the user cannot open. Call after the store
 * has loaded, or everything is pruned.
 */
export function loadClaims(): void {
  claims.length = 0
  try {
    const raw = JSON.parse(readFileSync(CLAIMS_PATH, 'utf8')) as { claims?: Claim[] }
    for (const claim of raw.claims ?? []) {
      if (typeof claim?.sessionId !== 'string' || typeof claim?.path !== 'string') continue
      if (!store.getSession(claim.sessionId)) continue
      claims.push({ sessionId: claim.sessionId, path: claim.path, at: Number(claim.at) || Date.now() })
    }
  } catch {
    /* Nothing written yet, or unreadable: an empty registry is the right
       starting point either way. */
  }
  if (claims.length > CLAIM_CAP) claims.splice(0, claims.length - CLAIM_CAP)
}

export function recordWrite(sessionId: string, path: string): void {
  const known = claims.some((claim) => claim.sessionId === sessionId && claim.path === path)
  claims.push({ sessionId, path, at: Date.now() })
  if (claims.length > CLAIM_CAP) claims.splice(0, claims.length - CLAIM_CAP)
  save()
  // Only a path this task had not touched before can change who its
  // neighbours are; saving the same file for the fifth time cannot.
  if (!known) bus.emit({ type: 'claims.updated', sessionId })
}

export function clearClaims(sessionId: string): void {
  let removed = false
  for (let i = claims.length - 1; i >= 0; i--) {
    if (claims[i].sessionId === sessionId) {
      claims.splice(i, 1)
      removed = true
    }
  }
  if (!removed) return
  save()
  bus.emit({ type: 'claims.updated', sessionId })
}

/** Test seam: a registry with nothing in it and nothing on the disk behind it. */
export function resetClaims(): void {
  claims.length = 0
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

/**
 * Answers already given, so the same question is asked once.
 *
 * The scheduler re-runs on every session change and on a 15-second heartbeat.
 * A task held back by an overlap stays queued, so without this the same pair
 * was sent to the model every 15 seconds for as long as the overlap lasted —
 * hundreds of identical calls, all paid for.
 *
 * Keyed by the pair and by what was asked about it: if either task's wording
 * changes, that is a different question and gets asked again.
 */
const answers = new Map<string, Relatedness | null>()
const ANSWER_CAP = 500

function answerKey(candidate: string, other: string, asked: string): string {
  return `${candidate}|${other}|${asked.length}|${asked.slice(0, 120)}`
}

/** Called when a session ends or is deleted: its verdicts are now meaningless. */
export function forgetJudgements(sessionId: string): void {
  for (const key of [...answers.keys()]) {
    if (key.startsWith(`${sessionId}|`) || key.includes(`|${sessionId}|`)) answers.delete(key)
  }
}

/** For the tests: how many questions have actually been asked. */
let asked = 0
export function judgementCount(): number {
  return asked
}
export function resetJudgementCount(): void {
  asked = 0
}

async function judge(config: AppConfig, input: { candidate: string; other: string; cwd: string }) {
  asked++
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
 * What a task is, for the purpose of comparing it with another one.
 *
 * `launch()` clears `queuedPrompt` as a task starts — it has been sent, and a
 * card that comes back to the queue later should carry on rather than replay it
 * — so the running side of every comparison used to collapse to its title
 * alone. The keyword prefilter then found nothing in common and the model was
 * never asked: two tasks both rewriting README.md went past each other, and the
 * second documented behaviour the first was in the middle of changing. Once the
 * prompt is gone the transcript is what the task was asked to do.
 */
function brief(session: Session): string {
  const asked =
    session.queuedPrompt ??
    store
      .listMessages(session.id)
      .find((message) => message.role === 'user')
      ?.parts.find((part) => part.type === 'text')?.text
  return `${session.title}${asked ? ` — ${asked.slice(0, 400)}` : ''}`
}

/**
 * The same, plus the files it has already written — the strongest signal there
 * is, and the one the prefilter most needs. Kept out of the cache key, because
 * a task that writes a tenth file has not asked a new question, and the pair
 * would otherwise be put to the model again every time one of them saves.
 */
function briefWithClaims(session: Session, text: string): string {
  const paths = pathsWrittenBy(session.id).slice(0, 12)
  return paths.length === 0 ? text : `${text} — files already changed: ${paths.join(', ')}`
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
  const describe = brief

  const peers = running.filter(
    (other) =>
      other.id !== candidate.id &&
      other.cwd === candidate.cwd &&
      other.environmentId === candidate.environmentId
  )

  const out: Relatedness[] = []
  for (const other of peers) {
    const candidateText = describe(candidate)
    const otherText = describe(other)
    const candidateFull = briefWithClaims(candidate, candidateText)
    const otherFull = briefWithClaims(other, otherText)
    if (!shareSurface(candidateFull, otherFull)) continue

    const key = answerKey(candidate.id, other.id, candidateText + otherText)
    if (answers.has(key)) {
      const cached = answers.get(key)
      if (cached) out.push(cached)
      continue
    }

    try {
      const verdict = await judge(config, {
        candidate: candidateFull,
        other: otherFull,
        cwd: candidate.cwd
      })
      if (!verdict.related && !verdict.same_files) {
        // Remembered too: "these are unrelated" is just as expensive to ask.
        remember(key, null)
        continue
      }
      const answer: Relatedness = {
        sessionId: other.id,
        sameFiles: verdict.same_files,
        sameTopic: verdict.related,
        why: verdict.reason
      }
      remember(key, answer)
      out.push(answer)
    } catch {
      // The judgement is an optimisation, not a gate. If the model is
      // unreachable the keyword overlap already told us they share a surface,
      // so say so and let both run rather than stalling the queue.
      // Not remembered: the model being unreachable is a passing condition, and
      // caching it would keep this guess long after it could be checked.
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

function remember(key: string, answer: Relatedness | null): void {
  if (answers.size >= ANSWER_CAP) {
    // Oldest first; insertion order is what Map iteration gives us.
    const oldest = answers.keys().next().value
    if (oldest !== undefined) answers.delete(oldest)
  }
  answers.set(key, answer)
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

/* ---------------- neighbours ---------------- */

/** The path a path really is, or the path itself when it cannot be resolved. */
function realPath(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return path
  }
}

function isLive(session: Session): boolean {
  return (
    session.status === 'running' ||
    session.status === 'awaiting-approval' ||
    session.status === 'queued'
  )
}

/** Every session that has claimed one of the paths this one has claimed. */
export function claimOverlap(sessionId: string): Map<string, string[]> {
  const session = store.getSession(sessionId)
  if (!session) return new Map()
  const mine = new Set(pathsWrittenBy(sessionId))
  if (mine.size === 0) return new Map()

  const out = new Map<string, string[]>()
  for (const claim of claims) {
    if (claim.sessionId === sessionId || !mine.has(claim.path)) continue
    const other = store.getSession(claim.sessionId)
    // Different machines cannot tread on each other, whatever the path says.
    if (!other || other.environmentId !== session.environmentId) continue
    const paths = out.get(claim.sessionId) ?? []
    if (!paths.includes(claim.path)) paths.push(claim.path)
    out.set(claim.sessionId, paths)
  }
  return out
}

/**
 * Who else is in this file — for the line above the composer.
 *
 * Two claims on the same path are not automatically a hazard. If the other
 * task has finished *and* its change is already committed, then what it did is
 * history: the file on disk is settled and there is nothing left to tread on.
 * So the working tree gets the last word, and a shared path only survives when
 * the other task is still working or the change is still sitting there
 * uncommitted. This is also what makes the bar go quiet on its own, instead of
 * naming the same three conversations for the rest of the week.
 *
 * The git call only happens when there is an overlap to check, which there
 * almost never is, so the common answer costs one pass over the registry.
 */
export async function describeNeighbours(sessionId: string): Promise<Neighbour[]> {
  const session = store.getSession(sessionId)
  if (!session) return []

  const overlap = claimOverlap(sessionId)
  let uncommitted: Set<string> | null = null

  if (overlap.size > 0) {
    try {
      const changes = await readChanges(session.environmentId, session.cwd)
      if (changes.isRepo) {
        // Both spellings of the repository root. git answers with the path it
        // was given; a claim carries whatever the tool resolved. On macOS the
        // temp directory alone is enough to make those two different strings
        // for the same file (/var/… and /private/var/…), and a set of strings
        // does not care that they are the same file.
        const roots = new Set([changes.root, realPath(changes.root)])
        uncommitted = new Set()
        for (const file of changes.files) {
          for (const root of roots) uncommitted.add(join(root, file.path))
        }
      }
    } catch {
      // Unreadable tree: fall back to trusting the registry rather than
      // silently dropping warnings because a host was unreachable.
    }
  }

  const out: Neighbour[] = []
  for (const [otherId, paths] of overlap) {
    const other = store.getSession(otherId)
    if (!other) continue
    const live = isLive(other)
    const shared =
      live || !uncommitted
        ? paths
        : paths.filter((path) => uncommitted.has(path) || uncommitted.has(realPath(path)))
    if (shared.length === 0) continue
    out.push({ sessionId: otherId, title: other.title, status: other.status, live, shared })
  }

  // The coordinator's guesses, for tasks that share no file yet. Weaker, so
  // they come after, and only while the other side is actually working —
  // a guess about something that has finished is nothing to act on.
  for (const otherId of session.relatedSessionIds ?? []) {
    if (overlap.has(otherId)) continue
    const other = store.getSession(otherId)
    if (!other || !isLive(other)) continue
    out.push({
      sessionId: otherId,
      title: other.title,
      status: other.status,
      live: true,
      shared: [],
      why: 'the coordinator thinks these are about the same thing'
    })
  }

  out.sort((a, b) => Number(b.live) - Number(a.live) || b.shared.length - a.shared.length)
  return out
}
