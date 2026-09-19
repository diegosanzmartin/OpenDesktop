import clsx from 'clsx'
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode
} from 'react'
import {
  Archive,
  ArchiveRestore,
  Check,
  ChevronRight,
  CircleCheck,
  CircleSlash,
  Columns3,
  FolderOpen,
  GitBranch,
  GitFork,
  MoreVertical,
  Pencil,
  Pin,
  PinOff,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import type { Session } from '@shared/types'
import { columnOfKind } from '@shared/boards'
import { useStore } from '../state/store'
import { couldHaveWorktree, giveWorktree, returnFromWorktree } from '../lib/worktree'
import { folderName } from '../lib/format'
import { DiffSquare } from './icons'

interface Item {
  key: string
  label: string
  icon?: ReactNode
  /** The letter that runs it while the menu is open, as in the reference. */
  shortcut?: string
  danger?: boolean
  onSelect?: () => void
  submenu?: Item[]
  checked?: boolean
  separatorBefore?: boolean
}

function Row({
  item,
  open,
  onOpen,
  onRun
}: {
  item: Item
  open: boolean
  onOpen: () => void
  onRun: (item: Item) => void
}): ReactNode {
  const hasSub = Boolean(item.submenu)
  return (
    <div className="relative">
      <button
        type="button"
        onMouseEnter={onOpen}
        onClick={() => (hasSub ? onOpen() : onRun(item))}
        className={clsx(
          'flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]',
          item.danger ? 'text-bad hover:bg-bad/10' : open ? 'bg-ink-800 text-ink-100' : 'text-ink-200 hover:bg-ink-800'
        )}
      >
        {item.icon ? <span className="text-ink-500 shrink-0">{item.icon}</span> : null}
        <span className="flex-1 truncate">{item.label}</span>
        {item.checked ? <Check className="text-brand h-3.5 w-3.5 shrink-0" /> : null}
        {item.shortcut ? <span className="text-ink-600 shrink-0 text-[11.5px]">{item.shortcut}</span> : null}
        {hasSub ? <ChevronRight className="text-ink-600 h-3.5 w-3.5 shrink-0" /> : null}
      </button>

      {open && item.submenu ? (
        <div className="border-ink-700 bg-ink-850 absolute left-full top-[-5px] z-10 ml-1 max-h-[360px] w-56 overflow-y-auto rounded-lg border p-1 shadow-2xl">
          {item.submenu.map((child) => (
            <button
              key={child.key}
              type="button"
              onClick={() => onRun(child)}
              className="text-ink-200 hover:bg-ink-800 flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]"
            >
              {child.icon ? <span className="text-ink-500 shrink-0">{child.icon}</span> : null}
              <span className="flex-1 truncate">{child.label}</span>
              {child.checked ? <Check className="text-brand h-3.5 w-3.5 shrink-0" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** Everything you can do to one session, from its row in the list. */
export function SessionMenu({ session }: { session: Session }): ReactNode {
  const boards = useStore((s) => s.boards)
  const openDock = useStore((s) => s.openDock)
  const selectSession = useStore((s) => s.selectSession)
  const startRename = useStore((s) => s.startRename)
  const setView = useStore((s) => s.setView)
  const selectBoard = useStore((s) => s.selectBoard)
  const openTask = useStore((s) => s.openTask)

  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<string | null>(null)
  const [anchor, setAnchor] = useState({ top: 0, left: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  // Portalled, because the session list scrolls and a scroll container clips
  // both axes — the submenus would be cut off at the sidebar's edge.
  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    const width = 232
    setAnchor({
      top: Math.min(rect.bottom + 4, window.innerHeight - 380),
      left: Math.min(rect.left, window.innerWidth - width - 264)
    })
  }, [open])

  const patch = (next: Partial<Session>): void => {
    void window.opendesktop.sessions.update(session.id, next)
  }

  const board = boards.find((candidate) => candidate.id === session.boardId)
  const workspacesRoot = useStore((s) => s.workspacesRoot)

  const items: Item[] = [
    {
      key: 'open-in',
      label: 'Open in',
      submenu: [
        {
          key: 'terminal',
          label: 'Terminal',
          icon: <SquareTerminal className="h-3.5 w-3.5" />,
          onSelect: () => {
            void selectSession(session.id)
            openDock('terminal')
          }
        },
        {
          key: 'files',
          label: 'Files',
          icon: <FolderOpen className="h-3.5 w-3.5" />,
          onSelect: () => {
            void selectSession(session.id)
            openDock('files')
          }
        },
        {
          key: 'changes',
          label: 'Changes',
          icon: <DiffSquare className="h-3.5 w-3.5" />,
          onSelect: () => {
            void selectSession(session.id)
            openDock('changes')
          }
        },
        // Only for local work: the path belongs to the remote machine otherwise.
        ...(session.environmentId === 'local'
          ? [
              {
                key: 'finder',
                label: 'Finder',
                icon: <FolderOpen className="h-3.5 w-3.5" />,
                onSelect: () => void window.opendesktop.host.openPath(session.cwd)
              }
            ]
          : []),
        ...(board
          ? [
              {
                key: 'board',
                label: `Board · ${board.name}`,
                icon: <Columns3 className="h-3.5 w-3.5" />,
                onSelect: () => {
                  selectBoard(board.id)
                  setView('board')
                  void openTask(session.id)
                }
              }
            ]
          : [])
      ]
    },
    {
      key: 'pin',
      label: session.pinned ? 'Unpin' : 'Pin',
      shortcut: 'P',
      separatorBefore: true,
      icon: session.pinned ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />,
      onSelect: () => patch({ pinned: !session.pinned })
    },
    {
      key: 'complete',
      label: session.status === 'done' ? 'Mark as not completed' : 'Mark as completed',
      shortcut: 'U',
      icon:
        session.status === 'done' ? (
          <CircleSlash className="h-3.5 w-3.5" />
        ) : (
          <CircleCheck className="h-3.5 w-3.5" />
        ),
      onSelect: () => patch({ status: session.status === 'done' ? 'idle' : 'done' })
    },
    {
      key: 'rename',
      label: 'Rename',
      shortcut: 'R',
      icon: <Pencil className="h-3.5 w-3.5" />,
      onSelect: () => startRename(session.id)
    },
    {
      key: 'fork',
      label: 'Fork',
      shortcut: 'F',
      icon: <GitFork className="h-3.5 w-3.5" />,
      onSelect: async () => {
        const forked = await window.opendesktop.sessions.fork(session.id)
        if (forked) await selectSession(forked.id)
      }
    },
    {
      key: 'fork-to',
      label: 'Fork onto board',
      icon: <GitFork className="h-3.5 w-3.5" />,
      submenu:
        boards.length === 0
          ? [{ key: 'none', label: 'No boards yet' }]
          : boards.map((candidate) => ({
              key: candidate.id,
              label: `${candidate.name} · ${folderName(candidate.cwd)}`,
              onSelect: async () => {
                const column = columnOfKind(candidate, 'backlog') ?? candidate.columns[0]
                const forked = await window.opendesktop.sessions.fork(session.id, {
                  boardId: candidate.id,
                  columnId: column.id
                })
                if (!forked) return
                selectBoard(candidate.id)
                setView('board')
                await openTask(forked.id)
              }
            }))
    },
    /*
     * A checkout of its own, which is the strong version of everything else
     * this app does about two agents in one repository: not a warning that
     * they are in the same file, but two different files on two branches.
     * Offered rather than default — see `worktree.ts` for what it costs.
     */
    ...(session.worktree
      ? [
          {
            key: 'worktree-off',
            label: `Return to ${folderName(session.worktree.repoRoot)}`,
            separatorBefore: true,
            icon: <GitBranch className="h-3.5 w-3.5" />,
            onSelect: () => void returnFromWorktree(session)
          }
        ]
      : couldHaveWorktree(session, workspacesRoot)
        ? [
            {
              key: 'worktree-on',
              label: 'Work on a branch of its own',
              separatorBefore: true,
              icon: <GitBranch className="h-3.5 w-3.5" />,
              onSelect: () => void giveWorktree(session)
            }
          ]
        : []),
    {
      key: 'board',
      label: 'Board',
      shortcut: 'B',
      separatorBefore: true,
      icon: <Columns3 className="h-3.5 w-3.5" />,
      submenu: [
        {
          key: 'none',
          label: 'None — just a chat',
          checked: !session.boardId,
          onSelect: () => void window.opendesktop.boards.removeSession(session.id)
        },
        ...boards.map((candidate) => ({
          key: candidate.id,
          label: `${candidate.name} · ${folderName(candidate.cwd)}`,
          checked: session.boardId === candidate.id,
          onSelect: () =>
            void window.opendesktop.boards.addSession({
              sessionId: session.id,
              boardId: candidate.id
            })
        }))
      ]
    },
    {
      key: 'archive',
      label: session.archived ? 'Unarchive' : 'Archive',
      shortcut: 'A',
      separatorBefore: true,
      icon: session.archived ? (
        <ArchiveRestore className="h-3.5 w-3.5" />
      ) : (
        <Archive className="h-3.5 w-3.5" />
      ),
      onSelect: () => patch({ archived: !session.archived })
    },
    {
      key: 'delete',
      label: 'Delete',
      shortcut: 'D',
      danger: true,
      icon: <Trash2 className="h-3.5 w-3.5" />,
      onSelect: () => void window.opendesktop.sessions.remove(session.id)
    }
  ]

  const close = (): void => {
    setOpen(false)
    setSubmenu(null)
  }

  const run = (item: Item): void => {
    if (!item.onSelect) return
    close()
    void item.onSelect()
  }

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!button.current?.contains(target) && !panel.current?.contains(target)) close()
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        close()
        return
      }
      // The letters in the reference are accelerators, live while it is open.
      const hit = items.find(
        (item) => item.shortcut && item.shortcut.toLowerCase() === event.key.toLowerCase()
      )
      if (hit && !hit.submenu) {
        event.preventDefault()
        run(hit)
      } else if (hit) {
        event.preventDefault()
        setSubmenu(hit.key)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  })

  return (
    <>
      <button
        ref={button}
        type="button"
        title="More"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(!open)
          setSubmenu(null)
        }}
        className={clsx(
          'shrink-0 rounded p-0.5',
          open ? 'text-ink-100' : 'text-ink-600 hover:text-ink-200 opacity-0 group-hover:opacity-100'
        )}
      >
        <MoreVertical className="h-3.5 w-3.5" />
      </button>

      {open ? (
        <div
          ref={panel}
          style={{ top: anchor.top, left: anchor.left }}
          onClick={(event) => event.stopPropagation()}
          className="border-ink-700 bg-ink-850 fixed z-[60] w-58 rounded-lg border p-1 shadow-2xl"
        >
          {items.map((item) => (
            <div key={item.key}>
              {item.separatorBefore ? <div className="bg-ink-800 my-1 h-px" /> : null}
              <Row
                item={item}
                open={submenu === item.key}
                onOpen={() => setSubmenu(item.submenu ? item.key : null)}
                onRun={run}
              />
            </div>
          ))}
        </div>
      ) : null}
    </>
  )
}
