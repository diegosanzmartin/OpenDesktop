import clsx from 'clsx'
import { useMemo, type ReactNode } from 'react'
import { Plus, Search, Trash2 } from 'lucide-react'
import { useStore } from '../state/store'
import type { SessionGroupBy, SessionSortBy } from '../state/store'
import { filterSessions, groupSessions, sortSessions } from '../lib/group'
import { folderName, timeAgo } from '../lib/format'
import { Empty, GroupHeader, Select, StatusDot } from './ui'

const GROUP_OPTIONS: { value: SessionGroupBy; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'folder', label: 'Folder' },
  { value: 'status', label: 'Status' },
  { value: 'date', label: 'Date' },
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

export function SessionSidebar(): ReactNode {
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeSessionId)
  const select = useStore((s) => s.selectSession)
  const newSession = useStore((s) => s.newSession)
  const query = useStore((s) => s.sessionQuery)
  const setQuery = useStore((s) => s.setSessionQuery)
  const config = useStore((s) => s.config)

  const labels = useMemo(
    () => ({
      environments: Object.fromEntries(
        Object.values(config?.environment ?? {}).map((e) => [e.id, e.name])
      ),
      agents: Object.fromEntries(Object.values(config?.agent ?? {}).map((a) => [a.id, a.name]))
    }),
    [config]
  )

  const groups = useMemo(() => {
    const filtered = filterSessions(sessions, query)
    const sorted = sortSessions(filtered, query.sortBy)
    return groupSessions(sorted, query, labels)
  }, [sessions, query, labels])

  const total = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <aside className="border-ink-800 bg-ink-900 flex w-[268px] shrink-0 flex-col border-r">
      <div className="border-ink-800 space-y-2 border-b px-3 pb-2.5 pt-2">
        <button
          type="button"
          onClick={() => void newSession()}
          className="bg-ink-800 hover:bg-ink-700 text-ink-100 border-ink-700 flex w-full items-center justify-center gap-1.5 rounded-md border py-1.5 text-[12px] font-medium transition-colors"
        >
          <Plus className="h-3.5 w-3.5" />
          New session
        </button>

        <div className="border-ink-700 bg-ink-850 flex items-center gap-1.5 rounded border px-2 py-1">
          <Search className="text-ink-600 h-3 w-3 shrink-0" />
          <input
            value={query.search}
            onChange={(event) => setQuery({ search: event.target.value })}
            placeholder="Filter sessions"
            className="text-ink-200 placeholder:text-ink-600 w-full bg-transparent text-[11.5px] outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <Select
            className="flex-1"
            value={query.groupBy}
            onChange={(event) => setQuery({ groupBy: event.target.value as SessionGroupBy })}
            options={GROUP_OPTIONS}
          />
          <Select
            className="flex-1"
            value={query.sortBy}
            onChange={(event) => setQuery({ sortBy: event.target.value as SessionSortBy })}
            options={SORT_OPTIONS}
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {total === 0 ? (
          <Empty>No sessions match this filter.</Empty>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              {group.label ? <GroupHeader label={group.label} count={group.items.length} /> : null}
              {group.items.map((session) => {
                const agent = config?.agent[session.agentId]
                const env = config?.environment[session.environmentId]
                return (
                  <div
                    key={session.id}
                    className={clsx(
                      'group relative cursor-pointer px-3 py-1.5',
                      session.id === activeId ? 'bg-ink-800' : 'hover:bg-ink-850'
                    )}
                    onClick={() => void select(session.id)}
                  >
                    {session.id === activeId ? (
                      <span className="bg-brand absolute inset-y-0 left-0 w-[2px]" />
                    ) : null}
                    <div className="flex items-center gap-1.5">
                      <StatusDot status={session.status} />
                      <span
                        className={clsx(
                          'min-w-0 flex-1 truncate text-[12px]',
                          session.id === activeId ? 'text-ink-100' : 'text-ink-200'
                        )}
                      >
                        {session.title}
                      </span>
                      <button
                        type="button"
                        title="Delete session"
                        onClick={(event) => {
                          event.stopPropagation()
                          void window.opendesktop.sessions.remove(session.id)
                        }}
                        className="text-ink-600 hover:text-bad opacity-0 transition-opacity group-hover:opacity-100"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    </div>
                    <div className="text-ink-600 mt-0.5 flex items-center gap-1.5 pl-3 text-[10px]">
                      {agent ? (
                        <span style={{ color: agent.color }} className="font-medium">
                          {agent.name}
                        </span>
                      ) : null}
                      <span className="truncate font-mono">{folderName(session.cwd)}</span>
                      {env && env.kind === 'ssh' ? <span className="text-info">{env.name}</span> : null}
                      <span className="ml-auto shrink-0">{timeAgo(session.updatedAt)}</span>
                    </div>
                  </div>
                )
              })}
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
