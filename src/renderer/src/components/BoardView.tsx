import clsx from 'clsx'
import { useMemo, useState, type DragEvent, type ReactNode } from 'react'
import {
  AlertTriangle,
  Check,
  ChevronDown,
  Clock,
  Link2,
  Loader2,
  Plus,
  SquareKanban,
  Trash2,
  UserRound
} from 'lucide-react'
import type { Board, BoardColumn, Session } from '@shared/types'
import {
  ALL_BOARDS,
  cardsOnBoard,
  columnsFor,
  isDraggable,
  isManualColumn,
  overviewColumnId,
  storiesInColumn,
  type Story
} from '@shared/boards'
import { useStore } from '../state/store'
import { folderName } from '../lib/format'
import { Button } from './ui'
import { TaskPanel } from './TaskPanel'
import { EditableTitle } from './EditableTitle'

/* ---------------- cards ---------------- */

function StatusBadge({ session }: { session: Session }): ReactNode {
  switch (session.status) {
    case 'running':
      return (
        <span className="text-info flex items-center gap-1 text-[10px]">
          <Loader2 className="h-2.5 w-2.5 animate-spin" />
          Running
        </span>
      )
    case 'queued':
      return (
        <span className="text-ink-500 flex items-center gap-1 text-[10px]">
          <Clock className="h-2.5 w-2.5" />
          Queued
        </span>
      )
    case 'awaiting-approval':
      return (
        <span className="text-warn flex items-center gap-1 text-[10px]">
          <AlertTriangle className="h-2.5 w-2.5" />
          Needs approval
        </span>
      )
    case 'blocked':
      return (
        <span className="text-warn flex items-center gap-1 text-[10px]">
          <AlertTriangle className="h-2.5 w-2.5" />
          Needs you
        </span>
      )
    case 'error':
      return <span className="text-bad text-[10px]">Failed</span>
    case 'done':
      return (
        <span className="text-ok flex items-center gap-1 text-[10px]">
          <Check className="h-2.5 w-2.5" />
          Done
        </span>
      )
    default:
      // A card that has not run yet says nothing: the column already does.
      return null
  }
}

/** The stripe down the left of a card, as on the reference board. */
function accentFor(session: Session): string {
  switch (session.status) {
    case 'running':
      return 'bg-info'
    case 'awaiting-approval':
    case 'blocked':
      return 'bg-warn'
    case 'error':
      return 'bg-bad'
    case 'done':
      return 'bg-ok'
    default:
      return 'bg-ink-600'
  }
}

function Card({ session, onDragStart }: { session: Session; onDragStart: () => void }): ReactNode {
  const openTask = useStore((s) => s.openTask)
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)
  const openId = useStore((s) => s.boardTaskId)
  const agent = config?.agent[session.agentId]
  const related = (session.relatedSessionIds ?? [])
    .map((id) => sessions.find((other) => other.id === id))
    .filter((other): other is Session => Boolean(other))

  return (
    <div
      // A running card is not draggable: its column is a reading of the turn,
      // and the turn is not finished. Stop it from the chat to move it.
      draggable={isDraggable(session)}
      onDragStart={(event) => {
        event.dataTransfer.setData('text/plain', session.id)
        event.dataTransfer.effectAllowed = 'move'
        onDragStart()
      }}
      onClick={() => void openTask(session.id)}
      className={clsx(
        'group flex cursor-pointer overflow-hidden rounded-md border transition-colors',
        session.id === openId
          ? 'border-brand/60 bg-ink-800'
          : 'border-ink-800 bg-ink-850 hover:border-ink-700'
      )}
    >
      <span className={clsx('w-[3px] shrink-0', accentFor(session))} />
      <div className="min-w-0 flex-1 px-2.5 py-2">
        <div className="text-ink-100 line-clamp-3 text-[12.5px] leading-[1.45]">{session.title}</div>

        {session.blockedReason ? (
          <div className="text-warn mt-1.5 line-clamp-2 text-[10.5px] leading-[1.4]">
            {session.blockedReason}
          </div>
        ) : null}

        {related.length > 0 ? (
          <div
            title={related.map((other) => other.title).join('\n')}
            className="text-violet mt-1.5 flex items-center gap-1 text-[10px]"
          >
            <Link2 className="h-2.5 w-2.5 shrink-0" />
            <span className="truncate">
              shares work with {related.length === 1 ? related[0].title : `${related.length} tasks`}
            </span>
          </div>
        ) : null}

        <div className="mt-2 flex items-center gap-2">
          <StatusBadge session={session} />
          <span className="ml-auto flex items-center gap-1.5">
            {agent ? (
              <span
                title={agent.name}
                style={{ backgroundColor: agent.color ?? undefined }}
                className="text-ink-950 flex h-4 w-4 items-center justify-center rounded-full text-[9px] font-medium"
              >
                {agent.name.slice(0, 1).toUpperCase()}
              </span>
            ) : (
              <UserRound className="text-ink-600 h-3 w-3" />
            )}
          </span>
        </div>
      </div>
    </div>
  )
}

/** A parent card's subtasks, boxed together the way a story groups them. */
function StoryGroup({ story, onDragStart }: { story: Story; onDragStart: (id: string) => void }): ReactNode {
  const openTask = useStore((s) => s.openTask)
  if (!story.parent) {
    return (
      <>
        {story.items.map((card) => (
          <Card key={card.id} session={card} onDragStart={() => onDragStart(card.id)} />
        ))}
      </>
    )
  }
  return (
    <div className="border-ink-800 bg-ink-900/60 rounded-md border p-1.5">
      <button
        type="button"
        onClick={() => void openTask(story.parent!.id)}
        className="text-ink-400 hover:text-ink-200 mb-1.5 flex w-full items-center gap-1.5 px-1 text-left text-[10.5px]"
      >
        <span className="bg-violet/70 h-2 w-2 shrink-0 rounded-[3px]" />
        <span className="truncate">{story.parent.title}</span>
      </button>
      <div className="space-y-1.5">
        {story.items.map((card) => (
          <Card key={card.id} session={card} onDragStart={() => onDragStart(card.id)} />
        ))}
      </div>
    </div>
  )
}

/* ---------------- columns ---------------- */

function Column({
  column,
  cards,
  all,
  onDrop,
  onDragStart,
  onAdd,
  dragging
}: {
  column: BoardColumn
  cards: Session[]
  all: Session[]
  onDrop: (columnId: string) => void
  onDragStart: (id: string) => void
  onAdd: (columnId: string) => void
  dragging: boolean
}): ReactNode {
  const [over, setOver] = useState(false)
  const stories = useMemo(() => storiesInColumn(cards, column.id, all), [cards, column.id, all])
  const count = cards.filter((card) => card.columnId === column.id).length
  const overLimit = column.wipLimit !== undefined && count > column.wipLimit
  // In progress and Blocked are set by what the chat is doing, never by hand.
  const manual = isManualColumn(column.kind)

  return (
    <div
      onDragOver={(event: DragEvent) => {
        if (!manual) {
          event.dataTransfer.dropEffect = 'none'
          return
        }
        event.preventDefault()
        event.dataTransfer.dropEffect = 'move'
        if (!over) setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        if (!manual) return
        event.preventDefault()
        setOver(false)
        onDrop(column.id)
      }}
      className={clsx(
        'flex w-[228px] shrink-0 flex-col rounded-lg border transition-colors',
        over && dragging && manual
          ? 'border-brand/60 bg-ink-850/60'
          : dragging && !manual
            ? 'border-ink-800 bg-ink-900/40 opacity-50'
            : 'border-ink-800 bg-ink-900/40'
      )}
    >
      <div className="border-ink-800 flex items-center gap-2 border-b px-3 py-2">
        <span className="text-ink-300 text-[11px] font-medium tracking-[0.06em] uppercase">
          {column.name}
        </span>
        {count > 0 ? (
          <span
            className={clsx(
              'rounded px-1.5 py-[1px] text-[10px]',
              overLimit ? 'bg-warn/20 text-warn' : 'bg-ink-800 text-ink-400'
            )}
            title={overLimit ? `Over the limit of ${column.wipLimit}` : undefined}
          >
            {count}
          </span>
        ) : null}
        {manual ? (
          <button
            type="button"
            onClick={() => onAdd(column.id)}
            title={`New task in ${column.name}`}
            className="text-ink-600 hover:text-ink-200 ml-auto rounded p-0.5"
          >
            <Plus className="h-3.5 w-3.5" />
          </button>
        ) : (
          <span
            title="Cards arrive here on their own, from what the chat is doing"
            className="text-ink-700 ml-auto text-[10px]"
          >
            auto
          </span>
        )}
      </div>

      <div className="min-h-[120px] flex-1 space-y-1.5 overflow-y-auto p-1.5">
        {stories.length === 0 ? (
          <div className="text-ink-700 px-2 py-6 text-center text-[11px] leading-[1.5]">
            {column.kind === 'todo'
              ? 'Nothing queued'
              : column.kind === 'in-progress'
                ? 'Nothing running'
                : column.kind === 'blocked'
                  ? 'Nothing waiting on you'
                  : 'Empty'}
          </div>
        ) : (
          stories.map((story) => (
            <StoryGroup key={story.key} story={story} onDragStart={onDragStart} />
          ))
        )}
      </div>
    </div>
  )
}

/* ---------------- board picker ---------------- */

function BoardPicker({ boards, active }: { boards: Board[]; active: Board | undefined }): ReactNode {
  const selectBoard = useStore((s) => s.selectBoard)
  const config = useStore((s) => s.config)
  const activeSessionCwd = useStore((s) => s.sessions[0]?.cwd)
  const [open, setOpen] = useState(false)

  const byFolder = useMemo(() => {
    const map = new Map<string, Board[]>()
    for (const board of boards) {
      const list = map.get(board.cwd) ?? []
      list.push(board)
      map.set(board.cwd, list)
    }
    return [...map.entries()]
  }, [boards])

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={active ? 'Switch board' : undefined}
        className="text-ink-100 hover:bg-ink-800 flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px]"
      >
        {/* When a board is open its name is the editable title beside this, so
            the switcher is just the switcher and the name appears once. */}
        {active ? <SquareKanban className="text-ink-400 h-3.5 w-3.5" /> : 'All boards'}
        <ChevronDown className="text-ink-500 h-3.5 w-3.5" />
      </button>

      {open ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="border-ink-700 bg-ink-850 absolute left-0 top-8 z-50 w-72 rounded-lg border p-1 shadow-2xl">
            <button
              type="button"
              onClick={() => {
                selectBoard(null)
                setOpen(false)
              }}
              className="text-ink-200 hover:bg-ink-800 flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]"
            >
              <span className="flex-1">All boards</span>
              {!active ? <Check className="text-brand h-3.5 w-3.5" /> : null}
            </button>

            {byFolder.map(([cwd, list]) => (
              <div key={cwd} className="mt-1">
                <div className="text-ink-600 px-2.5 py-1 text-[10px] tracking-[0.06em] uppercase">
                  {folderName(cwd)}
                </div>
                {list.map((board) => (
                  <button
                    key={board.id}
                    type="button"
                    onClick={() => {
                      selectBoard(board.id)
                      setOpen(false)
                    }}
                    className="text-ink-200 hover:bg-ink-800 flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]"
                  >
                    <span className="flex-1 truncate">{board.name}</span>
                    {active?.id === board.id ? <Check className="text-brand h-3.5 w-3.5" /> : null}
                  </button>
                ))}
              </div>
            ))}

            <div className="bg-ink-800 my-1 h-px" />
            <button
              type="button"
              onClick={async () => {
                setOpen(false)
                const cwd = activeSessionCwd ?? config?.environment.local?.cwd
                const board = await window.opendesktop.boards.create({ cwd, environmentId: 'local' })
                selectBoard(board.id)
              }}
              className="text-ink-200 hover:bg-ink-800 flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]"
            >
              <Plus className="h-3.5 w-3.5" />
              New board
            </button>
          </div>
        </>
      ) : null}
    </div>
  )
}

/* ---------------- the board ---------------- */

export function BoardView(): ReactNode {
  const boards = useStore((s) => s.boards)
  const activeBoardId = useStore((s) => s.activeBoardId)
  const selectBoard = useStore((s) => s.selectBoard)
  const sessions = useStore((s) => s.sessions)
  const config = useStore((s) => s.config)

  const [dragging, setDragging] = useState<string | null>(null)
  const openTask = useStore((s) => s.openTask)

  /**
   * A new task is an empty chat on the board, opened in the panel. There is no
   * form in between: everything a form would have asked — which agent, which
   * host, which model — the composer already asks better, and the title names
   * itself from the first message.
   */
  const addTask = async (boardId: string, columnId: string): Promise<void> => {
    const created = await window.opendesktop.boards.createTask({ boardId, columnId })
    if (created) await openTask(created.id)
  }

  const board = boards.find((candidate) => candidate.id === activeBoardId)
  const columns = useMemo(() => columnsFor(board, boards), [board, boards])

  /**
   * On the overview a card is placed by the *kind* of the column it sits in on
   * its own board, since the overview's columns are kinds rather than ids.
   */
  const cards = useMemo(() => {
    const raw = cardsOnBoard(sessions, board ? board.id : ALL_BOARDS)
    if (board) return raw
    return raw.map((session) => ({ ...session, columnId: overviewColumnId(session, boards) }))
  }, [sessions, board, boards])

  const move = async (columnId: string): Promise<void> => {
    if (!dragging) return
    const session = sessions.find((candidate) => candidate.id === dragging)
    setDragging(null)
    if (!session) return
    // On the overview the card keeps its own board; the column kind picks the
    // matching column there, so a drag means the same thing in both views.
    const targetBoard = board ?? boards.find((candidate) => candidate.id === session.boardId)
    if (!targetBoard) return
    const target = board
      ? columnId
      : targetBoard.columns.find((column) => column.kind === columnId)?.id
    if (!target) return
    await window.opendesktop.boards.moveTask({
      sessionId: session.id,
      boardId: targetBoard.id,
      columnId: target
    })
  }

  if (boards.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
        <div className="text-ink-300 text-[13.5px]">No boards yet.</div>
        <div className="text-ink-600 max-w-sm text-[12px] leading-[1.6]">
          A board turns chats into tasks you can queue. Cards move themselves as work starts,
          needs you, or finishes — and each card is a real chat you can open.
        </div>
        <Button
          variant="primary"
          onClick={async () => {
            const cwd = sessions[0]?.cwd ?? config?.environment.local?.cwd
            const board = await window.opendesktop.boards.create({ cwd, environmentId: 'local' })
            selectBoard(board.id)
          }}
        >
          <Plus className="h-3.5 w-3.5" />
          New board
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-ink-800 flex shrink-0 items-center gap-2 border-b px-3 py-2">
        <BoardPicker boards={boards} active={board} />
        {board ? (
          <EditableTitle
            value={board.name}
            title="Click to rename this board"
            onCommit={(name) => void window.opendesktop.boards.update(board.id, { name })}
            className="text-ink-100 text-[13px] font-medium"
            inputClassName="text-[13px] font-medium w-44"
          />
        ) : null}
        <span className="text-ink-600 text-[11.5px]">
          {cards.length} task{cards.length === 1 ? '' : 's'}
          {board ? ` · ${folderName(board.cwd)}` : ' · every board'}
        </span>

        <div className="ml-auto flex items-center gap-1">
          <Button
            size="sm"
            onClick={() => {
              const target = board ?? boards[0]
              const column = target.columns.find((c) => c.kind === 'todo') ?? target.columns[0]
              void addTask(target.id, column.id)
            }}
          >
            <Plus className="h-3.5 w-3.5" />
            New task
          </Button>
          {board ? (
            <Button
              size="sm"
              variant="danger"
              title="Delete this board. Its tasks stay as chats."
              onClick={async () => {
                await window.opendesktop.boards.remove(board.id)
                selectBoard(null)
              }}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          ) : null}
        </div>
      </div>

      <div className="flex min-h-0 flex-1">
        <div className="flex min-h-0 flex-1 gap-2 overflow-x-auto p-2">
          {columns.map((column) => (
          <Column
            key={column.id}
            column={column}
            cards={cards}
            all={cards}
            dragging={dragging !== null}
            onDragStart={setDragging}
            onDrop={(columnId) => void move(columnId)}
            onAdd={(columnId) => {
              // On the overview the columns are kinds, so the card goes to the
              // matching column of whichever board is in view underneath.
              const target = board ?? boards[0]
              const real = board
                ? columnId
                : (target.columns.find((c) => c.kind === columnId) ?? target.columns[0]).id
              void addTask(target.id, real)
            }}
          />
          ))}
        </div>
        <TaskPanel />
      </div>
    </div>
  )
}
