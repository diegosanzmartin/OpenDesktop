import clsx from 'clsx'
import { useMemo, type ReactNode } from 'react'
import { ChevronDown, ChevronRight } from 'lucide-react'
import type { Block } from '@shared/types'
import { useStore } from '../state/store'
import { STATUS_COLOR, STATUS_LABEL, duration, stripAnsi } from '../lib/format'
import { DiffBody } from './DiffBody'

/**
 * The line a tool call gets in the transcript, and what it opens into.
 *
 * Deliberately close to bare: what happened, how long it took, and how it
 * ended. The tool's name, its icon, the folder, the host and the agent were all
 * repeating what the surrounding conversation already says, and a row of
 * labels around one command is harder to read than the command.
 */
export function BlockCard({ block }: { block: Block; compact?: boolean }): ReactNode {
  const expanded = useStore((s) => s.expanded[block.id] ?? false)
  const toggle = useStore((s) => s.toggleBlock)
  const sessions = useStore((s) => s.sessions)
  const selectSession = useStore((s) => s.selectSession)
  const previewFile = usePreviewOpener()

  const isDiff = block.tool === 'edit' || block.tool === 'write'
  const output = useMemo(() => stripAnsi(block.output), [block.output])
  const childSessionId =
    typeof block.input.childSessionId === 'string' ? block.input.childSessionId : null
  const childSession = useMemo(
    () => (childSessionId ? sessions.find((s) => s.id === childSessionId) : undefined),
    [childSessionId, sessions]
  )
  const filePath = typeof block.input.path === 'string' ? block.input.path : null
  const command = typeof block.input.command === 'string' ? block.input.command : null
  // What actually ran, when a mode changed it. rtk mode asks the model for
  // `git status` and runs `rtk git status`, and a transcript that only shows
  // the first is a transcript of something that did not happen.
  const ranAs = typeof block.input.ranAs === 'string' ? block.input.ranAs : null

  // What the agent said it was doing reads better than the command it typed;
  // the command itself is one click away.
  const heading = block.tool === 'bash' ? (block.subtitle ?? block.title) : block.title
  const failed = block.status === 'error' || Boolean(block.exitCode)

  return (
    <div className="border-ink-800/70 border-b last:border-b-0">
      <button
        type="button"
        onClick={() => toggle(block.id)}
        className="hover:bg-ink-850/60 flex w-full items-center gap-2 px-2.5 py-1.5 text-left transition-colors"
      >
        {expanded ? (
          <ChevronDown className="text-ink-600 h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="text-ink-600 h-3 w-3 shrink-0" />
        )}
        <span
          className={clsx(
            'min-w-0 flex-1 truncate text-[12.5px]',
            failed ? 'text-bad' : 'text-ink-300'
          )}
        >
          {heading}
        </span>

        {ranAs ? <span className="text-ink-700 shrink-0 text-[10.5px]">rtk</span> : null}

        {block.status === 'running' || block.status === 'awaiting-approval' ? (
          <span className={clsx('shrink-0 text-[10.5px]', STATUS_COLOR[block.status])}>
            {STATUS_LABEL[block.status]}
          </span>
        ) : (
          <span className="text-ink-600 shrink-0 text-[10.5px]">
            {duration(block)}
            {block.exitCode !== undefined ? (
              <span className={clsx('ml-1.5', block.exitCode ? 'text-bad' : 'text-ink-700')}>
                exit {block.exitCode}
              </span>
            ) : null}
          </span>
        )}
      </button>

      {expanded ? (
        <div className="px-2.5 pb-2">
          {command !== null ? (
            <pre className="bg-ink-900 text-ink-200 mb-1.5 overflow-x-auto rounded-md px-2.5 py-1.5 font-mono text-[11.5px] leading-[1.55] whitespace-pre-wrap break-all">
              <span className="text-brand">$ </span>
              {command}
              {ranAs ? (
                <span className="text-ink-600">
                  {'\n'}
                  {'# ran as: '}
                  {ranAs}
                </span>
              ) : null}
            </pre>
          ) : (
            <pre className="bg-ink-900 text-ink-400 mb-1.5 overflow-x-auto rounded-md px-2.5 py-1.5 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-all">
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

          {block.error ? (
            <pre className="text-bad mb-1 px-0.5 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap">
              {block.error}
            </pre>
          ) : null}

          <div className="max-h-[420px] overflow-auto">
            {output ? (
              isDiff ? (
                <DiffBody text={output} />
              ) : (
                <pre className="text-ink-400 px-0.5 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-all">
                  {output}
                </pre>
              )
            ) : block.status === 'running' ? (
              <div className="text-ink-600 px-0.5 text-[11px] italic">waiting for output…</div>
            ) : null}
          </div>

          {filePath || childSession ? (
            <div className="mt-1.5 flex items-center gap-3 px-0.5">
              {filePath ? (
                <button
                  type="button"
                  className="text-ink-600 hover:text-brand text-[10.5px]"
                  onClick={(event) => {
                    event.stopPropagation()
                    void previewFile(block.environmentId, filePath)
                  }}
                >
                  Open file
                </button>
              ) : null}
              {childSession ? (
                <button
                  type="button"
                  className="text-ink-600 hover:text-brand text-[10.5px]"
                  onClick={(event) => {
                    event.stopPropagation()
                    void selectSession(childSession.id)
                  }}
                >
                  Open its session
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/** Opens a path in the integrated browser, revealing the dock if it is closed. */
export function usePreviewOpener(): (environmentId: string, path: string) => Promise<void> {
  const setBrowserUrl = useStore((s) => s.setBrowserUrl)
  const openDock = useStore((s) => s.openDock)
  return async (environmentId, path) => {
    const url = await window.opendesktop.files.previewUrl(environmentId, path)
    setBrowserUrl(url)
    openDock('browser')
  }
}
