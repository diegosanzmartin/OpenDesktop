import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { nanoid } from 'nanoid'
import type { Board, BoardColumn } from '@shared/types'
import { defaultColumns } from '@shared/boards'
import { DATA_DIR } from './config'
import { bus } from './bus'

/**
 * Boards are small and few, so they live in one file rather than a directory
 * of them. Sessions keep pointing at a board by id; the board never holds the
 * list of its cards, which means moving a card is a session update and cannot
 * leave the two sides disagreeing.
 */
const BOARDS_PATH = join(DATA_DIR, 'boards.json')

const boards = new Map<string, Board>()

export function loadBoards(): void {
  if (!existsSync(BOARDS_PATH)) return
  try {
    const parsed = JSON.parse(readFileSync(BOARDS_PATH, 'utf8')) as { boards: Board[] }
    for (const board of parsed.boards ?? []) boards.set(board.id, board)
  } catch {
    /* a corrupt board file should not stop the app from starting */
  }
}

function save(): void {
  mkdirSync(dirname(BOARDS_PATH), { recursive: true })
  writeFileSync(BOARDS_PATH, JSON.stringify({ version: 1, boards: [...boards.values()] }, null, 2), 'utf8')
}

export function listBoards(): Board[] {
  return [...boards.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function getBoard(id: string): Board | undefined {
  return boards.get(id)
}

export function createBoard(input: {
  name?: string
  cwd: string
  environmentId: string
  columns?: BoardColumn[]
}): Board {
  const now = Date.now()
  const board: Board = {
    id: nanoid(10),
    name: input.name?.trim() || 'Board',
    cwd: input.cwd,
    environmentId: input.environmentId,
    columns: input.columns ?? defaultColumns(),
    createdAt: now,
    updatedAt: now
  }
  boards.set(board.id, board)
  save()
  bus.emit({ type: 'board.updated', board })
  return board
}

export function updateBoard(id: string, patch: Partial<Board>): Board | undefined {
  const board = boards.get(id)
  if (!board) return undefined
  Object.assign(board, patch, { id: board.id, updatedAt: Date.now() })
  save()
  bus.emit({ type: 'board.updated', board })
  return board
}

export function deleteBoard(id: string): void {
  if (!boards.delete(id)) return
  save()
  bus.emit({ type: 'board.deleted', boardId: id })
}

/** The board a new task lands on when the user has not picked one. */
export function defaultBoardFor(cwd: string, environmentId: string): Board {
  const existing = listBoards().find(
    (board) => board.cwd === cwd && board.environmentId === environmentId && !board.archived
  )
  return existing ?? createBoard({ name: cwd.split('/').filter(Boolean).pop() || 'Board', cwd, environmentId })
}
