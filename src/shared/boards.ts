import type { Board, BoardColumn, ColumnKind, Session, SessionStatus } from './types'

/**
 * The board's rules, kept pure and shared so the scheduler, the IPC layer, the
 * renderer and the headless tests all agree on what a column means.
 *
 * The column is the source of truth for intent ("this should run next"), the
 * status for reality ("this is running"). Moving a card sets the intent and the
 * scheduler catches up; a turn starting or finishing sets the reality and the
 * card follows. Keeping both and syncing them beats deriving one from the
 * other: a task can be queued in To do without being running, and a task can be
 * running while the user drags it somewhere else.
 */

/** The overview: every card from every board, in one set of columns. */
export const ALL_BOARDS = 'all'

export const COLUMN_KIND_LABEL: Record<ColumnKind, string> = {
  backlog: 'Backlog',
  todo: 'To do',
  'in-progress': 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done'
}

/** Mirrors the reference board: backlog, queue, running, stuck, finished. */
export function defaultColumns(): BoardColumn[] {
  return [
    { id: 'backlog', name: 'Backlog', kind: 'backlog' },
    { id: 'todo', name: 'To do', kind: 'todo' },
    { id: 'in-progress', name: 'In progress', kind: 'in-progress', wipLimit: 4 },
    { id: 'blocked', name: 'Blocked', kind: 'blocked' },
    { id: 'done', name: 'Done', kind: 'done' }
  ]
}

export function findColumn(board: Board, columnId: string | undefined): BoardColumn | undefined {
  return board.columns.find((column) => column.id === columnId)
}

/** The first column of a kind, for the automatic moves. */
export function columnOfKind(board: Board, kind: ColumnKind): BoardColumn | undefined {
  return board.columns.find((column) => column.kind === kind)
}

/**
 * The status a card takes when it lands in a column. Dropping into To do queues
 * it, into In progress starts it, into Done finishes it. A card that is already
 * running keeps running: the drag records where the human wants it, and the
 * scheduler is what actually stops or starts work.
 */
export function statusForColumn(kind: ColumnKind, current: SessionStatus): SessionStatus {
  switch (kind) {
    case 'todo':
      return current === 'running' ? 'running' : 'queued'
    case 'in-progress':
      return current === 'running' ? 'running' : 'queued'
    case 'blocked':
      return current === 'awaiting-approval' ? 'awaiting-approval' : 'blocked'
    case 'done':
      return current === 'running' ? 'running' : 'done'
    default:
      // Backlog and review are parked: nothing runs from there on its own.
      return current === 'running' ? 'running' : 'idle'
  }
}

/** Where a card belongs once its status changes underneath it. */
export function columnForStatus(board: Board, status: SessionStatus): BoardColumn | undefined {
  switch (status) {
    case 'running':
      return columnOfKind(board, 'in-progress')
    case 'queued':
      return columnOfKind(board, 'todo')
    case 'awaiting-approval':
    case 'blocked':
    case 'error':
      return columnOfKind(board, 'blocked')
    case 'done':
      return columnOfKind(board, 'done')
    default:
      return undefined
  }
}

export function cardsOnBoard(sessions: Session[], boardId: string): Session[] {
  if (boardId === ALL_BOARDS) return sessions.filter((session) => Boolean(session.boardId))
  return sessions.filter((session) => session.boardId === boardId)
}

export interface Story {
  /** The parent card, when it is on this board too. Absent for loose tasks. */
  parent?: Session
  key: string
  items: Session[]
}

/**
 * Cards in one column, grouped under their parent the way the reference board
 * groups subtasks under their story. A subtask whose story is not on this board
 * stands on its own rather than disappearing.
 */
export function storiesInColumn(cards: Session[], columnId: string, all: Session[]): Story[] {
  const inColumn = cards
    .filter((card) => card.columnId === columnId)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.createdAt - b.createdAt)

  const onBoard = new Set(all.map((card) => card.id))
  const stories: Story[] = []
  const byKey = new Map<string, Story>()

  for (const card of inColumn) {
    const parentId = card.parentSessionId
    if (!parentId || !onBoard.has(parentId)) {
      stories.push({ key: `solo:${card.id}`, items: [card] })
      continue
    }
    const existing = byKey.get(parentId)
    if (existing) {
      existing.items.push(card)
      continue
    }
    const story: Story = {
      key: `story:${parentId}`,
      parent: all.find((session) => session.id === parentId),
      items: [card]
    }
    byKey.set(parentId, story)
    stories.push(story)
  }
  return stories
}

/** Board columns, or the union of every board's columns for the overview. */
export function columnsFor(board: Board | undefined, boards: Board[]): BoardColumn[] {
  if (board) return board.columns
  const seen = new Map<ColumnKind, BoardColumn>()
  for (const other of boards) {
    for (const column of other.columns) {
      if (!seen.has(column.kind)) {
        seen.set(column.kind, { id: column.kind, name: COLUMN_KIND_LABEL[column.kind], kind: column.kind })
      }
    }
  }
  const order: ColumnKind[] = ['backlog', 'todo', 'in-progress', 'blocked', 'review', 'done']
  return order.filter((kind) => seen.has(kind)).map((kind) => seen.get(kind)!)
}

/**
 * On the overview the columns are kinds, not ids, so a card is placed by the
 * kind of whatever column it sits in on its own board.
 */
export function overviewColumnId(session: Session, boards: Board[]): string | undefined {
  const board = boards.find((candidate) => candidate.id === session.boardId)
  if (!board) return undefined
  return findColumn(board, session.columnId)?.kind
}
