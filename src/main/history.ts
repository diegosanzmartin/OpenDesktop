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
export function trimHistory(sessionId: string, maxChars = 600_000): void {
  const history = getHistory(sessionId)
  let total = JSON.stringify(history).length
  while (total > maxChars && history.length > 4) {
    history.splice(0, 2)
    total = JSON.stringify(history).length
  }
  persist(sessionId)
}
