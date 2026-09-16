import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { nanoid } from 'nanoid'
import type { Block, Message, MessagePart, Session, SessionStatus } from '@shared/types'
import { DATA_DIR } from './config'
import { copyHistory } from './history'
import type { SessionMode } from '@shared/modes'
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
  mode?: SessionMode
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
    mode: input.mode,
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

/** Every session spawned by this one, however deep. */
function descendantsOf(id: string): Session[] {
  const out: Session[] = []
  const queue = [id]
  const seen = new Set<string>([id])
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const file of sessions.values()) {
      const child = file.session
      if (child.parentSessionId !== current || seen.has(child.id)) continue
      seen.add(child.id)
      out.push(child)
      queue.push(child.id)
    }
  }
  return out
}

/**
 * A copy of a conversation, to take it somewhere else without losing where it
 * has been. Independent of the original: deleting either leaves the other whole.
 *
 * The subagent sessions come too. A task block points at the session that ran
 * it, so copying only the parent would leave the fork's subchats reading from
 * the original's runs — one delete away from being empty, and one reply away
 * from diverging. The whole tree is copied and every reference is remapped:
 * blocks get fresh ids and the message parts that point at them follow, task
 * blocks point at the copied child, and each child's parent is the copied
 * parent.
 *
 * Everything lands idle. A copied transcript is a record of work that already
 * happened, not work in flight.
 */
export function forkSession(
  id: string,
  overrides?: { title?: string; boardId?: string; columnId?: string; standalone?: boolean }
): Session | undefined {
  const root = sessions.get(id)
  if (!root) return undefined

  const originals = [root.session, ...descendantsOf(id)]
  const now = Date.now()

  // Every id is minted first, so a reference can be remapped whichever order
  // the sessions are copied in.
  const sessionIds = new Map<string, string>()
  for (const original of originals) sessionIds.set(original.id, nanoid(12))

  const blockIds = new Map<string, string>()
  for (const original of originals) {
    for (const block of sessions.get(original.id)?.blocks ?? []) blockIds.set(block.id, nanoid(12))
  }

  const created: Session[] = []

  for (const original of originals) {
    const file = sessions.get(original.id)
    if (!file) continue
    const isRoot = original.id === id
    const freshId = sessionIds.get(original.id)!

    const session: Session = {
      ...original,
      id: freshId,
      title: isRoot ? (overrides?.title ?? `${original.title} (fork)`) : original.title,
      status: 'idle',
      createdAt: now,
      updatedAt: now,
      pinned: false,
      archived: false,
      blockedReason: undefined,
      queuedPrompt: undefined,
      relatedSessionIds: undefined,
      order: now,
      // The copied tree moves as a unit, so a subagent lands on the same board
      // and in the same column as the parent it belongs to.
      boardId: overrides?.boardId ?? original.boardId,
      columnId: overrides?.columnId ?? original.columnId,
      parentSessionId: isRoot
        ? overrides?.standalone
          ? undefined
          : original.parentSessionId
        : sessionIds.get(original.parentSessionId ?? '') ?? original.parentSessionId,
      taskLabel: isRoot && overrides?.standalone ? undefined : original.taskLabel
    }

    const blocks: Block[] = file.blocks.map((block) => {
      const childSessionId = block.input?.childSessionId
      return {
        ...block,
        id: blockIds.get(block.id) ?? nanoid(12),
        sessionId: freshId,
        parentBlockId: block.parentBlockId ? blockIds.get(block.parentBlockId) : undefined,
        input:
          typeof childSessionId === 'string'
            ? { ...block.input, childSessionId: sessionIds.get(childSessionId) ?? childSessionId }
            : { ...block.input }
      }
    })

    const messages: Message[] = file.messages.map((message) => ({
      ...message,
      id: nanoid(12),
      sessionId: freshId,
      parts: message.parts.map((part) =>
        part.blockId ? { ...part, blockId: blockIds.get(part.blockId) ?? part.blockId } : { ...part }
      )
    }))

    sessions.set(freshId, { session, messages, blocks })
    markDirty(freshId)
    // The model-facing transcript is the other half of a session; a fork that
    // copied only what a person reads would start the next turn amnesiac.
    copyHistory(original.id, freshId)
    created.push(session)
  }

  for (const session of created) bus.emit({ type: 'session.created', session })
  return sessions.get(sessionIds.get(id)!)?.session
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
