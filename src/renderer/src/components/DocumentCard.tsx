import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { Download, Eye, Pencil } from 'lucide-react'
import { extensionOf, fileSize } from '@shared/documents'
import { usePreviewOpener } from './BlockCard'
import { useStore } from '../state/store'

/**
 * A document the agent produced, as something you can open.
 *
 * A report, a spreadsheet or a diagram is not a diff — nobody wants to read
 * `+47` about a PDF. It gets a card with its kind, its name and its weight:
 * clicking it opens it in the pane on the right, and the arrow saves a copy
 * wherever you want one.
 */

/**
 * Files you read, and files you change.
 *
 * A PDF, an image or a spreadsheet is something to look at: the click opens
 * the viewer. A `.ts`, a `.tf`, a `.sh` or a `.json` is something to change:
 * the click opens the editor. Markdown is the one that is genuinely both, and
 * it goes to the viewer because that is what rendering is for — the pencil is
 * right there.
 *
 * Both actions are always on the card, so the rule never has to be right:
 * whichever it guessed, the other one is one click away and labelled.
 */
const READ_ONLY = new Set(['pdf', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'xlsx', 'xls', 'docx', 'doc', 'pptx', 'odt', 'ods', 'md', 'markdown', 'rtf'])

export function opensInViewer(path: string): boolean {
  return READ_ONLY.has(extensionOf(path).toLowerCase())
}

export function DocumentCard({
  path,
  environmentId
}: {
  path: string
  environmentId: string
}): ReactNode {
  const open = usePreviewOpener()
  const openInEditor = useStore((s) => s.openInEditor)
  // A card is always shown in the active session's transcript, so the active
  // session is the container to read a sandbox file out of.
  const sessionId = useStore((s) => s.activeSessionId ?? undefined)
  const [size, setSize] = useState<number | null>(null)
  const [saved, setSaved] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void window.opendesktop.files.stat(environmentId, path, sessionId).then((info) => {
      if (alive) setSize(info?.size ?? null)
    })
    return () => {
      alive = false
    }
  }, [environmentId, path, sessionId])

  const name = path.split('/').pop() ?? path
  const kind = extensionOf(path).toUpperCase() || 'FILE'

  return (
    <div className="border-ink-800 bg-ink-850/60 hover:border-ink-700 group/doc relative w-[176px] shrink-0 overflow-hidden rounded-xl border transition-colors">
      <button
        type="button"
        title={
          opensInViewer(path)
            ? `Open ${name} in the viewer`
            : `Open ${name} in the editor`
        }
        onClick={() =>
          opensInViewer(path)
            ? void open(environmentId, path)
            : openInEditor({ environmentId, path, sessionId })
        }
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

      {/* The one the click did not do. Same corner, same reveal-on-hover, so
          the card has one place where its actions live. */}
      <button
        type="button"
        title={opensInViewer(path) ? `Edit ${name}` : `View ${name}`}
        onClick={(event) => {
          event.stopPropagation()
          if (opensInViewer(path)) openInEditor({ environmentId, path, sessionId })
          else void open(environmentId, path)
        }}
        className={clsx(
          'text-ink-500 hover:bg-ink-800 hover:text-ink-100 absolute right-8 top-1.5 rounded-md p-1.5',
          'opacity-0 transition-opacity group-hover/doc:opacity-100 focus:opacity-100'
        )}
      >
        {opensInViewer(path) ? (
          <Pencil className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
      </button>

      <button
        type="button"
        title="Save a copy"
        onClick={async (event) => {
          event.stopPropagation()
          const result = await window.opendesktop.files.download(environmentId, path, sessionId)
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
