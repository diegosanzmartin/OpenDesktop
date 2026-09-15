import clsx from 'clsx'
import type { ReactNode } from 'react'

/**
 * Renders a unified diff, or the compact `+/-` preview the tools produce.
 * Hunk headers are dimmed so the eye lands on the changed lines.
 */
export function DiffBody({ text, max = 2000 }: { text: string; max?: number }): ReactNode {
  const lines = text.split('\n')
  const shown = lines.slice(0, max)

  return (
    <pre className="font-mono text-[11px] leading-[1.55]">
      {shown.map((line, index) => {
        const isMeta =
          line.startsWith('diff --git') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ') ||
          line.startsWith('new file') ||
          line.startsWith('deleted file')
        const isHunk = line.startsWith('@@')
        const isAdd = !isMeta && line.startsWith('+')
        const isDel = !isMeta && line.startsWith('-')
        return (
          <div
            key={index}
            className={clsx(
              'px-3',
              isAdd && 'bg-ok/10 text-ok',
              isDel && 'bg-bad/10 text-bad',
              isHunk && 'text-info/70 bg-ink-800/40',
              isMeta && 'text-ink-600',
              !isAdd && !isDel && !isHunk && !isMeta && 'text-ink-400'
            )}
          >
            {line || ' '}
          </div>
        )
      })}
      {lines.length > max ? (
        <div className="text-ink-600 px-3 py-1">… {lines.length - max} more lines</div>
      ) : null}
    </pre>
  )
}
