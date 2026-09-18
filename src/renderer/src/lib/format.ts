import type { Block, BlockStatus } from '@shared/types'

// Both are pure and are needed by the headless tests too, so they live in
// @shared/sessions; re-exported here because the components import from format.
export { dayBucket, folderName } from '@shared/sessions'

export function timeAgo(ts: number): string {
  const seconds = Math.max(0, Math.floor((Date.now() - ts) / 1000))
  if (seconds < 45) return 'just now'
  if (seconds < 90) return '1 min ago'
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} d ago`
  return new Date(ts).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })
}

export function clockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })
}

export function duration(block: Block): string {
  const ms = durationMs(block)
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60_000)
  return `${minutes}m ${Math.floor((ms % 60_000) / 1000)}s`
}

export function durationMs(block: Block): number {
  const start = block.startedAt ?? block.createdAt
  const end = block.endedAt ?? Date.now()
  return Math.max(0, end - start)
}

export function shortenPath(path: string, max = 38): string {
  if (path.length <= max) return path
  const parts = path.split('/')
  if (parts.length <= 2) return `…${path.slice(-max + 1)}`
  return `…/${parts.slice(-2).join('/')}`
}

export const STATUS_LABEL: Record<BlockStatus, string> = {
  pending: 'Queued',
  'awaiting-approval': 'Needs approval',
  running: 'Running',
  success: 'Done',
  error: 'Failed',
  canceled: 'Canceled'
}

export const STATUS_COLOR: Record<BlockStatus, string> = {
  pending: 'text-ink-500',
  'awaiting-approval': 'text-warn',
  running: 'text-info',
  success: 'text-ok',
  error: 'text-bad',
  canceled: 'text-ink-500'
}

export const STATUS_DOT: Record<BlockStatus, string> = {
  pending: 'bg-ink-500',
  'awaiting-approval': 'bg-warn',
  running: 'bg-info',
  success: 'bg-ok',
  error: 'bg-bad',
  canceled: 'bg-ink-600'
}

export const TOOL_LABEL: Record<string, string> = {
  bash: 'Command',
  read: 'Read',
  write: 'Write',
  edit: 'Edit',
  grep: 'Search',
  glob: 'Find files',
  list: 'List',
  fetch: 'Fetch',
  task: 'Subagent',
  deliver: 'Files for you'
}

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*[A-Za-z]`, 'g')

/** Terminal output arrives with escape codes and bare CRs; neither renders in HTML. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, '').replace(/\r(?!\n)/g, '\n')
}

export function tokens(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}
