import { useMemo, type ReactNode } from 'react'
import { Clock, Maximize2, X } from 'lucide-react'
import { findColumn } from '@shared/boards'
import { useStore } from '../state/store'
import { ChatView } from './ChatView'
import { EditableTitle } from './EditableTitle'

/**
 * A card, open as an ordinary chat beside the board.
 *
 * This is the whole ChatView, not a cut-down version of it, so a task gets the
 * composer's environment, agent and model pickers, attachments and approvals
 * for free — a task is a conversation, and there was never a reason for it to
 * be a different kind of thing from the one in the Chat view.
 */
export function TaskPanel(): ReactNode {
  const sessions = useStore((s) => s.sessions)
  const boards = useStore((s) => s.boards)
  const taskId = useStore((s) => s.boardTaskId)
  const closeTask = useStore((s) => s.closeTask)
  const setView = useStore((s) => s.setView)

  const session = sessions.find((candidate) => candidate.id === taskId)
  const column = useMemo(() => {
    const board = boards.find((candidate) => candidate.id === session?.boardId)
    return board && session ? findColumn(board, session.columnId) : undefined
  }, [boards, session])

  if (!session) return null

  const queues = column?.kind === 'todo' || column?.kind === 'backlog'

  return (
    <div className="border-ink-800 bg-ink-950 flex w-[460px] shrink-0 flex-col border-l">
      <div className="border-ink-800 flex h-11 shrink-0 items-center gap-1 border-b px-2">
        <EditableTitle
          value={session.title}
          onCommit={(title) => void window.opendesktop.sessions.update(session.id, { title })}
          className="text-ink-100 flex-1 text-[13px] font-medium"
          inputClassName="min-w-0 flex-1 text-[13px] font-medium"
        />
        {column ? (
          <span className="bg-ink-800 text-ink-400 shrink-0 rounded-md px-1.5 py-[2px] text-[10.5px]">
            {column.name}
          </span>
        ) : null}
        <button
          type="button"
          title="Open in the chat view"
          onClick={() => setView('chat')}
          className="text-ink-500 hover:bg-ink-800 hover:text-ink-100 shrink-0 rounded-md p-1.5"
        >
          <Maximize2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          title="Close"
          onClick={closeTask}
          className="text-ink-500 hover:bg-ink-800 hover:text-ink-100 shrink-0 rounded-md p-1.5"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {queues ? (
        <div className="border-ink-800 text-ink-500 flex items-start gap-1.5 border-b px-3 py-1.5 text-[11px] leading-[1.45]">
          <Clock className="mt-[2px] h-3 w-3 shrink-0" />
          <span>
            {column?.kind === 'todo'
              ? 'This card is in To do, so what you send is queued — it starts when the scheduler has a free slot.'
              : 'This card is in Backlog, so what you send is saved, not run. Move it to To do to queue it.'}
          </span>
        </div>
      ) : null}

      {session.queuedPrompt ? (
        <div className="border-ink-800 text-ink-400 border-b px-3 py-2 text-[11.5px] leading-[1.5]">
          <span className="text-ink-600">Waiting to send: </span>
          {session.queuedPrompt}
        </div>
      ) : null}

      <ChatView session={session} />
    </div>
  )
}
