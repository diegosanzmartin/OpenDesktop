import type { Attachment } from '@shared/types'
import { findColumn } from '@shared/boards'
import { isRunning, queueFollowUp, runTurn } from './agent/runner'
import { getBoard } from './boards'
import { tick } from './scheduler'
import * as store from './store'

/** What the composer's send does: queue it on a board, hand it to a running turn, or start one. */
export async function sendMessage(sessionId: string, text: string, attachments?: Attachment[]): Promise<boolean> {
  // On a board, the column the card sits in decides whether this runs now or
  // joins the queue: a task in To do means "do this when there is room".
  // The box is empty once it is sent; the renderer's own write of that is a moment late
  // and dies with a window closed at once, which brought the sent text back.
  store.setSessionDraft(sessionId, '')
  const session = store.getSession(sessionId)
  const board = session?.boardId ? getBoard(session.boardId) : undefined
  const column = board && findColumn(board, session!.columnId)

  if (session && column && (column.kind === 'todo' || column.kind === 'backlog')) {
    store.updateSession(session.id, {
      queuedPrompt: text,
      status: column.kind === 'todo' ? 'queued' : 'idle',
      title:
        session.title === 'New task' || session.title === 'New session'
          ? text.replace(/\s+/g, ' ').slice(0, 70) || session.title
          : session.title
    })
    void tick()
    return true
  }

  // Typing while it works is not an error: the turn reads it before its next step.
  if (isRunning(sessionId)) {
    queueFollowUp(sessionId, text)
    return true
  }

  void runTurn({ sessionId, userText: text, attachments }).catch(() => undefined)
  return true
}
