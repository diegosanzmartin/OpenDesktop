import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import {
  Activity,
  Plus,
  GitBranch,
  Pin,
  Settings as SettingsIcon
} from 'lucide-react'
import type { Session } from '@shared/types'
import { useStore } from '../state/store'
import { filterSessions, groupSessions, sortSessions } from '../lib/group'
import { nestSubtasks, splitPinned } from '@shared/sessions'
import { SessionMenu } from './SessionMenu'
import { EditableTitle } from './EditableTitle'
import { SessionFilters } from './SessionFilters'
import { ViewSwitcher } from './ViewSwitcher'
import { BoardList } from './BoardList'

/** Branch and dirty count, only when the option is on. */
function GitChip({ session }: { session: Session }): ReactNode {
  const summary = useStore((s) => s.gitSummaries[`${session.environmentId}:${session.cwd}`])
  if (!summary?.isRepo) return null
  return (
    <span
      title={`${summary.branch}${summary.dirty > 0 ? ` · ${summary.dirty} changed` : ' · clean'}`}
      className="text-ink-600 flex shrink-0 items-center gap-1 text-[10px] group-hover:hidden"
    >
      <GitBranch className="h-2.5 w-2.5" />
      <span className="max-w-[64px] truncate">{summary.branch}</span>
      {summary.dirty > 0 ? <span className="text-warn">{summary.dirty}</span> : null}
    </span>
  )
}

function SessionDot({ status }: { status: Session['status'] }): ReactNode {
  if (status === 'running') {
    return <span className="bg-brand relative h-[7px] w-[7px] shrink-0 rounded-full" />
  }
  if (status === 'awaiting-approval' || status === 'blocked') {
    return <span className="bg-warn h-[7px] w-[7px] shrink-0 rounded-full" />
  }
  if (status === 'queued') {
    return <span className="border-ink-500 h-[7px] w-[7px] shrink-0 rounded-full border border-dashed" />
  }
  if (status === 'done') {
    return <span className="bg-ok/70 h-[7px] w-[7px] shrink-0 rounded-full" />
  }
  if (status === 'error') {
    return <span className="bg-bad h-[7px] w-[7px] shrink-0 rounded-full" />
  }
  return <span className="border-ink-600 h-[7px] w-[7px] shrink-0 rounded-full border" />
}

/** One session in the list: its state, its title, and everything you can do to it. */
function SessionRow({ session, depth }: { session: Session; depth: number }): ReactNode {
  const activeId = useStore((s) => s.activeSessionId)
  const select = useStore((s) => s.selectSession)
  const showGit = useStore((s) => s.sessionQuery.showGitStatus)
  const renaming = useStore((s) => s.renamingSessionId === session.id)
  const startRename = useStore((s) => s.startRename)

  return (
    <div
      onClick={() => void select(session.id)}
      style={depth > 0 ? { paddingLeft: 8 + depth * 12 } : undefined}
      className={clsx(
        'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px]',
        session.id === activeId ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850'
      )}
    >
      {/* A subtask is marked as one so the indent is not the only clue. */}
      {depth > 0 ? <span className="bg-ink-700 -ml-1 h-3 w-px shrink-0" aria-hidden /> : null}
      <SessionDot status={session.status} />

      {renaming ? (
        <EditableTitle
          autoEdit
          value={session.title}
          onDone={() => startRename(null)}
          onCommit={(title) => void window.opendesktop.sessions.update(session.id, { title })}
          inputClassName="min-w-0 flex-1 text-[13px]"
        />
      ) : (
        <span className="min-w-0 flex-1 truncate text-[13px]">
          {session.taskLabel ?? session.title}
        </span>
      )}

      {session.pinned ? <Pin className="text-ink-600 h-2.5 w-2.5 shrink-0" /> : null}
      {showGit ? <GitChip session={session} /> : null}
      <SessionMenu session={session} />
    </div>
  )
}

function NavItem({
  icon,
  label,
  onClick,
  active
}: {
  icon: ReactNode
  label: string
  onClick: () => void
  active?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[6px] text-[13px] transition-colors',
        active ? 'bg-ink-800 text-ink-100' : 'text-ink-300 hover:bg-ink-850 hover:text-ink-100'
      )}
    >
      {icon}
      {label}
    </button>
  )
}

export function Sidebar(): ReactNode {
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeSessionId)
  const select = useStore((s) => s.selectSession)
  const newSession = useStore((s) => s.newSession)
  const query = useStore((s) => s.sessionQuery)
  const setQuery = useStore((s) => s.setSessionQuery)
  const config = useStore((s) => s.config)
  const showGit = useStore((s) => s.sessionQuery.showGitStatus)
  const refreshGit = useStore((s) => s.refreshGitSummaries)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const openDock = useStore((s) => s.openDock)

  const searchOpen = useStore((s) => s.searchOpen)
  const toggleSearch = useStore((s) => s.toggleSearch)
  const view = useStore((s) => s.view)

  const labels = useMemo(
    () => ({
      environments: Object.fromEntries(
        Object.values(config?.environment ?? {}).map((e) => [e.id, e.name])
      ),
      agents: Object.fromEntries(Object.values(config?.agent ?? {}).map((a) => [a.id, a.name]))
    }),
    [config]
  )

  // Pinned rows are hoisted out before grouping: pinning is for not having to
  // look, which a heading three groups down would undo.
  const { pinned, groups } = useMemo(() => {
    const ordered = sortSessions(filterSessions(sessions, query), query.sortBy)
    const split = splitPinned(ordered)
    return { pinned: split.pinned, groups: groupSessions(split.rest, query, labels) }
  }, [sessions, query, labels])

  useEffect(() => {
    if (showGit) void refreshGit()
  }, [showGit, sessions.length, refreshGit])

  if (collapsed) return null

  return (
    <aside className="bg-ink-900 flex w-[248px] shrink-0 flex-col pt-1">
      <ViewSwitcher />

      {searchOpen && view === 'chat' ? (
        <div className="px-2.5 pb-1.5">
          <input
            autoFocus
            value={query.search}
            onChange={(event) => setQuery({ search: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') toggleSearch()
            }}
            placeholder="Filter sessions"
            className="border-ink-700 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-full rounded-md border px-2 py-1 text-[12px] outline-none"
          />
        </div>
      ) : null}

      <nav className="space-y-[2px] px-2.5 pb-2">
        {view === 'board' ? (
          <NavItem
            icon={<Plus className="h-4 w-4" />}
            label="New board"
            onClick={async () => {
              const board = await window.opendesktop.boards.create({
                cwd: sessions[0]?.cwd,
                environmentId: sessions[0]?.environmentId ?? 'local'
              })
              useStore.getState().selectBoard(board.id)
            }}
          />
        ) : (
          <NavItem
            icon={<Plus className="h-4 w-4" />}
            label="New session"
            onClick={() => void newSession()}
          />
        )}
        <NavItem
          icon={<Activity className="h-4 w-4" />}
          label="Activity"
          onClick={() => openDock('activity')}
        />
        <NavItem
          icon={<SettingsIcon className="h-4 w-4" />}
          label="Settings"
          onClick={() => setSettingsOpen(true)}
        />
      </nav>

      <div className="min-h-0 flex-1 overflow-y-auto px-2.5 pb-3">
        {view === 'board' ? (
          <BoardList />
        ) : groups.length === 0 && pinned.length === 0 ? (
          <div className="text-ink-600 px-1 py-4 text-[12px]">No sessions match this filter.</div>
        ) : (
          <>
            {pinned.length > 0 ? (
              <div className="mb-1">
                <div className="flex items-center gap-1 px-1 pb-1 pt-3">
                  <span className="text-ink-500 text-[11.5px]">Pinned</span>
                  <div className="ml-auto">
                    <SessionFilters />
                  </div>
                </div>
                {nestSubtasks(pinned).map(({ session, depth }) => (
                  <SessionRow key={session.id} session={session} depth={depth} />
                ))}
              </div>
            ) : null}
            {groups.map((group, groupIndex) => (
            <div key={group.key} className="mb-1">
              <div className="flex items-center gap-1 px-1 pb-1 pt-3">
                <span className="text-ink-500 text-[11.5px]">{group.label || 'Sessions'}</span>
                {/* The filter sits in the first heading shown, whichever it is. */}
                {groupIndex === 0 && pinned.length === 0 ? (
                  <div className="ml-auto">
                    <SessionFilters />
                  </div>
                ) : null}
              </div>

                {nestSubtasks(group.items).map(({ session, depth }) => (
                  <SessionRow key={session.id} session={session} depth={depth} />
                ))}
              </div>
            ))}
          </>
        )}
      </div>

      <div className="flex items-center gap-2 px-3 py-2.5">
        <span className="bg-ink-700 text-ink-200 flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold">
          {(config?.agent && Object.keys(config.agent)[0]?.[0]?.toUpperCase()) ?? 'O'}
        </span>
        <span className="text-ink-300 text-[12px]">OpenDesktop</span>
        <span className="text-ink-600 text-[11px]">· local</span>
      </div>
    </aside>
  )
}
