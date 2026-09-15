import type { Group, Session, SessionQuery } from './types'

/**
 * How the session list is filtered, sorted and grouped. Pure functions over
 * `Session`, kept out of the renderer so the headless tests can exercise them
 * directly — the list's behaviour is worth asserting, and doing that should not
 * require a DOM.
 */

/** Running first, then whatever needs a human, then failures, then the rest. */
export const SESSION_STATUS_RANK: Record<string, number> = {
  running: 0,
  'awaiting-approval': 1,
  blocked: 2,
  queued: 3,
  pending: 4,
  error: 5,
  success: 6,
  canceled: 7,
  idle: 8,
  done: 9
}

export function folderName(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/')
  return parts[parts.length - 1] || path
}

/** The heading a timestamp falls under when grouping by date. */
export function dayBucket(ts: number): string {
  const now = new Date()
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  if (ts >= startOfToday) return 'Today'
  if (ts >= startOfToday - 86_400_000) return 'Yesterday'
  if (ts >= startOfToday - 7 * 86_400_000) return 'Earlier this week'
  if (ts >= startOfToday - 30 * 86_400_000) return 'Earlier this month'
  return new Date(ts).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })
}

function matchesStatus(session: Session, filter: SessionQuery['status']): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'running':
      return session.status === 'running'
    case 'queued':
      return session.status === 'queued'
    case 'done':
      return session.status === 'done'
    case 'approval':
      // Both mean the same thing to a person looking for what needs them.
      return session.status === 'awaiting-approval' || session.status === 'blocked'
    case 'error':
      return session.status === 'error'
    case 'idle':
      return session.status === 'idle' && !session.archived
    default:
      // "Active" means not put away, rather than a particular state.
      return !session.archived
  }
}

export function filterSessions(sessions: Session[], query: SessionQuery): Session[] {
  const needle = query.search.trim().toLowerCase()
  return sessions.filter((session) => {
    if (!matchesStatus(session, query.status)) return false
    if (query.environment !== 'all' && session.environmentId !== query.environment) return false
    if (needle && !`${session.title} ${session.cwd}`.toLowerCase().includes(needle)) return false
    return true
  })
}

export function sortSessions(sessions: Session[], sortBy: SessionQuery['sortBy']): Session[] {
  const copy = sessions.slice()
  switch (sortBy) {
    case 'created':
      return copy.sort((a, b) => b.createdAt - a.createdAt)
    case 'title':
      return copy.sort((a, b) => a.title.localeCompare(b.title))
    case 'folder':
      return copy.sort((a, b) => a.cwd.localeCompare(b.cwd) || b.updatedAt - a.updatedAt)
    case 'status':
      return copy.sort(
        (a, b) =>
          (SESSION_STATUS_RANK[a.status] ?? 9) - (SESSION_STATUS_RANK[b.status] ?? 9) ||
          b.updatedAt - a.updatedAt
      )
    default:
      return copy.sort((a, b) => b.updatedAt - a.updatedAt)
  }
}

export function groupSessions(
  sessions: Session[],
  query: SessionQuery,
  labels: { environments: Record<string, string>; agents: Record<string, string> }
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

/** A row of the session list: a session, and how deep it sits under a parent. */
export interface ListRow {
  session: Session
  depth: number
}

/**
 * Subtasks listed under the task that spawned them.
 *
 * They used to be hidden here, reachable only from their parent's task block,
 * which made sense when the only way to get one was a subagent call. Now that a
 * story can be split on a board, a subtask is a first-class piece of work and
 * hiding it loses it. It is indented rather than promoted, so the list still
 * says which work belongs to which.
 */
export function nestSubtasks(rows: Session[]): ListRow[] {
  const present = new Set(rows.map((row) => row.id))
  const children = new Map<string, Session[]>()
  const roots: Session[] = []

  for (const row of rows) {
    const parent = row.parentSessionId
    // A subtask whose parent is filtered out stands on its own, rather than
    // vanishing with it.
    if (parent && present.has(parent)) {
      children.set(parent, [...(children.get(parent) ?? []), row])
    } else {
      roots.push(row)
    }
  }

  const out: ListRow[] = []
  const walk = (session: Session, depth: number): void => {
    out.push({ session, depth })
    // Capped: a subagent can spawn a subagent, and the sidebar is 248px wide.
    for (const child of children.get(session.id) ?? []) walk(child, Math.min(depth + 1, 2))
  }
  for (const root of roots) walk(root, 0)
  return out
}
