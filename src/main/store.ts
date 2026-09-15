import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { Block, Message, MessagePart, Session, SessionStatus } from '@shared/types'
import { DATA_DIR } from './config'
import { bus } from './bus'

const SESSIONS_DIR = join(DATA_DIR, 'sessions')
const INDEX_PATH = join(DATA_DIR, 'index.json')

interface SessionFile {
  session: Session
  messages: Message[]
  blocks: Block[]
}

const sessions = new Map<string, SessionFile>()
const dirty = new Set<string>()
let flushTimer: NodeJS.Timeout | null = null

function ensureDirs(): void {
  mkdirSync(SESSIONS_DIR, { recursive: true })
}

function markDirty(id: string): void {
  dirty.add(id)
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, 400)
}

export function flush(): void {
  ensureDirs()
  for (const id of dirty) {
    const file = sessions.get(id)
    if (!file) continue
    writeFileSync(join(SESSIONS_DIR, `${id}.json`), JSON.stringify(file), 'utf8')
  }
  dirty.clear()
  writeFileSync(
    INDEX_PATH,
    JSON.stringify({ order: [...sessions.keys()], version: 1 }, null, 2),
    'utf8'
  )
}

export function loadStore(): void {
  ensureDirs()
  if (!existsSync(SESSIONS_DIR)) return
  for (const name of readdirSync(SESSIONS_DIR)) {
    if (!name.endsWith('.json')) continue
    try {
      const file = JSON.parse(readFileSync(join(SESSIONS_DIR, name), 'utf8')) as SessionFile
      // Anything left mid-flight from a previous run is no longer running.
      if (file.session.status === 'running' || file.session.status === 'awaiting-approval') {
        file.session.status = 'idle'
      }
      for (const block of file.blocks) {
        if (block.status === 'running' || block.status === 'pending' || block.status === 'awaiting-approval') {
          block.status = 'canceled'
          block.endedAt = block.endedAt ?? Date.now()
        }
      }
      sessions.set(file.session.id, file)
    } catch {
      /* skip corrupt session file */
    }
  }
}

/* ---------------- sessions ---------------- */

export function listSessions(): Session[] {
  return [...sessions.values()].map((f) => f.session).sort((a, b) => b.updatedAt - a.updatedAt)
}

export function getSession(id: string): Session | undefined {
  return sessions.get(id)?.session
}

export function createSession(input: {
  title?: string
  cwd: string
  environmentId: string
  agentId: string
  model: string
  parentSessionId?: string
}): Session {
  const now = Date.now()
  const session: Session = {
    id: nanoid(12),
    title: input.title ?? 'New session',
    cwd: input.cwd,
    environmentId: input.environmentId,
    agentId: input.agentId,
    model: input.model,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    usage: { input: 0, output: 0, cost: 0 },
    parentSessionId: input.parentSessionId
  }
  sessions.set(session.id, { session, messages: [], blocks: [] })
  markDirty(session.id)
  bus.emit({ type: 'session.created', session })
  return session
}

export function updateSession(id: string, patch: Partial<Session>): Session | undefined {
  const file = sessions.get(id)
  if (!file) return undefined
  Object.assign(file.session, patch, { updatedAt: Date.now() })
  markDirty(id)
  bus.emit({ type: 'session.updated', session: file.session })
  return file.session
}

export function setSessionStatus(id: string, status: SessionStatus): void {
  updateSession(id, { status })
}

/**
 * A copy of a conversation, to take it somewhere else without losing where it
 * has been.
 *
 * Blocks are copied with fresh ids and the message parts are remapped onto
 * them, because a part points at a block by id: reusing the originals would
 * give two sessions the same tool runs, and one deleting them would blank the
 * other's transcript. The model-facing history is copied separately by the
 * caller — this half is what a person reads, that half is what the model does.
 *
 * A task block's `childSessionId` is left pointing at the original subagent
 * run. Those sessions are not duplicated: the fork's transcript is a record of
 * what happened, and what happened was that run.
 */
export function forkSession(
  id: string,
  overrides?: { title?: string; boardId?: string; columnId?: string; standalone?: boolean }
): Session | undefined {
  const source = sessions.get(id)
  if (!source) return undefined

  const now = Date.now()
  const session: Session = {
    ...source.session,
    id: nanoid(12),
    title: overrides?.title ?? `${source.session.title} (fork)`,
    status: 'idle',
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    blockedReason: undefined,
    queuedPrompt: undefined,
    relatedSessionIds: undefined,
    boardId: overrides?.boardId ?? source.session.boardId,
    columnId: overrides?.columnId ?? source.session.columnId,
    order: now,
    // Moved to a board of its own, a fork is its own task rather than someone
    // else's subtask.
    parentSessionId: overrides?.standalone ? undefined : source.session.parentSessionId,
    taskLabel: overrides?.standalone ? undefined : source.session.taskLabel
  }

  const blockIds = new Map<string, string>()
  const blocks: Block[] = source.blocks.map((block) => {
    const fresh = nanoid(12)
    blockIds.set(block.id, fresh)
    return { ...block, id: fresh, sessionId: session.id }
  })
  for (const block of blocks) {
    if (block.parentBlockId) block.parentBlockId = blockIds.get(block.parentBlockId) ?? block.parentBlockId
  }

  const messages: Message[] = source.messages.map((message) => ({
    ...message,
    id: nanoid(12),
    sessionId: session.id,
    parts: message.parts.map((part) =>
      part.blockId ? { ...part, blockId: blockIds.get(part.blockId) ?? part.blockId } : { ...part }
    )
  }))

  sessions.set(session.id, { session, messages, blocks })
  markDirty(session.id)
  bus.emit({ type: 'session.created', session })
  return session
}

export function deleteSession(id: string): void {
  sessions.delete(id)
  dirty.delete(id)
  const path = join(SESSIONS_DIR, `${id}.json`)
  if (existsSync(path)) rmSync(path)
  flush()
  bus.emit({ type: 'session.deleted', sessionId: id })
}

/* ---------------- messages ---------------- */

export function listMessages(sessionId: string): Message[] {
  return sessions.get(sessionId)?.messages ?? []
}

export function addMessage(input: Omit<Message, 'id' | 'createdAt'> & { id?: string }): Message {
  const file = sessions.get(input.sessionId)
  if (!file) throw new Error(`unknown session ${input.sessionId}`)
  const message: Message = { ...input, id: input.id ?? nanoid(12), createdAt: Date.now() }
  file.messages.push(message)
  markDirty(file.session.id)
  bus.emit({ type: 'message.created', message })
  return message
}

export function updateMessage(sessionId: string, messageId: string, patch: Partial<Message>): void {
  const file = sessions.get(sessionId)
  const message = file?.messages.find((m) => m.id === messageId)
  if (!file || !message) return
  Object.assign(message, patch)
  markDirty(sessionId)
  bus.emit({ type: 'message.updated', message })
}

/** Appends a part and returns its index, so deltas can target it without resending the message. */
export function pushPart(sessionId: string, messageId: string, part: MessagePart): number {
  const file = sessions.get(sessionId)
  const message = file?.messages.find((m) => m.id === messageId)
  if (!file || !message) return -1
  message.parts.push(part)
  markDirty(sessionId)
  bus.emit({ type: 'message.updated', message })
  return message.parts.length - 1
}

export function appendPartText(
  sessionId: string,
  messageId: string,
  partIndex: number,
  text: string
): void {
  const file = sessions.get(sessionId)
  const message = file?.messages.find((m) => m.id === messageId)
  const part = message?.parts[partIndex]
  if (!file || !part) return
  part.text = (part.text ?? '') + text
  markDirty(sessionId)
  bus.emit({ type: 'message.part.delta', messageId, sessionId, partIndex, text })
}

/* ---------------- blocks ---------------- */

export function listBlocks(sessionId: string): Block[] {
  return sessions.get(sessionId)?.blocks ?? []
}

/** Every block across every session, newest first. Feeds the activity rail. */
export function allBlocks(limit = 500): Block[] {
  const out: Block[] = []
  for (const file of sessions.values()) out.push(...file.blocks)
  return out.sort((a, b) => b.createdAt - a.createdAt).slice(0, limit)
}

export function getBlock(sessionId: string, blockId: string): Block | undefined {
  return sessions.get(sessionId)?.blocks.find((b) => b.id === blockId)
}

export function createBlock(input: Omit<Block, 'id' | 'createdAt' | 'output' | 'status'> & {
  id?: string
  status?: Block['status']
}): Block {
  const file = sessions.get(input.sessionId)
  if (!file) throw new Error(`unknown session ${input.sessionId}`)
  const block: Block = {
    ...input,
    id: input.id ?? nanoid(12),
    output: '',
    status: input.status ?? 'pending',
    createdAt: Date.now()
  }
  file.blocks.push(block)
  markDirty(file.session.id)
  bus.emit({ type: 'block.created', block })
  return block
}

export function updateBlock(sessionId: string, blockId: string, patch: Partial<Block>): Block | undefined {
  const block = getBlock(sessionId, blockId)
  if (!block) return undefined
  Object.assign(block, patch)
  markDirty(sessionId)
  bus.emit({ type: 'block.updated', block })
  return block
}

const OUTPUT_CAP = 400_000

export function appendBlockOutput(sessionId: string, blockId: string, chunk: string): void {
  const block = getBlock(sessionId, blockId)
  if (!block) return
  if (block.output.length < OUTPUT_CAP) block.output += chunk
  markDirty(sessionId)
  bus.emit({ type: 'block.output', blockId, sessionId, chunk })
}

/** Distinct working directories seen across sessions — powers the folder filter. */
export function knownFolders(): string[] {
  const set = new Set<string>()
  for (const file of sessions.values()) set.add(file.session.cwd)
  return [...set].sort()
}
