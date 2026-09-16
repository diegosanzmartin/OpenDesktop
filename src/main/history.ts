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

/** How big the transcript is on disk. Measures only; it changes nothing. */
export function historySize(sessionId: string): number {
  return JSON.stringify(getHistory(sessionId)).length
}

/* ---------------- where it is safe to cut ---------------- */

interface Part {
  type?: string
  text?: string
}

function parts(message: ModelMessage): Part[] {
  return Array.isArray(message.content) ? (message.content as Part[]) : []
}

/** An assistant message that asked for tools; its results are the message after it. */
function callsTools(message: ModelMessage | undefined): boolean {
  if (!message || message.role !== 'assistant') return false
  return parts(message).some((part) => part?.type === 'tool-call')
}

function isToolResult(message: ModelMessage | undefined): boolean {
  return message?.role === 'tool'
}

/**
 * The latest index at or before `from` where the transcript can be cut.
 *
 * A tool-using turn is several messages: the assistant asking for the calls,
 * then a `tool` message carrying their results. Cutting between the two sends
 * the provider a result with no matching call — Anthropic-style APIs reject
 * that outright with a 400, and others interpret it as they please. In a
 * tool-heavy turn roughly half of all boundaries land inside such a pair, so
 * this is not a rare case.
 *
 * Snapped backwards, never forwards: keeping an extra message costs a little
 * context, and dropping half a pair costs the whole turn.
 */
export function safeBoundary(history: ModelMessage[], from: number): number {
  let index = Math.max(0, Math.min(from, history.length))
  while (index > 0 && (isToolResult(history[index]) || callsTools(history[index - 1]))) {
    index--
  }
  return index
}

/* ---------------- dropping what stopped mattering ---------------- */

/** Marks an output this function has already replaced, so it is never re-wrapped. */
const DEHYDRATED = '[dropped to save context]'

export interface DehydrateOptions {
  /** Tool output from turns older than this many stays; anything before it goes. */
  afterTurns?: number
  /** Outputs smaller than this are left alone: the saving would not pay for the loss. */
  overChars?: number
  /** Whether image bytes from older turns are dropped too. */
  images?: boolean
}

export interface Dehydration {
  /** Outputs and images replaced. */
  dropped: number
  /** Roughly how many tokens that freed. */
  freedTokens: number
}

/**
 * Replaces the body of old tool results with a note saying how to get them back.
 *
 * This is where a transcript's weight actually comes from. A 30k-character
 * grep, a file read, a build log: each is truncated once when it is produced
 * and then resent verbatim on every step of every later turn, long after the
 * agent has moved on. Summarising only reaches it once the whole session is
 * over budget, and costs a model call when it does. This costs nothing.
 *
 * The bargain is the one the summary note already strikes: the model is told
 * exactly which call produced the output, so it can run it again if it turns
 * out to matter. It is lossy — a build log is not always reproducible — which
 * is why recent turns are kept whole and small outputs are left alone.
 *
 * Per invariant 5 the UI keeps the full output; this only shrinks the model's
 * copy.
 */
export function dehydrate(
  history: ModelMessage[],
  options: DehydrateOptions = {}
): { history: ModelMessage[]; dropped: number; freedTokens: number } {
  const afterTurns = options.afterTurns ?? 2
  const overChars = options.overChars ?? 800
  const images = options.images ?? true

  // A turn starts at a user message. Everything from the Nth-from-last onwards
  // is recent and stays exactly as it is.
  const userIndexes = history
    .map((message, index) => (message.role === 'user' ? index : -1))
    .filter((index) => index >= 0)
  if (userIndexes.length <= afterTurns) return { history, dropped: 0, freedTokens: 0 }
  const recentFrom = userIndexes[userIndexes.length - afterTurns]

  // What each call was, so a dropped result can say how to get itself back.
  const calls = new Map<string, { name: string; input: string }>()
  for (const message of history) {
    if (message.role !== 'assistant') continue
    for (const part of parts(message)) {
      const call = part as { type?: string; toolCallId?: string; toolName?: string; input?: unknown }
      if (call.type === 'tool-call' && call.toolCallId) {
        calls.set(call.toolCallId, {
          name: call.toolName ?? 'a tool',
          input: JSON.stringify(call.input ?? {}).slice(0, 300)
        })
      }
    }
  }

  let dropped = 0
  let freedChars = 0

  const next = history.map((message, index) => {
    if (index >= recentFrom) return message

    if (message.role === 'tool') {
      const content = parts(message) as unknown as {
        type?: string
        toolCallId?: string
        output?: { type?: string; value?: unknown }
      }[]
      let touched = false
      const rewritten = content.map((part) => {
        if (part?.type !== 'tool-result') return part
        const value = part.output?.value
        const text = typeof value === 'string' ? value : JSON.stringify(value ?? '')
        if (text.startsWith(DEHYDRATED) || text.length <= overChars) return part
        const call = part.toolCallId ? calls.get(part.toolCallId) : undefined
        touched = true
        dropped++
        freedChars += text.length
        return {
          ...part,
          output: {
            type: 'text',
            value:
              `${DEHYDRATED} ${text.length.toLocaleString('en-GB')} characters. ` +
              `It came from ${call ? `${call.name}(${call.input})` : 'an earlier tool call'}. ` +
              `Run it again if you need what it said.`
          }
        }
      })
      return touched ? ({ ...message, content: rewritten } as ModelMessage) : message
    }

    if (images && message.role === 'user' && Array.isArray(message.content)) {
      const content = parts(message) as unknown as { type?: string; mediaType?: string }[]
      if (!content.some((part) => part?.type === 'image' || part?.type === 'file')) return message
      let touched = false
      const rewritten = content.map((part) => {
        if (part?.type !== 'image' && part?.type !== 'file') return part
        touched = true
        dropped++
        // Bytes, not characters: an image is resent in full on every step, and
        // the JSON it serialises to is the largest single thing in the file.
        freedChars += JSON.stringify(part).length
        return {
          type: 'text',
          text: `${DEHYDRATED} an attached ${part.mediaType ?? 'file'} from an earlier turn is no longer included.`
        }
      })
      return touched ? ({ ...message, content: rewritten } as ModelMessage) : message
    }

    return message
  })

  if (dropped === 0) return { history, dropped: 0, freedTokens: 0 }
  return { history: next, dropped, freedTokens: Math.ceil(freedChars / 4) }
}

/** Applies {@link dehydrate} to a stored session. */
export function dehydrateHistory(sessionId: string, options: DehydrateOptions = {}): Dehydration {
  const result = dehydrate(getHistory(sessionId), options)
  if (result.dropped === 0) return { dropped: 0, freedTokens: 0 }
  memory.set(sessionId, result.history)
  persist(sessionId)
  return { dropped: result.dropped, freedTokens: result.freedTokens }
}

/* ---------------- the budget ---------------- */

const NOTE_TAG = 'earlier-in-this-session'
const NOTE_PATTERN = new RegExp(`<${NOTE_TAG}(?:\\s+count="(\\d+)")?>\\n?([\\s\\S]*?)\\n?</${NOTE_TAG}>`)

/**
 * Roughly how many tokens the transcript is worth.
 *
 * Only a fallback: once a turn has run, `measuredTokens` is what the provider
 * actually charged and is used instead. Text is counted at four characters a
 * token; images are counted as nothing, deliberately. Their token cost is a
 * function of their dimensions, not their byte length, and the previous
 * measure — `JSON.stringify` over the whole transcript — serialised an image
 * `Buffer` into a JSON array of numbers at about two characters per byte. One
 * 1 MB screenshot read as 2.1M "characters", three and a half times the entire
 * budget, tripping compaction on its own. Worse, the bytes sit in the recent
 * messages that compaction keeps, so it could not help.
 */
export function estimateTokens(history: ModelMessage[]): number {
  let chars = 0
  for (const message of history) {
    chars += 16 // role and structural overhead
    if (typeof message.content === 'string') {
      chars += message.content.length
      continue
    }
    for (const part of parts(message)) {
      if (typeof part?.text === 'string') chars += part.text.length
      else if (part?.type === 'tool-result' || part?.type === 'tool-call') {
        // Not text, but real tokens: the arguments and the output.
        chars += JSON.stringify(part).length
      }
    }
  }
  return Math.ceil(chars / 4)
}

export interface CompactionOptions {
  /**
   * Tokens the provider charged for the assembled prefix on the most recent
   * step. The only honest measure of how full the window is.
   */
  measuredTokens?: number
  /** The model's window, less what the system prompt, tools and reply need. */
  budgetTokens?: number
  /** The share of the budget at which to fire. The sources converge on 0.7. */
  fraction?: number
  /** Fallback ceiling when the model declares no window. */
  maxChars?: number
  /** How many messages at the end stay verbatim. */
  keepRecent?: number
  /** Summarise regardless of the budget, because a person asked. */
  force?: boolean
}

/** Whether the transcript has outgrown its budget. */
export function shouldCompact(history: ModelMessage[], options: CompactionOptions = {}): boolean {
  const fraction = options.fraction ?? 0.7
  if (options.budgetTokens && options.budgetTokens > 0) {
    const used = options.measuredTokens ?? estimateTokens(history)
    return used > options.budgetTokens * fraction
  }
  return estimateTokens(history) * 4 > (options.maxChars ?? 600_000)
}

/** The summary carried by a note left by an earlier compaction, if there is one. */
function readNote(message: ModelMessage): { count: number; summary: string } | null {
  if (typeof message.content !== 'string') return null
  const found = NOTE_PATTERN.exec(message.content)
  if (!found) return null
  return { count: Number(found[1] ?? 0) || 0, summary: found[2] }
}

export interface Compaction {
  /** Messages replaced this time. */
  summarised: number
  /** Messages replaced across every compaction of this session. */
  total: number
  summary: string
}

/**
 * Turns the older part of a session into a summary, in place.
 *
 * Dropping the oldest messages to fit a cap — which is what this used to do —
 * meant a long session forgot its own beginning with no trace. The model stops
 * knowing what it decided an hour ago and nothing says so.
 *
 * The summariser is passed in rather than imported, so this module needs no
 * provider and the headless test can drive the whole path. It receives the
 * previous summary separately and whole, so each round *merges* rather than
 * re-summarising: a summary fed back through as just another message is the
 * item most likely to be truncated, and repeating that dissolves the oldest
 * decisions first.
 *
 * Returns what a person should be told, or null when nothing was needed.
 */
export async function compactHistory(
  sessionId: string,
  summarise: (input: { previous: string | null; messages: ModelMessage[] }) => Promise<string>,
  options: CompactionOptions = {}
): Promise<Compaction | null> {
  const keepRecent = options.keepRecent ?? 8

  const history = getHistory(sessionId)
  if (!options.force && !shouldCompact(history, options)) return null
  // Nothing to gain from summarising a handful of messages; over budget with
  // this few means they are individually enormous, and cutting them would lose
  // more than it saves.
  if (history.length <= keepRecent + 2) return null

  const cut = safeBoundary(history, history.length - keepRecent)
  if (cut <= 0) return null

  const older = history.slice(0, cut)
  const recent = history.slice(cut)

  // A note from a previous round is carried, not re-summarised.
  let previous: string | null = null
  let alreadySummarised = 0
  const chunk: ModelMessage[] = []
  for (const message of older) {
    const note = readNote(message)
    if (note) {
      previous = note.summary
      alreadySummarised = note.count
    } else {
      chunk.push(message)
    }
  }
  if (chunk.length === 0) return null

  let summary: string
  try {
    summary = (await summarise({ previous, messages: chunk })).trim()
  } catch {
    // A failed summary must not take the conversation with it: leave the
    // transcript alone and let the next turn try again.
    return null
  }
  if (!summary) return null

  const total = alreadySummarised + chunk.length
  const note: ModelMessage = {
    role: 'user',
    content:
      `<${NOTE_TAG} count="${total}">\n${summary}\n</${NOTE_TAG}>\n\n` +
      `That is a summary of the ${total} messages before this point, which are no longer being ` +
      `resent. Treat it as established fact. If you need a detail it does not contain, read the ` +
      `files rather than guessing.`
  }

  memory.set(sessionId, [note, ...recent])
  persist(sessionId)
  return { summarised: chunk.length, total, summary }
}

/** Copies one session's model transcript onto another, for a fork. */
export function copyHistory(fromId: string, toId: string): void {
  const source = getHistory(fromId)
  if (source.length === 0) return
  memory.set(toId, structuredClone(source))
  persist(toId)
}
