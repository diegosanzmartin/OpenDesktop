import clsx from 'clsx'
import { useMemo, type ReactNode } from 'react'
import { LayoutGrid, SquareKanban } from 'lucide-react'
import { useStore } from '../state/store'
import { folderName } from '../lib/format'

/** Boards grouped by the folder they belong to, plus the overview at the top. */
export function BoardList(): ReactNode {
  const boards = useStore((s) => s.boards)
  const activeBoardId = useStore((s) => s.activeBoardId)
  const selectBoard = useStore((s) => s.selectBoard)
  const sessions = useStore((s) => s.sessions)

  const counts = useMemo(() => {
    const map: Record<string, number> = {}
    for (const session of sessions) {
      if (session.boardId) map[session.boardId] = (map[session.boardId] ?? 0) + 1
    }
    return map
  }, [sessions])

  const byFolder = useMemo(() => {
    const map = new Map<string, typeof boards>()
    for (const board of boards) {
      const list = map.get(board.cwd) ?? []
      list.push(board)
      map.set(board.cwd, list)
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [boards])

  const total = Object.values(counts).reduce((sum, count) => sum + count, 0)

  return (
    <div>
      <button
        type="button"
        onClick={() => selectBoard(null)}
        className={clsx(
          'mt-3 flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-[13px]',
          activeBoardId === null ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850'
        )}
      >
        <LayoutGrid className="h-3.5 w-3.5 shrink-0" />
        <span className="flex-1 text-left">All boards</span>
        {total > 0 ? <span className="text-ink-600 text-[11px]">{total}</span> : null}
      </button>

      {byFolder.map(([cwd, list]) => (
        <div key={cwd} className="mb-1">
          <div className="text-ink-500 px-1 pb-1 pt-3 text-[11.5px]">{folderName(cwd)}</div>
          {list.map((board) => (
            <button
              key={board.id}
              type="button"
              onClick={() => selectBoard(board.id)}
              className={clsx(
                'flex w-full items-center gap-2 rounded-md px-2 py-[5px] text-[13px]',
                board.id === activeBoardId ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850'
              )}
            >
              <SquareKanban className="h-3.5 w-3.5 shrink-0" />
              <span className="min-w-0 flex-1 truncate text-left">{board.name}</span>
              {counts[board.id] ? (
                <span className="text-ink-600 text-[11px]">{counts[board.id]}</span>
              ) : null}
            </button>
          ))}
        </div>
      ))}

      {boards.length === 0 ? (
        <div className="text-ink-600 px-1 py-4 text-[12px] leading-[1.5]">
          No boards yet. Create one to queue tasks instead of running them one at a time.
        </div>
      ) : null}
    </div>
  )
}
