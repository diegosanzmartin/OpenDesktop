import clsx from 'clsx'
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import type { Block, Message, MessagePart } from '@shared/types'
import { useStore } from '../state/store'
import { mentionToken } from '@shared/mentions'
import { duration } from '../lib/format'
import { BlockCard } from './BlockCard'
import { DocumentCard } from './DocumentCard'
import { isDocument } from '@shared/documents'
import { isInWorkspace } from '@shared/workspace'
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
 * A delegated task: one line saying who has it and what it is, opening into
 * everything they actually did.
 *
 * Stripped to match a command block, for the same reason — the agent's own
 * colour already says which specialist this is, so a dot repeating it in the
 * same colour was decoration. It is named with @ because that is how you name
 * one in a message.
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
  const colour = agent?.color ?? 'var(--color-brand)'
  const brief = String(block.input.prompt ?? '').trim()

  return (
    <div className="border-ink-800/70 border-b last:border-b-0">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="hover:bg-ink-850/60 flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
      >
        {open ? (
          <ChevronDown className="text-ink-600 h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="text-ink-600 h-3 w-3 shrink-0" />
        )}
        <span className="shrink-0 text-[12.5px]" style={{ color: colour }}>
          {mentionToken({ id: agentId ?? 'agent', name: agent?.name ?? agentId ?? 'Subagent' })}
        </span>
        <span
          className={clsx('min-w-0 flex-1 truncate text-[12.5px]', failed ? 'text-bad' : 'text-ink-300')}
        >
          {block.title}
        </span>
        <span
          className={clsx('shrink-0 text-[10.5px]', running ? 'text-info' : 'text-ink-600')}
        >
          {running ? 'working…' : duration(block)}
        </span>
      </button>

      {open ? (
        <div className="px-2.5 pb-2">
          {brief ? (
            <div className="bg-ink-900 text-ink-400 mb-1.5 rounded-md px-2.5 py-1.5 text-[11.5px] leading-[1.55]">
              {brief.length > 600 ? `${brief.slice(0, 600)}…` : brief}
            </div>
          ) : null}
          {assistant.length === 0 ? (
            <div className="text-ink-600 px-0.5 text-[11.5px] italic">
              {running ? 'starting…' : 'it produced no transcript'}
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
      {tasks.length > 0 ? (
        // One container, as with the tool calls: how many agents are on it is
        // then plain from the rows rather than from a sentence above them.
        <div className="border-ink-800 my-1.5 overflow-hidden rounded-lg border">
          {tasks.map((task) => (
            <SubChat key={task.id} block={task} />
          ))}
        </div>
      ) : null}

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
            // One outlined container with the calls divided inside it, rather
            // than a stack of separate boxes: the group is the thing, and each
            // call is a line of it.
            <div className="border-ink-800 mt-1.5 mb-1 overflow-hidden rounded-lg border">
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
      /*
       * A handed-over file is drawn as its card, once, at the end of the
       * message. Drawing the call as well would say the same thing twice, in
       * the smaller of the two ways.
       */
      if (block.tool === 'deliver' && block.status === 'success') continue
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

  // Collected across the whole message, rendered where the first one sits.
  const thoughts = message.parts.filter((part) => part.type === 'reasoning' && part.text?.trim())
  const firstThought = thoughts[0]

  return (
    <>
      {chunks.map((chunk, index) =>
        chunk.kind === 'tools' ? (
          <ToolGroup key={index} blocks={chunk.blocks} />
        ) : (
          <div key={index} className={nested ? 'space-y-1' : 'space-y-2 py-1'}>
            {chunk.parts.map((part, partIndex) => {
              if (part.type === 'reasoning') {
                return part === firstThought ? (
                  <Reasoning
                    key={partIndex}
                    thoughts={thoughts.map((thought) => thought.text ?? '')}
                  />
                ) : null
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

/**
 * Every thought in one turn, behind one line.
 *
 * A turn that uses three tools thinks three times, and a separate "Thought for
 * a moment" between each step buried the work itself in labels for work that
 * is hidden anyway. They are gathered into one entry at the point of the first
 * one: nothing is dropped, they stay in order, and the transcript reads as what
 * the model did rather than as a list of times it paused.
 */
export function Reasoning({ thoughts }: { thoughts: string[] }): ReactNode {
  const [open, setOpen] = useState(false)
  if (thoughts.length === 0) return null

  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group flex items-center gap-1.5 py-[3px] text-left"
      >
        <span className="text-ink-500 group-hover:text-ink-300 text-[13.5px] italic">
          Thought for a moment
          {thoughts.length > 1 ? ` · ${thoughts.length} times` : ''}
        </span>
        <ChevronRight
          className={clsx('text-ink-600 h-3.5 w-3.5 transition-transform', open && 'rotate-90')}
        />
      </button>
      {open ? (
        <div className="border-ink-800 mt-1 space-y-2 border-l pl-3">
          {thoughts.map((thought, index) => (
            <div
              key={index}
              className="text-ink-400 text-[13px] leading-[1.65] whitespace-pre-wrap italic"
            >
              {thought}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/* ---------------- end-of-turn file summary ---------------- */

export function EditedFiles({ blocks }: { blocks: Block[] }): ReactNode {
  const workspacesRoot = useStore((s) => s.workspacesRoot)
  const written = useMemo(() => {
    const map = new Map<string, { path: string; environmentId: string; added: number; removed: number }>()
    for (const block of blocks) {
      if (block.tool !== 'write' && block.tool !== 'edit') continue
      if (block.status !== 'success') continue
      const path = filePath(block)
      if (!path) continue
      const entry =
        map.get(path) ?? { path, environmentId: block.environmentId, added: 0, removed: 0 }
      entry.added += block.added ?? 0
      entry.removed += block.removed ?? 0
      map.set(path, entry)
    }
    return [...map.values()]
  }, [blocks])

  /*
   * What was handed over, which is not the same as what was written.
   *
   * A report is made by a script, not by the write tool, so this used to know
   * nothing about the one file the whole turn was for: it sat on disk and the
   * conversation said "Ran 4 commands". A handed-over file always gets a card,
   * whatever its extension — that is what handing it over means.
   */
  const delivered = useMemo(() => {
    const map = new Map<string, { path: string; environmentId: string }>()
    for (const block of blocks) {
      if (block.tool !== 'deliver' || block.status !== 'success') continue
      const paths = (block.input as { paths?: unknown })?.paths
      if (!Array.isArray(paths)) continue
      for (const path of paths) {
        if (typeof path === 'string') map.set(path, { path, environmentId: block.environmentId })
      }
    }
    return [...map.values()]
  }, [blocks])

  /*
   * A document is something to open; a source file is something to diff.
   *
   * Except in the conversation's own folder, where everything is something to
   * open: there is no project to diff against, the file exists because this
   * conversation made it, and a `.mobileconfig` or a `.sh` written there is
   * exactly as much the point as a PDF would be.
   */
  const handed = new Set(delivered.map((file) => file.path))
  const openable = (file: { path: string }): boolean =>
    isDocument(file.path) || isInWorkspace(workspacesRoot, file.path)
  const documents = [...delivered, ...written.filter((file) => openable(file) && !handed.has(file.path))]
  const files = written.filter((file) => !openable(file) && !handed.has(file.path))

  if (written.length === 0 && delivered.length === 0) return null

  return (
    <>
      {documents.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {documents.map((file) => (
            <DocumentCard key={file.path} path={file.path} environmentId={file.environmentId} />
          ))}
        </div>
      ) : null}
      {files.length > 0 ? <CodeFiles files={files} /> : null}
    </>
  )
}

function CodeFiles({
  files
}: {
  files: { path: string; added: number; removed: number }[]
}): ReactNode {
  const openDock = useStore((s) => s.openDock)
  const refreshChanges = useStore((s) => s.refreshChanges)

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
