import type { ActivityQuery, Block, Group } from '@shared/types'
import { dayBucket, durationMs, folderName } from './format'

// The session-list half lives in @shared/sessions so the headless tests can
// reach it; it is re-exported here so callers have one place to import from.
export { filterSessions, groupSessions, sortSessions } from '@shared/sessions'
export type { Group } from '@shared/types'

export interface GroupLabels {
  environments: Record<string, string>
  agents: Record<string, string>
  sessions: Record<string, string>
}

const STATUS_RANK: Record<string, number> = {
  running: 0,
  'awaiting-approval': 1,
  pending: 2,
  error: 3,
  success: 4,
  canceled: 5,
  idle: 6
}

/* ---------------- activity blocks ---------------- */

export function filterBlocks(blocks: Block[], query: ActivityQuery): Block[] {
  const needle = query.search.trim().toLowerCase()
  return blocks.filter((block) => {
    if (query.statuses.length && !query.statuses.includes(block.status)) return false
    if (query.environments.length && !query.environments.includes(block.environmentId)) return false
    if (query.agents.length && !query.agents.includes(block.agentId)) return false
    if (query.tools.length && !query.tools.includes(block.tool)) return false
    if (query.sessionId && block.sessionId !== query.sessionId) return false
    if (query.since && block.createdAt < query.since) return false
    if (needle) {
      const haystack = `${block.title} ${block.subtitle ?? ''} ${block.tool} ${block.cwd}`.toLowerCase()
      if (!haystack.includes(needle)) return false
    }
    return true
  })
}

export function sortBlocks(blocks: Block[], sortBy: ActivityQuery['sortBy']): Block[] {
  const copy = blocks.slice()
  switch (sortBy) {
    case 'oldest':
      return copy.sort((a, b) => a.createdAt - b.createdAt)
    case 'duration':
      return copy.sort((a, b) => durationMs(b) - durationMs(a))
    case 'status':
      return copy.sort(
        (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || b.createdAt - a.createdAt
      )
    case 'tool':
      return copy.sort((a, b) => a.tool.localeCompare(b.tool) || b.createdAt - a.createdAt)
    case 'folder':
      return copy.sort((a, b) => a.cwd.localeCompare(b.cwd) || b.createdAt - a.createdAt)
    default:
      return copy.sort((a, b) => b.createdAt - a.createdAt)
  }
}

export function groupBlocks(blocks: Block[], query: ActivityQuery, labels: GroupLabels): Group<Block>[] {
  if (query.groupBy === 'none') return [{ key: 'all', label: '', items: blocks }]

  const map = new Map<string, Group<Block>>()
  for (const block of blocks) {
    let key = 'other'
    let label = 'Other'
    switch (query.groupBy) {
      case 'folder':
        key = block.cwd
        label = folderName(block.cwd)
        break
      case 'status':
        key = block.status
        label = block.status
        break
      case 'date':
        key = dayBucket(block.createdAt)
        label = key
        break
      case 'environment':
        key = block.environmentId
        label = labels.environments[block.environmentId] ?? block.environmentId
        break
      case 'agent':
        key = block.agentId
        label = labels.agents[block.agentId] ?? block.agentId
        break
      case 'tool':
        key = block.tool
        label = block.tool
        break
      case 'session':
        key = block.sessionId
        label = labels.sessions[block.sessionId] ?? 'Session'
        break
    }
    const group = map.get(key) ?? { key, label, items: [] }
    group.items.push(block)
    map.set(key, group)
  }
  return [...map.values()]
}
