import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowLeft, ArrowRight, ExternalLink, Home, RotateCw, TriangleAlert } from 'lucide-react'
import { useStore } from '../state/store'
import { previewTarget } from '../lib/preview'
import { Button } from './ui'

interface WebviewElement extends HTMLElement {
  src: string
  loadURL(url: string): Promise<void>
  reload(): void
  stop(): void
  goBack(): void
  goForward(): void
  canGoBack(): boolean
  canGoForward(): boolean
  getURL(): string
}

/** `localhost:3000`, `example.com`, `10.0.0.4:8080` — a host, not a file path. */
const BARE_HOST = /^(localhost|\[[0-9a-f:]+\]|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d+)?(\/.*)?$/i

function joinPath(cwd: string, path: string): string {
  if (path.startsWith('/')) return path
  if (path.startsWith('~')) return path
  return `${cwd.replace(/\/+$/, '')}/${path}`
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
  /*
   * A file gets no address bar unless it is asked for. The page the preview
   * server renders puts the path in its own header, so the bar was the second
   * copy of it — and the controls beside it are for navigating a site, which
   * a file is not.
   */
  const chrome = useStore((s) => s.browserChrome)
  const showChrome = chrome ?? previewTarget(url) === null

  const [draft, setDraft] = useState(url)
  const [current, setCurrent] = useState(url)
  const [failure, setFailure] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [nav, setNav] = useState({ back: false, forward: false })
  const view = useRef<WebviewElement | null>(null)
  const attached = useRef(false)
  const queued = useRef<string | null>(null)

  useEffect(() => {
    setDraft(url)
    setCurrent(url)
    setFailure(null)
  }, [url])

  /**
   * The guest is navigated by hand rather than through the `src` prop. Letting
   * React mount and unmount the <webview> — on a tab switch, or on the first
   * load — destroys the guest underneath it and Electron then throws
   * "Invalid guestInstanceId", which is what left the pane blank.
   */
  useEffect(() => {
    const element = view.current
    if (!element || !url) return
    if (!attached.current) {
      queued.current = url
      return
    }
    try {
      element.loadURL(url)
    } catch {
      queued.current = url
    }
  }, [url])

  const syncNav = useCallback((element: WebviewElement) => {
    // Ref mutations never re-render, so mirror the webview's history into state.
    try {
      setNav({ back: element.canGoBack(), forward: element.canGoForward() })
    } catch {
      setNav({ back: false, forward: false })
    }
  }, [])

  useEffect(() => {
    const element = view.current
    if (!element) return

    const onNavigate = (): void => {
      const next = element.getURL()
      setCurrent(next)
      setDraft(next)
      setLoading(false)
      syncNav(element)
    }
    const onStart = (): void => {
      setLoading(true)
      setFailure(null)
    }
    const onStop = (): void => {
      setLoading(false)
      syncNav(element)
    }
    const onFail = (event: Event): void => {
      const detail = event as Event & { errorDescription?: string; errorCode?: number; isMainFrame?: boolean }
      // Sub-resources fail all the time on real pages; only the main frame matters.
      if (detail.isMainFrame === false) return
      // -3 is ERR_ABORTED, which is what a superseded navigation reports.
      if (detail.errorCode === -3) return
      setLoading(false)
      setFailure(detail.errorDescription || `Could not load this address (${detail.errorCode ?? 'unknown'})`)
    }

    const onReady = (): void => {
      attached.current = true
      const pending = queued.current
      queued.current = null
      if (pending) void element.loadURL(pending).catch(() => undefined)
    }

    element.addEventListener('dom-ready', onReady)
    element.addEventListener('did-navigate', onNavigate)
    element.addEventListener('did-navigate-in-page', onNavigate)
    element.addEventListener('did-start-loading', onStart)
    element.addEventListener('did-stop-loading', onStop)
    element.addEventListener('did-fail-load', onFail)
    return () => {
      element.removeEventListener('dom-ready', onReady)
      element.removeEventListener('did-navigate', onNavigate)
      element.removeEventListener('did-navigate-in-page', onNavigate)
      element.removeEventListener('did-start-loading', onStart)
      element.removeEventListener('did-stop-loading', onStop)
      element.removeEventListener('did-fail-load', onFail)
    }
    // Bound once: the element outlives every url change.
  }, [syncNav])

  /**
   * Resolves whatever was typed. Anything that is not an explicit URL or a bare
   * host is a path in the session's environment — that is the common case here,
   * and treating it as a hostname is what produced a blank page.
   */
  const go = async (value: string): Promise<void> => {
    const trimmed = value.trim()
    if (!trimmed) return
    setFailure(null)

    if (/^https?:\/\//i.test(trimmed)) return setUrl(trimmed)
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      setFailure(`Only http and https addresses can be opened here (got "${trimmed.split(':')[0]}:").`)
      return
    }
    if (BARE_HOST.test(trimmed)) return setUrl(`http://${trimmed}`)

    if (!session) {
      setFailure('Open a session first — paths are resolved against its working directory.')
      return
    }
    const target = joinPath(session.cwd, trimmed)
    setUrl(await window.opendesktop.files.previewUrl(session.environmentId, target))
  }

  const openWorkingDirectory = async (): Promise<void> => {
    if (!session) return
    setUrl(await window.opendesktop.files.previewUrl(session.environmentId, session.cwd))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Not mounted rather than hidden: what is left is a row of controls
          for navigating a site, and the draft address lives in state, so
          there is nothing to preserve by keeping an invisible copy. */}
      {showChrome ? (
      <div className="border-ink-800 bg-ink-900 flex items-center gap-1.5 border-b px-3 py-2">
        <Button size="sm" onClick={() => view.current?.goBack()} disabled={!nav.back} title="Back">
          <ArrowLeft className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          onClick={() => view.current?.goForward()}
          disabled={!nav.forward}
          title="Forward"
        >
          <ArrowRight className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="sm"
          onClick={() => (loading ? view.current?.stop() : view.current?.reload())}
          title={loading ? 'Stop' : 'Reload'}
        >
          <RotateCw className={loading ? 'h-3.5 w-3.5 animate-spin' : 'h-3.5 w-3.5'} />
        </Button>
        <Button
          size="sm"
          onClick={() => void openWorkingDirectory()}
          disabled={!session}
          title="Browse the working directory"
        >
          <Home className="h-3.5 w-3.5" />
        </Button>
        <input
          value={draft}
          spellCheck={false}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void go(draft)
          }}
          placeholder={
            session ? `A path in ${session.cwd}, or an http:// URL` : 'An http:// URL'
          }
          className="border-ink-700 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11px] outline-none"
        />
        <Button
          size="sm"
          onClick={() => current && void window.opendesktop.host.openExternal(current)}
          disabled={!current}
          title="Open in the system browser"
        >
          <ExternalLink className="h-3.5 w-3.5" />
        </Button>
      </div>
      ) : null}

      <div className="relative min-h-0 flex-1 bg-white">
        <webview
          ref={view as never}
          src="about:blank"
          partition="persist:opendesktop-preview"
          style={{ display: url ? 'flex' : 'none', width: '100%', height: '100%' }}
        />
        {!url ? (
          <div className="bg-ink-900 text-ink-500 absolute inset-0 flex flex-col items-center justify-center gap-2 text-[12px]">
            <span className="text-ink-300 text-[14px]">Nothing loaded yet.</span>
            <span>
              Type a file or folder path above, or expand a block and choose “Open in browser”.
            </span>
            {session ? (
              <Button variant="outline" onClick={() => void openWorkingDirectory()}>
                Browse {session.cwd}
              </Button>
            ) : null}
          </div>
        ) : null}

        {failure ? (
          <div className="bg-ink-900 absolute inset-0 flex flex-col items-center justify-center gap-2 px-8 text-center">
            <TriangleAlert className="text-warn h-6 w-6" />
            <span className="text-ink-200 text-[13px]">This address did not load</span>
            <span className="text-ink-500 max-w-md text-[11.5px]">{failure}</span>
            {current ? (
              <span className="text-ink-600 max-w-md break-all font-mono text-[10.5px]">{current}</span>
            ) : null}
            <Button variant="outline" onClick={() => setFailure(null)}>
              Dismiss
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
