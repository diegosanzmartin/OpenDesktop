import clsx from 'clsx'
import { useMemo, type ReactNode } from 'react'
import {
  ChevronDown,
  ChevronRight,
  Download,
  FileDiff,
  FilePlus2,
  FileText,
  FolderTree,
  Globe,
  Search,
  Terminal,
  Users
} from 'lucide-react'
import type { Block } from '@shared/types'
import { useStore } from '../state/store'
import { STATUS_COLOR, STATUS_LABEL, TOOL_LABEL, duration, stripAnsi } from '../lib/format'
import { StatusDot } from './ui'

const ICONS: Record<string, typeof Terminal> = {
  bash: Terminal,
  read: FileText,
  write: FilePlus2,
  edit: FileDiff,
  grep: Search,
  glob: FolderTree,
  list: FolderTree,
  fetch: Globe,
  task: Users
}

function DiffBody({ text }: { text: string }): ReactNode {
  return (
    <pre className="font-mono text-[11px] leading-[1.5]">
      {text.split('\n').map((line, index) => (
        <div
          key={index}
          className={clsx(
            'px-3',
            line.startsWith('+') && 'bg-ok/10 text-ok',
            line.startsWith('-') && 'bg-bad/10 text-bad',
            !line.startsWith('+') && !line.startsWith('-') && 'text-ink-400'
          )}
        >
          {line || ' '}
        </div>
      ))}
    </pre>
  )
}

/**
 * One tool call, rendered as its own collapsible block: a single clickable
 * summary line, and on expand the exact input plus the live output.
 */
export function BlockCard({ block, compact }: { block: Block; compact?: boolean }): ReactNode {
  const expanded = useStore((s) => s.expanded[block.id] ?? false)
  const toggle = useStore((s) => s.toggleBlock)
  const sessions = useStore((s) => s.sessions)
  const selectSession = useStore((s) => s.selectSession)
  const previewFile = usePreviewOpener()

  const Icon = ICONS[block.tool] ?? Terminal
  const isDiff = block.tool === 'edit' || block.tool === 'write'
  const output = useMemo(() => stripAnsi(block.output), [block.output])
  const childSessionId =
    typeof block.input.childSessionId === 'string' ? block.input.childSessionId : null
  const childSession = useMemo(
    () => (childSessionId ? sessions.find((s) => s.id === childSessionId) : undefined),
    [childSessionId, sessions]
  )
  const filePath = typeof block.input.path === 'string' ? block.input.path : null

  return (
    <div
      className={clsx(
        'border-ink-700 bg-ink-850 overflow-hidden rounded-md border',
        block.status === 'error' && 'border-bad/40',
        block.status === 'awaiting-approval' && 'border-warn/50'
      )}
    >
      <button
        type="button"
        onClick={() => toggle(block.id)}
        className="hover:bg-ink-800 flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
      >
        {expanded ? (
          <ChevronDown className="text-ink-500 h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="text-ink-500 h-3 w-3 shrink-0" />
        )}
        <Icon className="text-ink-400 h-3.5 w-3.5 shrink-0" />
        <span className="text-ink-500 shrink-0 text-[10px] font-semibold uppercase tracking-wide">
          {TOOL_LABEL[block.tool] ?? block.tool}
        </span>
        <span
          className={clsx(
            'min-w-0 flex-1 truncate font-mono text-[11.5px]',
            block.status === 'error' ? 'text-bad' : 'text-ink-100'
          )}
        >
          {block.title}
        </span>
        {block.subtitle && !compact ? (
          <span className="text-ink-500 shrink-0 truncate text-[10.5px]">{block.subtitle}</span>
        ) : null}
        <span className={clsx('shrink-0 text-[10px]', STATUS_COLOR[block.status])}>
          {block.status === 'running' || block.status === 'awaiting-approval'
            ? STATUS_LABEL[block.status]
            : duration(block)}
        </span>
        <StatusDot status={block.status} />
      </button>

      {expanded ? (
        <div className="border-ink-700 border-t">
          <div className="bg-ink-900 px-3 py-2">
            <div className="text-ink-500 mb-1 text-[10px] font-semibold uppercase tracking-wide">Input</div>
            {block.tool === 'bash' ? (
              <pre className="text-ink-200 whitespace-pre-wrap break-all font-mono text-[11.5px]">
                <span className="text-brand">$ </span>
                {String(block.input.command ?? '')}
              </pre>
            ) : (
              <pre className="text-ink-300 whitespace-pre-wrap break-all font-mono text-[11px]">
                {Object.entries(block.input)
                  .filter(([, value]) => value !== undefined && value !== '')
                  .map(([key, value]) => {
                    const text = typeof value === 'string' ? value : JSON.stringify(value)
                    const clipped = text.length > 600 ? `${text.slice(0, 600)}…` : text
                    return `${key}: ${clipped}`
                  })
                  .join('\n')}
              </pre>
            )}
            <div className="text-ink-600 mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px]">
              <span className="font-mono">{block.cwd}</span>
              <span>{block.environmentId}</span>
              <span>{block.agentId}</span>
              {block.exitCode !== undefined ? <span>exit {block.exitCode}</span> : null}
              {filePath ? (
                <button
                  type="button"
                  className="text-brand hover:underline"
                  onClick={(event) => {
                    event.stopPropagation()
                    void previewFile(block.environmentId, filePath)
                  }}
                >
                  Open in browser
                </button>
              ) : null}
              {childSession ? (
                <button
                  type="button"
                  className="text-brand hover:underline"
                  onClick={(event) => {
                    event.stopPropagation()
                    void selectSession(childSession.id)
                  }}
                >
                  Open subagent session
                </button>
              ) : null}
            </div>
          </div>

          <div className="border-ink-700 max-h-[420px] overflow-auto border-t">
            {block.error ? (
              <div className="text-bad bg-bad/5 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
                {block.error}
              </div>
            ) : null}
            {output ? (
              isDiff ? (
                <div className="py-1">
                  <DiffBody text={output} />
                </div>
              ) : (
                <pre className="text-ink-300 px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-all">
                  {output}
                </pre>
              )
            ) : block.status === 'running' ? (
              <div className="text-ink-500 px-3 py-2 text-[11px] italic">waiting for output…</div>
            ) : !block.error ? (
              <div className="text-ink-600 px-3 py-2 text-[11px] italic">no output</div>
            ) : null}
          </div>

          {output.length > 4000 ? (
            <div className="border-ink-700 flex items-center gap-2 border-t px-3 py-1.5">
              <Download className="text-ink-500 h-3 w-3" />
              <span className="text-ink-500 text-[10px]">
                {output.length.toLocaleString('en-GB')} characters of output
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Opens a path in the integrated browser pane. */
export function usePreviewOpener(): (environmentId: string, path: string) => Promise<void> {
  const setBrowserUrl = useStore((s) => s.setBrowserUrl)
  const setPane = useStore((s) => s.setPane)
  return async (environmentId, path) => {
    const url = await window.opendesktop.files.previewUrl(environmentId, path)
    setBrowserUrl(url)
    setPane('browser')
  }
}
