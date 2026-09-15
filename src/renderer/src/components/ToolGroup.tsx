import clsx from 'clsx'
import { useMemo, useState, type ReactNode } from 'react'
import { ChevronRight } from 'lucide-react'
import type { Block } from '@shared/types'
import { BlockCard } from './BlockCard'
import { useStore } from '../state/store'

function basename(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

function filePath(block: Block): string | null {
  return typeof block.input.path === 'string' ? block.input.path : null
}

/** "a command" / "2 commands" — the shape the summary line uses. */
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

  const tasks = by('task')
  for (const task of tasks) parts.push(`delegated "${task.title}"`)

  if (parts.length === 0) return 'Ran a tool'
  const text = parts.join(', ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function ToolGroup({ blocks }: { blocks: Block[] }): ReactNode {
  const [open, setOpen] = useState(false)

  const summary = useMemo(() => summarize(blocks), [blocks])
  const added = blocks.reduce((sum, b) => sum + (b.added ?? 0), 0)
  const removed = blocks.reduce((sum, b) => sum + (b.removed ?? 0), 0)

  const running = blocks.some((b) => b.status === 'running' || b.status === 'pending')
  const awaiting = blocks.some((b) => b.status === 'awaiting-approval')
  const failed = blocks.some((b) => b.status === 'error')

  return (
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
        {removed > 0 ? <span className="text-bad shrink-0 font-mono text-[12px]">-{removed}</span> : null}
        <ChevronRight
          className={clsx(
            'text-ink-600 group-hover:text-ink-400 h-3.5 w-3.5 shrink-0 transition-transform',
            open && 'rotate-90'
          )}
        />
      </button>

      {open ? (
        <div className="mt-1.5 space-y-1.5 pb-1">
          {blocks.map((block) => (
            <BlockCard key={block.id} block={block} />
          ))}
        </div>
      ) : null}
    </div>
  )
}

/**
 * The end-of-turn summary of everything that changed on disk, mirroring the
 * card other agent tools show once a turn settles.
 */
export function EditedFiles({ blocks }: { blocks: Block[] }): ReactNode {
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
        <ViewChangesButton />
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

function ViewChangesButton(): ReactNode {
  const openDock = useStore((s) => s.openDock)
  const refreshChanges = useStore((s) => s.refreshChanges)
  return (
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
  )
}
