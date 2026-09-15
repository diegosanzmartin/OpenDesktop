import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Home, RotateCw } from 'lucide-react'
import { useStore } from '../state/store'
import { Button } from './ui'

interface WebviewElement extends HTMLElement {
  src: string
  reload(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
}

/**
 * The integrated browser. It points at the loopback preview server, so a file
 * the agent just wrote renders here whether it lives on this Mac or on the
 * remote host the session is attached to.
 */
export function BrowserPane(): ReactNode {
  const url = useStore((s) => s.browserUrl)
  const setUrl = useStore((s) => s.setBrowserUrl)
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const [draft, setDraft] = useState(url)
  const [current, setCurrent] = useState(url)
  const view = useRef<WebviewElement | null>(null)

  useEffect(() => {
    setDraft(url)
    setCurrent(url)
  }, [url])

  useEffect(() => {
    const element = view.current
    if (!element) return
    const onNavigate = (): void => {
      const next = element.getURL()
      setCurrent(next)
      setDraft(next)
    }
    element.addEventListener('did-navigate', onNavigate)
    element.addEventListener('did-navigate-in-page', onNavigate)
    return () => {
      element.removeEventListener('did-navigate', onNavigate)
      element.removeEventListener('did-navigate-in-page', onNavigate)
    }
  }, [url])

  const go = (value: string): void => {
    const trimmed = value.trim()
    if (!trimmed) return
    const absolute = /^https?:\/\//.test(trimmed)
      ? trimmed
      : trimmed.startsWith('/') && session
        ? ''
        : `http://${trimmed}`
    if (!absolute && session) {
      void window.opendesktop.files.previewUrl(session.environmentId, trimmed).then(setUrl)
      return
    }
    setUrl(absolute)
  }

  const openWorkingDirectory = (): void => {
    if (!session) return
    void window.opendesktop.files.previewUrl(session.environmentId, session.cwd).then(setUrl)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-ink-800 bg-ink-900 flex items-center gap-1.5 border-b px-3 py-2">
        <Button
          size="sm"
          onClick={() => view.current?.goBack()}
          disabled={!view.current?.canGoBack?.()}
          title="Back"
        >
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          onClick={() => view.current?.goForward()}
          disabled={!view.current?.canGoForward?.()}
          title="Forward"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" onClick={() => view.current?.reload()} title="Reload">
          <RotateCw className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" onClick={openWorkingDirectory} title="Browse the working directory">
          <Home className="h-3.5 w-3.5" />
        </Button>
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') go(draft)
          }}
          placeholder="A path in the working directory, or an http:// URL"
          className="border-ink-700 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11px] outline-none"
        />
        <Button
          size="sm"
          onClick={() => current && void window.opendesktop.host.openExternal(current)}
          title="Open in the system browser"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div className="min-h-0 flex-1 bg-white">
        {url ? (
          <webview
            ref={view as never}
            src={url}
            partition="persist:opendesktop-preview"
            className="h-full w-full"
            style={{ display: 'flex', width: '100%', height: '100%' }}
          />
        ) : (
          <div className="bg-ink-900 text-ink-500 flex h-full flex-col items-center justify-center gap-2 text-[12px]">
            <span className="text-ink-300 text-[14px]">Nothing loaded yet.</span>
            <span>Expand any write or read block and choose “Open in browser”.</span>
            {session ? (
              <Button variant="outline" onClick={openWorkingDirectory}>
                Browse {session.cwd}
              </Button>
            ) : null}
          </div>
        )}
      </div>
    </div>
  )
}
