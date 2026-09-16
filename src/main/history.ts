import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelMessage } from 'ai'
import { DATA_DIR } from './config'

/**
 * The model-facing transcript, kept separately from the UI transcript.
 * The UI transcript is shaped for humans (blocks, collapsed output); this one
 * is exactly what goes back to the model on the next turn.
 */
const HISTORY_DIR = join(DATA_DIR, 'history')
const memory = new Map<string, ModelMessage[]>()

function pathFor(sessionId: string): string {
  return join(HISTORY_DIR, `${sessionId}.json`)
}

export function getHistory(sessionId: string): ModelMessage[] {
  const cached = memory.get(sessionId)
  if (cached) return cached
  const path = pathFor(sessionId)
  if (existsSync(path)) {
    try {
      const parsed = JSON.parse(readFileSync(path, 'utf8')) as ModelMessage[]
      memory.set(sessionId, parsed)
      return parsed
    } catch {
      /* fall through to empty */
    }
  }
  const fresh: ModelMessage[] = []
  memory.set(sessionId, fresh)
  return fresh
}

export function appendHistory(sessionId: string, messages: ModelMessage[]): void {
  const history = getHistory(sessionId)
  history.push(...messages)
  persist(sessionId)
}

export function persist(sessionId: string): void {
  mkdirSync(HISTORY_DIR, { recursive: true })
  writeFileSync(pathFor(sessionId), JSON.stringify(memory.get(sessionId) ?? []), 'utf8')
}

export function clearHistory(sessionId: string): void {
  memory.delete(sessionId)
  const path = pathFor(sessionId)
  if (existsSync(path)) rmSync(path)
}

/**
 * Keeps the transcript inside a rough token budget by dropping the oldest turns.
 * Tool-heavy sessions grow fast, and a hard failure from the provider is worse
 * than losing early context.
 */
export function historySize(sessionId: string): number {
  return JSON.stringify(getHistory(sessionId)).length
}

/**
 * Turns the older part of a session into a summary, in place.
 *
 * The old behaviour was to splice messages off the front until the transcript
 * fit under a cap — silently. A long session forgot its own beginning with no
 * trace, which is the worst possible failure for work you are in the middle
 * of: the model stops knowing what it decided an hour ago and nothing says so.
 *
 * The summariser is passed in rather than imported, so this module stays free
 * of any provider and the headless test can drive the whole path.
 *
 * Returns what a person should be told, or null when nothing was needed.
 */
export async function compactHistory(
  sessionId: string,
  summarise: (messages: ModelMessage[]) => Promise<string>,
  options: { maxChars?: number; keepRecent?: number } = {}
): Promise<{ summarised: number; summary: string } | null> {
  const maxChars = options.maxChars ?? 600_000
  const keepRecent = options.keepRecent ?? 8

  const history = getHistory(sessionId)
  if (JSON.stringify(history).length <= maxChars) return null
  // Nothing to gain from summarising a handful of messages; if the transcript
  // is over the cap with this few, they are individually enormous and cutting
  // them would lose more than it saves.
  if (history.length <= keepRecent + 2) return null

  const older = history.slice(0, history.length - keepRecent)
  const recent = history.slice(history.length - keepRecent)

  let summary: string
  try {
    summary = (await summarise(older)).trim()
  } catch {
    // A failed summary must not take the conversation with it: leave the
    // transcript alone and let the next turn try again.
    return null
  }
  if (!summary) return null

  const note: ModelMessage = {
    role: 'user',
    content:
      `<earlier-in-this-session count="${older.length}">\n${summary}\n` +
      `</earlier-in-this-session>\n\n` +
      `That is a summary of the ${older.length} messages before this point, which have been ` +
      `dropped to stay inside the context window. Treat it as established fact. If you need a ` +
      `detail it does not contain, read the files rather than guessing.`
  }

  memory.set(sessionId, [note, ...recent])
  persist(sessionId)
  return { summarised: older.length, summary }
}

/** Copies one session's model transcript onto another, for a fork. */
export function copyHistory(fromId: string, toId: string): void {
  const source = getHistory(fromId)
  if (source.length === 0) return
  memory.set(toId, structuredClone(source))
  persist(toId)
}
