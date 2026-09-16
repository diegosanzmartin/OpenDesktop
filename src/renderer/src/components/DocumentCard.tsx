import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { Download } from 'lucide-react'
import { extensionOf, fileSize } from '@shared/documents'
import { usePreviewOpener } from './BlockCard'

/**
 * A document the agent produced, as something you can open.
 *
 * A report, a spreadsheet or a diagram is not a diff — nobody wants to read
 * `+47` about a PDF. It gets a card with its kind, its name and its weight:
 * clicking it opens it in the pane on the right, and the arrow saves a copy
 * wherever you want one.
 */

export function DocumentCard({
  path,
  environmentId
}: {
  path: string
  environmentId: string
}): ReactNode {
  const open = usePreviewOpener()
  const [size, setSize] = useState<number | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.opendesktop.files.stat(environmentId, path).then((info) => {
      if (alive) setSize(info?.size ?? null)
    })
    return () => {
      alive = false
    }
  }, [environmentId, path])

  const name = path.split('/').pop() ?? path
  const kind = extensionOf(path).toUpperCase() || 'FILE'

  return (
    <div className="border-ink-800 bg-ink-850/60 hover:border-ink-700 group/doc relative w-[176px] shrink-0 overflow-hidden rounded-xl border transition-colors">
      <button
        type="button"
        title={`Open ${name}`}
        onClick={() => void open(environmentId, path)}
        className="flex h-full w-full flex-col items-start gap-6 px-3 py-3 text-left"
      >
        <span className="bg-ink-800 text-ink-300 rounded-md px-1.5 py-[2px] text-[10px] font-semibold tracking-wide">
          {kind}
        </span>
        <span className="min-w-0 w-full">
          <span className="text-ink-100 line-clamp-2 break-all text-[12.5px] leading-[1.4]">
            {name}
          </span>
          <span className="text-ink-500 mt-0.5 block text-[11px]">
            {saved ? 'saved' : size === null ? '—' : fileSize(size)}
          </span>
        </span>
      </button>

      <button
        type="button"
        title="Save a copy"
        onClick={async (event) => {
          event.stopPropagation()
          const result = await window.opendesktop.files.download(environmentId, path)
          if (result.saved) {
            setSaved(result.path ?? 'saved')
            setTimeout(() => setSaved(null), 1600)
          }
        }}
        className={clsx(
          'text-ink-500 hover:bg-ink-800 hover:text-ink-100 absolute right-1.5 top-1.5 rounded-md p-1.5',
          'opacity-0 transition-opacity group-hover/doc:opacity-100 focus:opacity-100'
        )}
      >
        <Download className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}
