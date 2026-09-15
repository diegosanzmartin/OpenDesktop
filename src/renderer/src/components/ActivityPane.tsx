import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Search } from 'lucide-react'
import type { ActivityGroupBy, ActivitySortBy, BlockStatus } from '@shared/types'
import { useStore } from '../state/store'
import { filterBlocks, groupBlocks, sortBlocks } from '../lib/group'
import { STATUS_COLOR, TOOL_LABEL, duration, folderName, timeAgo } from '../lib/format'
import { Chip, Select, StatusDot } from './ui'

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
  const activeId = useStore((s) => s.activeSessionId)
  const select = useStore((s) => s.selectSession)
  const setExpanded = useStore((s) => s.setExpanded)
  if (!block) return null

  return (
    <button
      type="button"
      onClick={() => {
        if (block.sessionId !== activeId) void select(block.sessionId)
        setExpanded(block.id, true)
      }}
      className="hover:bg-ink-800 w-full px-3 py-1.5 text-left"
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
        <span className={clsx('shrink-0 text-[9.5px]', STATUS_COLOR[block.status])}>{duration(block)}</span>
      </div>
      <div className="text-ink-600 mt-0.5 flex items-center gap-1.5 pl-3 text-[9.5px]">
        <span className="truncate font-mono">{folderName(block.cwd)}</span>
        <span>·</span>
        <span className="truncate">{block.environmentId}</span>
        <span>·</span>
        <span className="truncate">{block.agentId}</span>
        <span className="ml-auto shrink-0">{timeAgo(block.createdAt)}</span>
      </div>
    </button>
  )
}

export function ActivityPane(): ReactNode {
  const activity = useStore((s) => s.activity)
  const query = useStore((s) => s.activityQuery)
  const setQuery = useStore((s) => s.setActivityQuery)
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)
  const activeId = useStore((s) => s.activeSessionId)
  const [, force] = useState(0)

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
    const effective = { ...query, since: query.since ? Date.now() - query.since : null }
    const done = filterBlocks(activity, effective).filter(
      (b) => b.status !== 'running' && b.status !== 'awaiting-approval'
    )
    return groupBlocks(sortBlocks(done, query.sortBy), query, labels)
  }, [activity, query, labels])

  const doneCount = groups.reduce((sum, group) => sum + group.items.length, 0)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-ink-800 space-y-1.5 border-b px-3 py-2">
        <div className="text-ink-600 flex items-center gap-2 text-[10.5px]">
          <span>
            {running.length} running · {doneCount} done
          </span>
        </div>
        <div className="border-ink-700 bg-ink-900 flex items-center gap-1.5 rounded border px-2 py-1">
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
          <Select
            value={String(query.since ?? '')}
            onChange={(event) => setQuery({ since: event.target.value ? Number(event.target.value) : null })}
            options={RANGES.map((r) => ({ value: String(r.value ?? ''), label: r.label }))}
          />
        </div>
        <div className="flex flex-wrap gap-1">
          <Chip
            active={query.sessionId !== null}
            onClick={() => setQuery({ sessionId: query.sessionId ? null : activeId })}
          >
            This session
          </Chip>
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

      <div className="min-h-0 flex-1 overflow-y-auto pb-3">
        {running.length > 0 ? (
          <div>
            <div className="bg-ink-850/95 sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 backdrop-blur">
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
          <div className="text-ink-600 px-3 py-6 text-center text-[11px]">Nothing has run yet.</div>
        ) : (
          groups.map((group) => (
            <div key={group.key}>
              {group.label ? (
                <div className="bg-ink-850/95 sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 backdrop-blur">
                  <span className="text-ink-400 text-[10px] font-semibold uppercase tracking-[0.08em]">
                    {group.label}
                  </span>
                  <span className="text-ink-600 text-[10px]">{group.items.length}</span>
                  <span className="bg-ink-800 h-px flex-1" />
                </div>
              ) : running.length > 0 ? (
                <div className="bg-ink-850/95 sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 backdrop-blur">
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
    </div>
  )
}
