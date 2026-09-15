import clsx from 'clsx'
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import type { Block, Message, MessagePart } from '@shared/types'
import { useStore } from '../state/store'
import { duration } from '../lib/format'
import { BlockCard } from './BlockCard'
import { Markdown } from './Markdown'

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function filePath(block: Block): string | null {
  return typeof block.input.path === 'string' ? block.input.path : null
}

function count(n: number, one: string, many: string): string {
  return n === 1 ? `a ${one}` : `${n} ${many}`
}

/**
 * Turns a run of tool calls into the one-line summary the transcript shows
 * collapsed — "Created secrets.ts, ran 2 commands". A single call of a kind is
 * named after its file when it has one, which reads far better than a count.
 */
function summarize(blocks: Block[]): string {
  const by = (tool: string): Block[] => blocks.filter((b) => b.tool === tool)
  const parts: string[] = []

  const writes = by('write')
  const created = writes.filter((b) => (b.removed ?? 0) === 0)
  const overwritten = writes.filter((b) => (b.removed ?? 0) > 0)
  if (created.length === 1) parts.push(`created ${basename(filePath(created[0]) ?? 'a file')}`)
  else if (created.length > 1) parts.push(`created ${created.length} files`)
  if (overwritten.length === 1) parts.push(`rewrote ${basename(filePath(overwritten[0]) ?? 'a file')}`)
  else if (overwritten.length > 1) parts.push(`rewrote ${overwritten.length} files`)

  const edits = by('edit')
  if (edits.length === 1) parts.push(`updated ${basename(filePath(edits[0]) ?? 'a file')}`)
  else if (edits.length > 1) parts.push(`updated ${edits.length} files`)

  const commands = by('bash')
  if (commands.length > 0) parts.push(`ran ${count(commands.length, 'command', 'commands')}`)

  const reads = by('read')
  if (reads.length === 1) parts.push(`read ${basename(filePath(reads[0]) ?? 'a file')}`)
  else if (reads.length > 1) parts.push(`read ${reads.length} files`)

  const searches = by('grep').length + by('glob').length
  if (searches > 0) parts.push(`ran ${count(searches, 'search', 'searches')}`)

  const lists = by('list')
  if (lists.length > 0) parts.push(`listed ${count(lists.length, 'directory', 'directories')}`)

  const fetches = by('fetch')
  if (fetches.length > 0) parts.push(`fetched ${count(fetches.length, 'page', 'pages')}`)

  if (parts.length === 0) return 'Ran a tool'
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

/* ---------------- subagents ---------------- */

/**
 * A delegated task, rendered as its own small transcript inside the parent's.
 * The subagent works with no memory of this conversation, so showing what it
 * actually did — not just its closing report — is the only way to judge it.
 */
function SubChat({ block }: { block: Block }): ReactNode {
  const [open, setOpen] = useState(false)
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)
  const allMessages = useStore((s) => s.messages)

  const childId = typeof block.input.childSessionId === 'string' ? block.input.childSessionId : null
  const child = childId ? sessions.find((s) => s.id === childId) : undefined
  const agentId = typeof block.input.agent === 'string' ? block.input.agent : child?.agentId
  const agent = agentId ? config?.agent[agentId] : undefined
  const messages = childId ? (allMessages[childId] ?? []) : []
  const assistant = messages.filter((m) => m.role === 'assistant')

  const running = block.status === 'running' || block.status === 'pending'
  const failed = block.status === 'error'
  const color = agent?.color ?? 'var(--color-brand)'

  return (
    <div
      className={clsx(
        'border-ink-800 bg-ink-850/40 my-1.5 overflow-hidden rounded-lg border',
        failed && 'border-bad/40'
      )}
    >
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="hover:bg-ink-850 flex w-full items-center gap-2 px-3 py-2 text-left"
      >
        <span
          className={clsx('h-2 w-2 shrink-0 rounded-full', running && 'animate-pulse')}
          style={{ background: color }}
        />
        <span className="shrink-0 text-[12px] font-medium" style={{ color }}>
          {agent?.name ?? agentId ?? 'Subagent'}
        </span>
        <span className="text-ink-200 min-w-0 flex-1 truncate text-[13px]">{block.title}</span>
        <span className={clsx('shrink-0 text-[11px]', failed ? 'text-bad' : 'text-ink-600')}>
          {running ? 'working…' : duration(block)}
        </span>
        <ChevronRight
          className={clsx('text-ink-600 h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
        />
      </button>

      {open ? (
        <div className="border-ink-800 border-t px-3 py-2">
          <div className="text-ink-600 mb-2 text-[11.5px]">
            Its brief: {String(block.input.prompt ?? '').slice(0, 400)}
          </div>
          {assistant.length === 0 ? (
            <div className="text-ink-600 text-[12px] italic">
              {running ? 'Starting…' : 'It produced no transcript.'}
            </div>
          ) : (
            <div className="space-y-2">
              {assistant.map((message) => (
                <MessageParts key={message.id} message={message} nested />
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  )
}

/* ---------------- tool groups ---------------- */

export function ToolGroup({ blocks }: { blocks: Block[] }): ReactNode {
  const [open, setOpen] = useState(false)

  // Delegations get their own card; they are work, not a tool call.
  const tasks = blocks.filter((b) => b.tool === 'task')
  const rest = blocks.filter((b) => b.tool !== 'task')

  const summary = useMemo(() => summarize(rest), [rest])
  const added = rest.reduce((sum, b) => sum + (b.added ?? 0), 0)
  const removed = rest.reduce((sum, b) => sum + (b.removed ?? 0), 0)

  const running = rest.some((b) => b.status === 'running' || b.status === 'pending')
  const awaiting = rest.some((b) => b.status === 'awaiting-approval')
  const failed = rest.some((b) => b.status === 'error')

  return (
    <>
      {tasks.length > 1 ? (
        <div className="text-ink-600 mt-2 text-[11.5px]">
          {tasks.length} agents working in parallel
        </div>
      ) : null}
      {tasks.map((task) => (
        <SubChat key={task.id} block={task} />
      ))}

      {rest.length > 0 ? (
        <div className="my-1">
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="group flex w-full items-center gap-1.5 py-[3px] text-left"
          >
            <span
              className={clsx(
                'truncate text-[13.5px]',
                failed ? 'text-bad' : awaiting ? 'text-warn' : 'text-ink-500 group-hover:text-ink-300'
              )}
            >
              {awaiting ? 'Waiting for approval' : running ? `${summary}…` : summary}
            </span>
            {added > 0 ? <span className="text-ok shrink-0 font-mono text-[12px]">+{added}</span> : null}
            {removed > 0 ? (
              <span className="text-bad shrink-0 font-mono text-[12px]">-{removed}</span>
            ) : null}
            <ChevronRight
              className={clsx(
                'text-ink-600 group-hover:text-ink-400 h-3.5 w-3.5 shrink-0 transition-transform',
                open && 'rotate-90'
              )}
            />
          </button>

          {open ? (
            <div className="mt-1.5 space-y-1.5 pb-1">
              {rest.map((block) => (
                <BlockCard key={block.id} block={block} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}
    </>
  )
}

/* ---------------- message bodies ---------------- */

type Chunk = { kind: 'parts'; parts: MessagePart[] } | { kind: 'tools'; blocks: Block[] }

function chunkParts(parts: MessagePart[], blocks: Record<string, Block>): Chunk[] {
  const out: Chunk[] = []
  for (const part of parts) {
    if (part.type === 'block') {
      const block = part.blockId ? blocks[part.blockId] : undefined
      if (!block) continue
      const last = out[out.length - 1]
      if (last && last.kind === 'tools') last.blocks.push(block)
      else out.push({ kind: 'tools', blocks: [block] })
    } else {
      const last = out[out.length - 1]
      if (last && last.kind === 'parts') last.parts.push(part)
      else out.push({ kind: 'parts', parts: [part] })
    }
  }
  return out
}

/** The body of one assistant message: prose, reasoning, tool groups, subchats. */
export function MessageParts({
  message,
  nested
}: {
  message: Message
  nested?: boolean
}): ReactNode {
  const blocks = useStore((s) => s.blocks)
  const chunks = chunkParts(message.parts, blocks)

  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.kind === 'tools' ? (
          <ToolGroup key={index} blocks={chunk.blocks} />
        ) : (
          <div key={index} className={nested ? 'space-y-1' : 'space-y-2 py-1'}>
            {chunk.parts.map((part, partIndex) => {
              if (part.type === 'reasoning') {
                return part.text?.trim() ? <Reasoning key={partIndex} text={part.text} /> : null
              }
              if (part.type === 'error') {
                return (
                  <div
                    key={partIndex}
                    className="border-bad/40 bg-bad/10 text-bad flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]"
                  >
                    <TriangleAlert className="mt-[3px] h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-pre-wrap">{part.text}</span>
                  </div>
                )
              }
              const streaming =
                !message.completedAt &&
                index === chunks.length - 1 &&
                partIndex === chunk.parts.length - 1
              return part.text?.trim() ? (
                <Markdown key={partIndex} text={part.text} streaming={streaming} />
              ) : null
            })}
          </div>
        )
      )}
    </>
  )
}

export function Reasoning({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group flex items-center gap-1.5 py-[3px] text-left"
      >
        <span className="text-ink-500 group-hover:text-ink-300 text-[13.5px] italic">
          Thought for a moment
        </span>
        <ChevronRight
          className={clsx('text-ink-600 h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <div className="border-ink-800 text-ink-400 mt-1 border-l pl-3 text-[13px] leading-[1.65] whitespace-pre-wrap italic">
          {text}
        </div>
      ) : null}
    </div>
  )
}

/* ---------------- end-of-turn file summary ---------------- */

export function EditedFiles({ blocks }: { blocks: Block[] }): ReactNode {
  const openDock = useStore((s) => s.openDock)
  const refreshChanges = useStore((s) => s.refreshChanges)

  const files = useMemo(() => {
    const map = new Map<string, { path: string; added: number; removed: number }>()
    for (const block of blocks) {
      if (block.tool !== 'write' && block.tool !== 'edit') continue
      if (block.status !== 'success') continue
      const path = filePath(block)
      if (!path) continue
      const entry = map.get(path) ?? { path, added: 0, removed: 0 }
      entry.added += block.added ?? 0
      entry.removed += block.removed ?? 0
      map.set(path, entry)
    }
    return [...map.values()]
  }, [blocks])

  if (files.length === 0) return null

  return (
    <div className="border-ink-800 mt-3 overflow-hidden rounded-lg border">
      <div className="border-ink-800 flex items-center gap-2 border-b px-3 py-2">
        <span className="text-ink-200 text-[12.5px]">
          {files.length === 1 ? 'Edited 1 file' : `Edited ${files.length} files`}
        </span>
        <button
          type="button"
          onClick={() => {
            openDock('changes')
            void refreshChanges()
          }}
          className="bg-ink-800 text-ink-200 hover:bg-ink-700 ml-auto rounded px-2 py-[3px] text-[11.5px]"
        >
          View changes
        </button>
      </div>
      {files.map((file) => (
        <div key={file.path} className="flex items-center gap-2 px-3 py-[5px]">
          <span className="text-ink-600 shrink-0 font-mono text-[10px]">&lt;/&gt;</span>
          <span className="text-ink-300 min-w-0 flex-1 truncate font-mono text-[11.5px]">
            {basename(file.path)}
          </span>
          {file.added > 0 ? <span className="text-ok font-mono text-[11px]">+{file.added}</span> : null}
          {file.removed > 0 ? (
            <span className="text-bad font-mono text-[11px]">-{file.removed}</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}
