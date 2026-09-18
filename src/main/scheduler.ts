import type { Session } from '@shared/types'
import { columnOfKind, findColumn } from '@shared/boards'
import * as store from './store'
import { getBoard } from './boards'
import { isRunning, runTurn } from './agent/runner'
import { resolvedConfig } from './config'
import {
  assessRelated,
  clearClaims,
  coordinationNote,
  forgetJudgements,
  type Relatedness
} from './coordination'
import { bus } from './bus'

/**
 * The process manager behind the To do column.
 *
 * A task dropped in To do is an intention, not a running process. This drains
 * that queue against a concurrency limit, oldest first, so a person can line up
 * ten tasks and walk away. It is a plain function re-run on every relevant
 * event rather than a loop with its own state: there is no queue to get out of
 * sync with the sessions, and a restart resumes correctly because `queued`
 * survives in the session file.
 */

let running = false
let again = false

export function queuedTasks(): Session[] {
  return store
    .listSessions()
    .filter((session) => {
      if (session.status !== 'queued' || session.archived) return false
      if (!session.boardId) return false
      // A task created on the board carries its instructions. A chat dragged
      // into the queue carries its transcript instead, which is just as much a
      // thing to act on — what must not happen is queueing something with
      // neither, which would sit at "Queued" forever with nothing to send.
      if (!session.queuedPrompt && store.listMessages(session.id).length === 0) return false
      const board = getBoard(session.boardId)
      const column = board && findColumn(board, session.columnId)
      // Backlog is a parking space; only a queueing column actually runs.
      return column?.kind === 'todo' || column?.kind === 'in-progress'
    })
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt)
}

/**
 * Tasks with a turn in flight — anything that might be part-way through
 * changing files. This is who the coordinator compares a new task against,
 * because a task stopped at an approval prompt still holds whatever it has
 * already written.
 */
function inFlight(): Session[] {
  return store
    .listSessions()
    .filter(
      (session) =>
        isRunning(session.id) ||
        session.status === 'running' ||
        session.status === 'awaiting-approval'
    )
}

/**
 * Tasks actually working, which is what the concurrency limit is about.
 *
 * A task stopped at an approval prompt is not working — it is waiting for a
 * person, possibly for hours. Counting it against the limit meant two
 * unanswered prompts stalled the whole board with nothing to show why. The
 * limit bounds how much runs at once; it is not a queue of human attention.
 */
function working(): Session[] {
  return inFlight().filter((session) => session.status !== 'awaiting-approval')
}

/** Starts a queued task now, moving it to the board's in-progress column. */
function launch(session: Session, note: string): void {
  const board = session.boardId ? getBoard(session.boardId) : undefined
  const column = board ? columnOfKind(board, 'in-progress') : undefined
  const prompt = session.queuedPrompt || 'Carry on with this task from where it stopped.'

  store.updateSession(session.id, {
    status: 'running',
    columnId: column?.id ?? session.columnId,
    queuedPrompt: undefined,
    heldBy: undefined
  })

  void runTurn({ sessionId: session.id, userText: prompt, coordinationNote: note }).catch(() => {
    // runTurn already records the error on the session and toasts it.
  })
}

/** Whether two id lists say the same thing, order aside. */
function sameIds(left: string[] | undefined, right: string[]): boolean {
  const before = left ?? []
  if (before.length !== right.length) return false
  const seen = new Set(before)
  return right.every((id) => seen.has(id))
}

/**
 * Records the coordinator's verdict on a card, and does nothing when the card
 * already says it.
 *
 * `updateSession` has no notion of a write that changes nothing: it stamps a
 * fresh `updatedAt` and emits `session.updated` every time. The scheduler
 * listens to that event, so a held task used to wedge the whole process — the
 * pass wrote `heldBy`, the write woke the scheduler, the verdict came back from
 * the coordinator's cache so the next pass cost no round trip, the same
 * `heldBy` was written again, and round it went with no I/O in between. One
 * core at 100%, a window that never repainted, the running turn's stream never
 * read, and not a line in the log to say why.
 */
function recordVerdict(
  session: Session,
  verdict: { relatedSessionIds: string[]; heldBy?: string[] }
): void {
  const holdChanged = verdict.heldBy !== undefined && !sameIds(session.heldBy, verdict.heldBy)
  const relatedChanged = !sameIds(session.relatedSessionIds, verdict.relatedSessionIds)
  if (!holdChanged && !relatedChanged) return

  store.updateSession(session.id, {
    relatedSessionIds: verdict.relatedSessionIds,
    ...(verdict.heldBy === undefined ? {} : { heldBy: verdict.heldBy })
  })
}

/**
 * One pass over the queue. Re-entrant calls are collapsed into a single
 * re-run afterwards, since the assessment awaits and events keep arriving.
 */
export async function tick(): Promise<void> {
  if (running) {
    again = true
    return
  }
  running = true
  try {
    const config = resolvedConfig()
    const limit = Math.max(1, config.maxConcurrentTasks ?? 2)

    for (const candidate of queuedTasks()) {
      if (working().length >= limit) break

      let related: Relatedness[] = []
      try {
        related = await assessRelated(config, candidate, inFlight())
      } catch {
        related = []
      }

      // Same code as something in flight: wait for it rather than race it.
      const blocking = related.filter((entry) => entry.sameFiles)
      if (blocking.length > 0) {
        recordVerdict(candidate, {
          relatedSessionIds: related.map((entry) => entry.sessionId),
          // Named, so the card can say what it is waiting for instead of
          // sitting at "Queued" with no explanation.
          heldBy: blocking.map((entry) => entry.sessionId)
        })
        continue
      }

      if (related.length > 0) {
        recordVerdict(candidate, {
          relatedSessionIds: related.map((entry) => entry.sessionId)
        })
        // Both sides should know, not just the one starting second.
        for (const entry of related) {
          const other = store.getSession(entry.sessionId)
          if (!other) continue
          const ids = new Set(other.relatedSessionIds ?? [])
          ids.add(candidate.id)
          recordVerdict(other, { relatedSessionIds: [...ids] })
        }
      }

      const fresh = store.getSession(candidate.id)
      if (!fresh || fresh.status !== 'queued') continue
      launch(fresh, coordinationNote(related))
    }
  } finally {
    running = false
    if (again) {
      again = false
      void tick()
    }
  }
}

let timer: NodeJS.Timeout | null = null
let soon: NodeJS.Timeout | null = null
let unsubscribe: (() => void) | null = null

/**
 * A pass shortly, rather than a pass inside the event that asked for one.
 *
 * The scheduler's own writes reach it back as `session.updated`, so running the
 * next pass straight from the handler drains the queue in a chain of calls that
 * never yields to the event loop — and the moment any pass writes something it
 * has already written, that chain has no end and the process stops answering
 * for anything, streams and quit included. Going through a timer costs 25ms and
 * makes that failure impossible to express; it also collapses the burst of
 * events a starting turn emits into a single pass.
 */
function tickSoon(): void {
  if (soon) return
  soon = setTimeout(() => {
    soon = null
    void tick()
  }, 25)
}

/**
 * The queue is drained whenever a session changes — that covers a task
 * finishing and freeing a slot, and a card being dropped into To do. The timer
 * is a backstop for the case a task was held back by an overlap that has since
 * cleared, which no event announces.
 */
export function startScheduler(): void {
  stopScheduler()
  unsubscribe = bus.subscribe((event) => {
    if (event.type === 'session.deleted') {
      forgetJudgements(event.sessionId)
      // Its writes are nobody's neighbour now, and the registry is on disk.
      clearClaims(event.sessionId)
    }
    if (event.type === 'session.updated' || event.type === 'session.created') {
      // A task that stopped running cannot be overlapping anything any more.
      if (event.type === 'session.updated' && event.session.status === 'done') {
        forgetJudgements(event.session.id)
      }
      tickSoon()
    }
  })
  timer = setInterval(() => void tick(), 15_000)
  void tick()
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (soon) clearTimeout(soon)
  soon = null
  // Without this a second start would leave the first subscription in place,
  // and every session change would drain the queue twice.
  unsubscribe?.()
  unsubscribe = null
}
