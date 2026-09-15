import type { Session } from '@shared/types'
import { columnOfKind, findColumn } from '@shared/boards'
import * as store from './store'
import { getBoard } from './boards'
import { isRunning, runTurn } from './agent/runner'
import { resolvedConfig } from './config'
import { assessRelated, coordinationNote, type Relatedness } from './coordination'
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
 * What is holding a slot. The runner's own map is the accurate answer, but a
 * session marked running or waiting on an approval is holding the same ground —
 * it has a turn in flight and may be part-way through writing files. Counting
 * both means the limit holds no matter which path started the work.
 */
function liveTasks(): Session[] {
  return store
    .listSessions()
    .filter(
      (session) =>
        isRunning(session.id) ||
        session.status === 'running' ||
        session.status === 'awaiting-approval'
    )
}

/** Starts a queued task now, moving it to the board's in-progress column. */
function launch(session: Session, note: string): void {
  const board = session.boardId ? getBoard(session.boardId) : undefined
  const column = board ? columnOfKind(board, 'in-progress') : undefined
  const prompt = session.queuedPrompt || 'Carry on with this task from where it stopped.'

  store.updateSession(session.id, {
    status: 'running',
    columnId: column?.id ?? session.columnId,
    queuedPrompt: undefined
  })

  void runTurn({ sessionId: session.id, userText: prompt, coordinationNote: note }).catch(() => {
    // runTurn already records the error on the session and toasts it.
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
      const live = liveTasks()
      if (live.length >= limit) break

      let related: Relatedness[] = []
      try {
        related = await assessRelated(config, candidate, live)
      } catch {
        related = []
      }

      // Same code as something in flight: wait for it rather than race it.
      const blocking = related.filter((entry) => entry.sameFiles)
      if (blocking.length > 0) {
        store.updateSession(candidate.id, {
          relatedSessionIds: related.map((entry) => entry.sessionId)
        })
        continue
      }

      if (related.length > 0) {
        store.updateSession(candidate.id, {
          relatedSessionIds: related.map((entry) => entry.sessionId)
        })
        // Both sides should know, not just the one starting second.
        for (const entry of related) {
          const other = store.getSession(entry.sessionId)
          if (!other) continue
          const ids = new Set(other.relatedSessionIds ?? [])
          ids.add(candidate.id)
          store.updateSession(other.id, { relatedSessionIds: [...ids] })
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

/**
 * The queue is drained whenever a session changes — that covers a task
 * finishing and freeing a slot, and a card being dropped into To do. The timer
 * is a backstop for the case a task was held back by an overlap that has since
 * cleared, which no event announces.
 */
export function startScheduler(): void {
  bus.subscribe((event) => {
    if (event.type === 'session.updated' || event.type === 'session.created') void tick()
  })
  timer = setInterval(() => void tick(), 15_000)
  void tick()
}

export function stopScheduler(): void {
  if (timer) clearInterval(timer)
  timer = null
}
