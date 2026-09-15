import clsx from 'clsx'
import { useMemo, useState, type ReactNode } from 'react'
import {
  Activity,
  PanelLeft,
  Plus,
  Search,
  Settings as SettingsIcon,
  SlidersHorizontal,
  Trash2
} from 'lucide-react'
import type { Session } from '@shared/types'
import { useStore, type SessionGroupBy, type SessionSortBy } from '../state/store'
import { filterSessions, groupSessions, sortSessions } from '../lib/group'
import { Select } from './ui'

const GROUP_OPTIONS: { value: SessionGroupBy; label: string }[] = [
  { value: 'date', label: 'Date' },
  { value: 'none', label: 'No grouping' },
  { value: 'folder', label: 'Folder' },
  { value: 'status', label: 'Status' },
  { value: 'environment', label: 'Environment' },
  { value: 'agent', label: 'Agent' }
]

const SORT_OPTIONS: { value: SessionSortBy; label: string }[] = [
  { value: 'recent', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'title', label: 'Title' },
  { value: 'folder', label: 'Folder' },
  { value: 'status', label: 'Status' }
]

function SessionDot({ status }: { status: Session['status'] }): ReactNode {
  if (status === 'running') {
    return <span className="bg-brand relative h-[7px] w-[7px] shrink-0 rounded-full" />
  }
  if (status === 'awaiting-approval') {
    return <span className="bg-warn h-[7px] w-[7px] shrink-0 rounded-full" />
  }
  if (status === 'error') {
    return <span className="bg-bad h-[7px] w-[7px] shrink-0 rounded-full" />
  }
  return <span className="border-ink-600 h-[7px] w-[7px] shrink-0 rounded-full border" />
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
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const openDock = useStore((s) => s.openDock)

  const [searching, setSearching] = useState(false)
  const [filtersOpen, setFiltersOpen] = useState(false)

  const labels = useMemo(
    () => ({
      environments: Object.fromEntries(
        Object.values(config?.environment ?? {}).map((e) => [e.id, e.name])
      ),
      agents: Object.fromEntries(Object.values(config?.agent ?? {}).map((a) => [a.id, a.name]))
    }),
    [config]
  )

  const groups = useMemo(
    () => groupSessions(sortSessions(filterSessions(sessions, query), query.sortBy), query, labels),
    [sessions, query, labels]
  )

  if (collapsed) {
    return (
      <aside className="bg-ink-900 flex w-[52px] shrink-0 flex-col items-center">
        {/* The window's traffic lights sit over the first ~40px, so the strip
            starts below them. It doubles as a drag region. */}
        <div className="drag-region h-11 w-full shrink-0" />
        <button
          type="button"
          onClick={toggleSidebar}
          title="Show sidebar"
          className="text-ink-400 hover:bg-ink-800 hover:text-ink-100 rounded-md p-1.5"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => void newSession()}
          title="New session"
          className="text-ink-400 hover:bg-ink-800 hover:text-ink-100 mt-1 rounded-md p-1.5"
        >
          <Plus className="h-4 w-4" />
        </button>
      </aside>
    )
  }

  return (
    <aside className="bg-ink-900 flex w-[248px] shrink-0 flex-col">
      <div className="drag-region flex h-11 items-center gap-1 px-2.5 pl-[82px]">
        <button
          type="button"
          onClick={toggleSidebar}
          title="Hide sidebar"
          className="no-drag text-ink-400 hover:bg-ink-800 hover:text-ink-100 rounded-md p-1.5"
        >
          <PanelLeft className="h-4 w-4" />
        </button>
        <button
          type="button"
          onClick={() => setSearching(!searching)}
          title="Search sessions"
          className="no-drag text-ink-400 hover:bg-ink-800 hover:text-ink-100 rounded-md p-1.5"
        >
          <Search className="h-4 w-4" />
        </button>
      </div>

      {searching ? (
        <div className="px-2.5 pb-1.5">
          <input
            autoFocus
            value={query.search}
            onChange={(event) => setQuery({ search: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                setQuery({ search: '' })
                setSearching(false)
              }
            }}
            placeholder="Filter sessions"
            className="border-ink-700 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-full rounded-md border px-2 py-1 text-[12px] outline-none"
          />
        </div>
      ) : null}

      <nav className="space-y-[2px] px-2.5 pb-2">
        <NavItem icon={<Plus className="h-4 w-4" />} label="New session" onClick={() => void newSession()} />
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
        {groups.length === 0 ? (
          <div className="text-ink-600 px-1 py-4 text-[12px]">No sessions match this filter.</div>
        ) : (
          groups.map((group, groupIndex) => (
            <div key={group.key} className="mb-1">
              <div className="flex items-center gap-1 px-1 pb-1 pt-3">
                <span className="text-ink-500 text-[11.5px]">{group.label || 'Sessions'}</span>
                {groupIndex === 0 ? (
                  <button
                    type="button"
                    title="Grouping and sorting"
                    onClick={() => setFiltersOpen(!filtersOpen)}
                    className={clsx(
                      'ml-auto rounded p-0.5',
                      filtersOpen ? 'text-ink-200' : 'text-ink-600 hover:text-ink-300'
                    )}
                  >
                    <SlidersHorizontal className="h-3 w-3" />
                  </button>
                ) : null}
              </div>

              {groupIndex === 0 && filtersOpen ? (
                <div className="border-ink-700 bg-ink-850 mb-1.5 flex flex-col gap-1.5 rounded-md border px-2 py-1.5">
                  <Select
                    label="Group"
                    value={query.groupBy}
                    onChange={(event) => setQuery({ groupBy: event.target.value as SessionGroupBy })}
                    options={GROUP_OPTIONS}
                  />
                  <Select
                    label="Sort"
                    value={query.sortBy}
                    onChange={(event) => setQuery({ sortBy: event.target.value as SessionSortBy })}
                    options={SORT_OPTIONS}
                  />
                </div>
              ) : null}

              {group.items.map((session) => (
                <div
                  key={session.id}
                  onClick={() => void select(session.id)}
                  className={clsx(
                    'group flex cursor-pointer items-center gap-2 rounded-md px-2 py-[5px]',
                    session.id === activeId
                      ? 'bg-ink-800 text-ink-100'
                      : 'text-ink-300 hover:bg-ink-850'
                  )}
                >
                  <SessionDot status={session.status} />
                  <span className="min-w-0 flex-1 truncate text-[13px]">{session.title}</span>
                  <button
                    type="button"
                    title="Delete session"
                    onClick={(event) => {
                      event.stopPropagation()
                      void window.opendesktop.sessions.remove(session.id)
                    }}
                    className="text-ink-600 hover:text-bad shrink-0 opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="h-3 w-3" />
                  </button>
                </div>
              ))}
            </div>
          ))
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
