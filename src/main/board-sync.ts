import type { Session } from '@shared/types'
import { columnForStatus, columnOfKind, findColumn } from '@shared/boards'
import { bus } from './bus'
import { getBoard } from './boards'
import * as store from './store'

/**
 * Moves a card when its task's reality changes: a turn starts and it lands in
 * In progress, an approval is requested and it lands in Blocked, the turn ends
 * and it lands in Done.
 *
 * Done as one subscriber rather than as calls sprinkled through the runner and
 * the approval path, because every one of those places already emits a status
 * change. The board follows the status; nothing has to remember to tell it.
 */
function sync(session: Session): void {
  if (!session.boardId) return
  const board = getBoard(session.boardId)
  if (!board) return

  const column = findColumn(board, session.columnId)

  // A turn that just ended. The runner has no idea it was a board task, so
  // "idle while sitting in In progress" is what finishing looks like from here.
  if (session.status === 'idle' && column?.kind === 'in-progress') {
    const done = columnOfKind(board, 'done')
    store.updateSession(session.id, { status: 'done', columnId: done?.id ?? session.columnId })
    return
  }

  // Backlog and review are a person's decision, so a card parked there is not
  // dragged out by the scheduler's intent: `queued` is dropped rather than
  // honoured, which is what stops a parked card reaching the queue. Anything
  // that genuinely needs a person still moves — being parked is not a reason to
  // swallow a task that is stuck.
  if ((column?.kind === 'backlog' || column?.kind === 'review') && session.status === 'queued') {
    store.updateSession(session.id, { status: 'idle' })
    return
  }

  const target = columnForStatus(board, session.status)
  if (!target || target.id === session.columnId) return
  if (session.status === 'idle') return

  store.updateSession(session.id, { columnId: target.id })
}

/**
 * A card left in In progress by a crash or a quit. The store resets a stale
 * `running` to idle as it loads, but that says nothing about the card, which
 * would otherwise sit in In progress claiming to be working forever.
 *
 * It is handed back to a person rather than re-queued: the turn stopped
 * half-way through and may have already written files, so running it again
 * unprompted could repeat work that was never meant to happen twice.
 */
export function reconcileOnStart(): void {
  for (const session of store.listSessions()) {
    if (!session.boardId || session.status !== 'idle') continue
    const board = getBoard(session.boardId)
    const column = board && findColumn(board, session.columnId)
    if (column?.kind !== 'in-progress') continue
    store.updateSession(session.id, {
      status: 'blocked',
      blockedReason: 'Stopped when the app closed. Open it and reply to carry on.'
    })
  }
}

export function startBoardSync(): void {
  bus.subscribe((event) => {
    if (event.type === 'session.updated' || event.type === 'session.created') sync(event.session)
  })
}
