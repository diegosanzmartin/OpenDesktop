import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Activity, PanelRightClose, PanelRightOpen, Search } from 'lucide-react'
import type { ActivityGroupBy, ActivitySortBy, BlockStatus } from '@shared/types'
import { useStore } from '../state/store'
import { filterBlocks, groupBlocks, sortBlocks } from '../lib/group'
import { STATUS_COLOR, TOOL_LABEL, duration, folderName, timeAgo } from '../lib/format'
import { Chip, Empty, GroupHeader, Select, StatusDot } from './ui'

const GROUP_OPTIONS: { value: ActivityGroupBy; label: string }[] = [
  { value: 'none', label: 'No grouping' },
  { value: 'folder', label: 'Folder' },
  { value: 'status', label: 'Status' },
  { value: 'date', label: 'Date' },
  { value: 'environment', label: 'Environment' },
  { value: 'agent', label: 'Agent' },
  { value: 'tool', label: 'Tool' },
  { value: 'session', label: 'Session' }
]

const SORT_OPTIONS: { value: ActivitySortBy; label: string }[] = [
  { value: 'recent', label: 'Newest' },
  { value: 'oldest', label: 'Oldest' },
  { value: 'duration', label: 'Longest' },
  { value: 'status', label: 'Status' },
  { value: 'tool', label: 'Tool' },
  { value: 'folder', label: 'Folder' }
]

const STATUS_FILTERS: BlockStatus[] = ['running', 'awaiting-approval', 'success', 'error', 'canceled']

const RANGES: { label: string; value: number | null }[] = [
  { label: 'All time', value: null },
  { label: 'Last hour', value: 3_600_000 },
  { label: 'Today', value: 86_400_000 },
  { label: 'Last 7 days', value: 7 * 86_400_000 }
]

function Row({ blockId }: { blockId: string }): ReactNode {
  const block = useStore((s) => s.blocks[blockId])
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeSessionId)
  const select = useStore((s) => s.selectSession)
  const setExpanded = useStore((s) => s.setExpanded)
  const setPane = useStore((s) => s.setPane)
  if (!block) return null

  const session = sessions.find((s) => s.id === block.sessionId)
  const live = block.status === 'running' || block.status === 'awaiting-approval'

  return (
    <button
      type="button"
      onClick={() => {
        if (block.sessionId !== activeId) void select(block.sessionId)
        setExpanded(block.id, true)
        setPane('chat')
      }}
      className={clsx(
        'hover:bg-ink-850 w-full px-3 py-1.5 text-left transition-colors',
        live && 'bg-ink-850/60'
      )}
    >
      <div className="flex items-center gap-1.5">
        <StatusDot status={block.status} />
        <span className="text-ink-600 shrink-0 text-[9.5px] font-semibold uppercase tracking-wide">
          {TOOL_LABEL[block.tool] ?? block.tool}
        </span>
        <span
          className={clsx(
            'min-w-0 flex-1 truncate font-mono text-[11px]',
            block.status === 'error' ? 'text-bad' : 'text-ink-200'
          )}
        >
          {block.title}
        </span>
        <span className={clsx('shrink-0 text-[9.5px]', STATUS_COLOR[block.status])}>
          {duration(block)}
        </span>
      </div>
      <div className="text-ink-600 mt-0.5 flex items-center gap-1.5 pl-3 text-[9.5px]">
        <span className="truncate font-mono">{folderName(block.cwd)}</span>
        <span>·</span>
        <span className="truncate">{block.environmentId}</span>
        <span>·</span>
        <span className="truncate">{block.agentId}</span>
        {session && session.parentSessionId ? <span className="text-violet">sub</span> : null}
        <span className="ml-auto shrink-0">{timeAgo(block.createdAt)}</span>
      </div>
    </button>
  )
}

export function ActivityRail(): ReactNode {
  const activity = useStore((s) => s.activity)
  const query = useStore((s) => s.activityQuery)
  const setQuery = useStore((s) => s.setActivityQuery)
  const collapsed = useStore((s) => s.activityCollapsed)
  const toggle = useStore((s) => s.toggleActivity)
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeSessionId)
  const [, force] = useState(0)

  // Running blocks show a live duration, so tick while anything is in flight.
  const hasLive = activity.some((b) => b.status === 'running' || b.status === 'awaiting-approval')
  useEffect(() => {
    if (!hasLive) return
    const timer = setInterval(() => force((n) => n + 1), 1000)
    return () => clearInterval(timer)
  }, [hasLive])

  const labels = useMemo(
    () => ({
      environments: Object.fromEntries(
        Object.values(config?.environment ?? {}).map((e) => [e.id, e.name])
      ),
      agents: Object.fromEntries(Object.values(config?.agent ?? {}).map((a) => [a.id, a.name])),
      sessions: Object.fromEntries(sessions.map((s) => [s.id, s.title]))
    }),
    [config, sessions]
  )

  const running = useMemo(
    () => activity.filter((b) => b.status === 'running' || b.status === 'awaiting-approval'),
    [activity]
  )

  const groups = useMemo(() => {
    const effective = {
      ...query,
      since: query.since ? Date.now() - query.since : null
    }
    const filtered = filterBlocks(activity, effective).filter(
      (b) => b.status !== 'running' && b.status !== 'awaiting-approval'
    )
    return groupBlocks(sortBlocks(filtered, query.sortBy), query, labels)
  }, [activity, query, labels])

  const doneCount = groups.reduce((sum, group) => sum + group.items.length, 0)

  if (collapsed) {
    return (
      <div className="border-ink-800 bg-ink-900 flex w-10 shrink-0 flex-col items-center gap-3 border-l pt-3">
        <button type="button" onClick={toggle} className="text-ink-500 hover:text-ink-200" title="Show activity">
          <PanelRightOpen className="h-4 w-4" />
        </button>
        {running.length > 0 ? (
          <div className="text-info flex flex-col items-center gap-1">
            <Activity className="h-3.5 w-3.5" />
            <span className="text-[10px] font-semibold">{running.length}</span>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <aside className="border-ink-800 bg-ink-900 flex w-[340px] shrink-0 flex-col border-l">
      <div className="border-ink-800 space-y-2 border-b px-3 pb-2.5 pt-2.5">
        <div className="flex items-center gap-2">
          <Activity className="text-ink-400 h-3.5 w-3.5" />
          <span className="text-ink-200 text-[12px] font-semibold">Activity</span>
          <span className="text-ink-600 text-[10px]">
            {running.length} running · {doneCount} done
          </span>
          <button
            type="button"
            onClick={toggle}
            title="Hide activity"
            className="text-ink-600 hover:text-ink-300 ml-auto"
          >
            <PanelRightClose className="h-4 w-4" />
          </button>
        </div>

        <div className="border-ink-700 bg-ink-850 flex items-center gap-1.5 rounded border px-2 py-1">
          <Search className="text-ink-600 h-3 w-3 shrink-0" />
          <input
            value={query.search}
            onChange={(event) => setQuery({ search: event.target.value })}
            placeholder="Filter commands"
            className="text-ink-200 placeholder:text-ink-600 w-full bg-transparent text-[11.5px] outline-none"
          />
        </div>

        <div className="flex items-center gap-1.5">
          <Select
            className="flex-1"
            value={query.groupBy}
            onChange={(event) => setQuery({ groupBy: event.target.value as ActivityGroupBy })}
            options={GROUP_OPTIONS}
          />
          <Select
            className="flex-1"
            value={query.sortBy}
            onChange={(event) => setQuery({ sortBy: event.target.value as ActivitySortBy })}
            options={SORT_OPTIONS}
          />
        </div>

        <div className="flex items-center gap-1.5">
          <Select
            className="flex-1"
            value={String(query.since ?? '')}
            onChange={(event) =>
              setQuery({ since: event.target.value ? Number(event.target.value) : null })
            }
            options={RANGES.map((r) => ({ value: String(r.value ?? ''), label: r.label }))}
          />
          <Chip
            active={query.sessionId !== null}
            onClick={() => setQuery({ sessionId: query.sessionId ? null : activeId })}
          >
            This session
          </Chip>
        </div>

        <div className="flex flex-wrap gap-1">
          {STATUS_FILTERS.map((status) => (
            <Chip
              key={status}
              active={query.statuses.includes(status)}
              onClick={() =>
                setQuery({
                  statuses: query.statuses.includes(status)
                    ? query.statuses.filter((s) => s !== status)
                    : [...query.statuses, status]
                })
              }
            >
              {status === 'awaiting-approval' ? 'approval' : status}
            </Chip>
          ))}
        </div>

        <div className="flex flex-wrap gap-1">
          {Object.values(config?.environment ?? {}).map((env) => (
            <Chip
              key={env.id}
              active={query.environments.includes(env.id)}
              onClick={() =>
                setQuery({
                  environments: query.environments.includes(env.id)
                    ? query.environments.filter((e) => e !== env.id)
                    : [...query.environments, env.id]
                })
              }
            >
              {env.name}
            </Chip>
          ))}
          {Object.values(config?.agent ?? {}).map((agent) => (
            <Chip
              key={agent.id}
              active={query.agents.includes(agent.id)}
              color={agent.color}
              onClick={() =>
                setQuery({
                  agents: query.agents.includes(agent.id)
                    ? query.agents.filter((a) => a !== agent.id)
                    : [...query.agents, agent.id]
                })
              }
            >
              {agent.name}
            </Chip>
          ))}
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto pb-4">
        {running.length > 0 ? (
          <div>
            <div className="bg-ink-900/95 sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 backdrop-blur">
              <span className="text-info text-[10px] font-semibold uppercase tracking-[0.08em]">
                Running now
              </span>
              <span className="bg-ink-800 h-px flex-1" />
            </div>
            {running.map((block) => (
              <Row key={block.id} blockId={block.id} />
            ))}
          </div>
        ) : null}

        {doneCount === 0 && running.length === 0 ? (
          <Empty>Nothing has run yet.</Empty>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              {group.label ? (
                <GroupHeader label={group.label} count={group.items.length} />
              ) : running.length > 0 ? (
                <div className="bg-ink-900/95 sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 backdrop-blur">
                  <span className="text-ink-400 text-[10px] font-semibold uppercase tracking-[0.08em]">
                    Completed
                  </span>
                  <span className="bg-ink-800 h-px flex-1" />
                </div>
              ) : null}
              {group.items.map((block) => (
                <Row key={block.id} blockId={block.id} />
              ))}
            </div>
          ))
        )}
      </div>
    </aside>
  )
}
