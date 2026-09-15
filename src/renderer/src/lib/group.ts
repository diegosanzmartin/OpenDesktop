import type { ActivityQuery, Block, Session } from '@shared/types'
import type { SessionQuery } from '../state/store'
import { dayBucket, durationMs, folderName } from './format'

export interface Group<T> {
  key: string
  label: string
  items: T[]
}

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

/* ---------------- sessions ---------------- */

export function filterSessions(sessions: Session[], query: SessionQuery): Session[] {
  const needle = query.search.trim().toLowerCase()
  return sessions.filter((session) => {
    if (!query.showArchived && session.archived) return false
    // Subagent sessions are reachable from their parent's task block, not the list.
    if (session.parentSessionId) return false
    if (query.statuses.length && !query.statuses.includes(session.status)) return false
    if (query.environments.length && !query.environments.includes(session.environmentId)) return false
    if (query.agents.length && !query.agents.includes(session.agentId)) return false
    if (needle && !`${session.title} ${session.cwd}`.toLowerCase().includes(needle)) return false
    return true
  })
}

export function sortSessions(sessions: Session[], sortBy: SessionQuery['sortBy']): Session[] {
  const copy = sessions.slice()
  switch (sortBy) {
    case 'oldest':
      return copy.sort((a, b) => a.updatedAt - b.updatedAt)
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title))
    case 'folder':
      return copy.sort((a, b) => a.cwd.localeCompare(b.cwd) || b.updatedAt - a.updatedAt)
    case 'status':
      return copy.sort(
        (a, b) => (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9) || b.updatedAt - a.updatedAt
      )
    default:
      return copy.sort((a, b) => b.updatedAt - a.updatedAt)
  }
}

export function groupSessions(
  sessions: Session[],
  query: SessionQuery,
  labels: Omit<GroupLabels, 'sessions'>
): Group<Session>[] {
  if (query.groupBy === 'none') return [{ key: 'all', label: '', items: sessions }]
  const map = new Map<string, Group<Session>>()
  for (const session of sessions) {
    let key = 'other'
    let label = 'Other'
    switch (query.groupBy) {
      case 'folder':
        key = session.cwd
        label = folderName(session.cwd)
        break
      case 'status':
        key = session.status
        label = session.status
        break
      case 'date':
        key = dayBucket(session.updatedAt)
        label = key
        break
      case 'environment':
        key = session.environmentId
        label = labels.environments[session.environmentId] ?? session.environmentId
        break
      case 'agent':
        key = session.agentId
        label = labels.agents[session.agentId] ?? session.agentId
        break
    }
    const group = map.get(key) ?? { key, label, items: [] }
    group.items.push(session)
    map.set(key, group)
  }
  return [...map.values()]
}
