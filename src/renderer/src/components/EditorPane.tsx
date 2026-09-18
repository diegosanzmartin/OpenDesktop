import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { RotateCw, Save, X } from 'lucide-react'
import { highlight, type TokenKind } from '@shared/highlight'
import { useStore } from '../state/store'
import { Button } from './ui'

/**
 * A code editor, in this app's own clothes.
 *
 * Not Monaco. Monaco is VS Code's editor and it is five megabytes, a worker
 * pipeline and a theme to fight — for a pane whose job is "open the file the
 * agent just changed and fix a line". What is actually wanted from VS Code
 * here is the *look*: numbered lines, syntax colour, a monospace grid that
 * matches the transcript. That is a transparent textarea over a highlighted
 * copy of the same text, which is the oldest trick there is and the only one
 * that cannot drift from the app's own palette, because it uses it.
 *
 * What it does not have: completion, folding, multiple cursors, a language
 * server. If those are ever wanted, that is the day to take the five
 * megabytes — and not before, because this pane already does the thing it was
 * opened for.
 */
const COLOUR: Record<TokenKind, string> = {
  plain: 'text-ink-200',
  keyword: 'text-violet',
  string: 'text-ok',
  comment: 'text-ink-600 italic',
  number: 'text-warn',
  call: 'text-info'
}

/** The grid both layers share. A pixel of drift here doubles every character. */
const GRID = 'font-mono text-[12.5px] leading-[19px]'

function languageOf(path: string): string {
  const name = path.split('/').pop() ?? path
  const ext = name.includes('.') ? (name.split('.').pop() ?? '') : ''
  if (ext === 'tsx' || ext === 'ts') return 'ts'
  if (ext === 'jsx' || ext === 'js' || ext === 'mjs' || ext === 'cjs') return 'js'
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return 'bash'
  if (ext === 'py') return 'python'
  if (ext === 'tf' || ext === 'hcl') return 'hcl'
  if (ext === 'json') return 'json'
  if (ext === 'yml' || ext === 'yaml') return 'yaml'
  if (ext === 'md' || ext === 'markdown') return 'md'
  return ext
}

export function EditorPane(): ReactNode {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const open = useStore((s) => s.editorFile)
  const setOpen = useStore((s) => s.openInEditor)

  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [loading, setLoading] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const area = useRef<HTMLTextAreaElement | null>(null)
  const back = useRef<HTMLPreElement | null>(null)

  const path = open?.path ?? ''
  const environmentId = open?.environmentId ?? session?.environmentId ?? 'local'

  useEffect(() => {
    if (!path) {
      setText('')
      setOriginal('')
      return
    }
    let alive = true
    setLoading(true)
    setFailure(null)
    void window.opendesktop.files
      .open(environmentId, path)
      .then((result) => {
        if (!alive) return
        if (result.error) setFailure(result.error)
        setText(result.text)
        setOriginal(result.text)
      })
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [path, environmentId])

  const dirty = text !== original
  const spans = useMemo(() => highlight(text, languageOf(path)), [text, path])
  const lines = useMemo(() => text.split('\n').length, [text])

  const save = async (): Promise<void> => {
    if (!path || !dirty) return
    const result = await window.opendesktop.files.save(environmentId, path, text)
    if (result.error) return setFailure(result.error)
    setOriginal(text)
    setFailure(null)
    setSaved(true)
    setTimeout(() => setSaved(false), 1200)
  }

  if (!path) {
    return (
      <div className="text-ink-600 flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-[12px]">
        <span className="text-ink-300 text-[14px]">Nothing open.</span>
        <span>
          Open a file from the Files pane, or the pencil on a card in the conversation.
        </span>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-ink-800 bg-ink-900 flex items-center gap-1.5 border-b px-3 py-1.5">
        <span className="text-ink-600 min-w-0 flex-1 truncate font-mono text-[11px]">{path}</span>
        {dirty ? <span className="text-warn shrink-0 text-[11px]">unsaved</span> : null}
        {saved ? <span className="text-ok shrink-0 text-[11px]">saved</span> : null}
        <Button size="sm" onClick={() => void save()} disabled={!dirty} title="Save (⌘S)">
          <Save className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          title="Reload from disk"
          onClick={() => setOpen(open ? { ...open } : null)}
          disabled={loading}
        >
          <RotateCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
        <Button size="sm" title="Close" onClick={() => setOpen(null)}>
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {failure ? (
        <div className="text-bad border-ink-800 border-b px-3 py-1.5 text-[11.5px]">{failure}</div>
      ) : null}

      <div className="relative min-h-0 flex-1 overflow-auto">
        <div className="flex min-h-full">
          {/* The gutter scrolls with the text because it is in the same box. */}
          <div
            aria-hidden
            className={clsx(
              'text-ink-700 bg-ink-900 border-ink-800 shrink-0 select-none border-r px-2 py-2 text-right',
              GRID
            )}
          >
            {Array.from({ length: lines }, (_, index) => (
              <div key={index}>{index + 1}</div>
            ))}
          </div>

          <div className="relative min-w-0 flex-1">
            {/*
              * Two layers on the same grid: the colours underneath, the real
              * textarea on top with transparent text and a visible caret. The
              * textarea is what has focus, selection and undo — none of which
              * is worth reimplementing — and the layer under it never has to
              * know anything about editing.
              */}
            <pre
              ref={back}
              aria-hidden
              className={clsx('m-0 whitespace-pre-wrap break-words px-3 py-2', GRID)}
            >
              {spans.map((span, index) => (
                <span key={index} className={COLOUR[span.kind]}>
                  {span.text}
                </span>
              ))}
              {'\n'}
            </pre>
            <textarea
              ref={area}
              value={text}
              spellCheck={false}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 's') {
                  event.preventDefault()
                  void save()
                  return
                }
                if (event.key === 'Tab') {
                  // A tab in a code editor indents; it does not leave.
                  event.preventDefault()
                  const target = event.currentTarget
                  const at = target.selectionStart
                  const next = `${text.slice(0, at)}  ${text.slice(target.selectionEnd)}`
                  setText(next)
                  requestAnimationFrame(() => target.setSelectionRange(at + 2, at + 2))
                }
              }}
              className={clsx(
                'absolute inset-0 resize-none whitespace-pre-wrap break-words bg-transparent px-3 py-2 text-transparent caret-ink-100 outline-none',
                GRID
              )}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
