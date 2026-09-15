import type { Block, Message } from './types'

/**
 * What to say a turn is doing while it runs.
 *
 * "Working…" is true of every moment of a turn and therefore tells you
 * nothing. A turn that has been going three minutes is either thinking,
 * writing, running something, or waiting for you — and which one it is decides
 * whether you keep waiting or go and look. Kept out of the component so every
 * branch can be asserted without a DOM.
 */
const ACTIVITY: Record<string, string> = {
  bash: 'Running a command',
  read: 'Reading a file',
  write: 'Writing a file',
  edit: 'Editing a file',
  grep: 'Searching',
  glob: 'Finding files',
  list: 'Listing a directory',
  fetch: 'Fetching a page',
  task: 'Waiting on a subagent'
}

export function activityOf(message: Message, blocks: Block[]): string {
  // Whatever else is happening, a request for a person outranks it.
  if (blocks.some((block) => block.status === 'awaiting-approval')) return 'Waiting for approval'

  const live = blocks.filter((block) => block.status === 'running' || block.status === 'pending')
  if (live.length > 1) return 'Running tools…'
  if (live.length === 1) return `${ACTIVITY[live[0].tool] ?? 'Running a tool'}…`

  const last = message.parts[message.parts.length - 1]
  if (last?.type === 'reasoning') return 'Thinking…'
  if (last?.type === 'text') return 'Writing…'
  // Between steps: a tool has returned and the model has not spoken yet.
  return 'Working…'
}

export function duration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s`
}

/**
 * Output tokens per second, or null when the number would be noise — a rate
 * off half a second of streaming says nothing, and neither does one with no
 * tokens behind it.
 */
export function tokenRate(outputTokens: number, seconds: number): number | null {
  if (seconds < 3 || outputTokens <= 0) return null
  return Math.round(outputTokens / seconds)
}
