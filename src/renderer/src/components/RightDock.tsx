import clsx from 'clsx'
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import { Maximize2, Minimize2, PanelTopClose, PanelTopOpen, X } from 'lucide-react'
import { useStore, type DockTab } from '../state/store'
import { BrowserPane } from './BrowserPane'
import { EditorPane } from './EditorPane'
import { previewTarget, previewTitle } from '../lib/preview'
import { TerminalPane } from './TerminalPane'
import { ChangesPane } from './ChangesPane'
import { FilesPane } from './FilesPane'
import { ActivityPane } from './ActivityPane'
import { BackgroundTasksPane } from './BackgroundTasksPane'

const TITLES: Record<DockTab, string> = {
  changes: 'Changes',
  terminal: 'Terminal',
  browser: 'Browser',
  editor: 'Editor',
  files: 'Files',
  activity: 'Activity',
  background: 'Background tasks'
}

export function RightDock(): ReactNode {
  const dock = useStore((s) => s.dock)
  // Which panes have ever been opened. Mounting them lazily keeps a session
  // that never opens the terminal from spawning a shell, and keeping them
  // mounted afterwards preserves the guest and the PTY.
  const [opened, setOpened] = useState<Set<DockTab>>(() => new Set())
  const closeDock = useStore((s) => s.closeDock)
  const setDockWidth = useStore((s) => s.setDockWidth)
  const browserUrl = useStore((s) => s.browserUrl)
  const browserChrome = useStore((s) => s.browserChrome)
  const setBrowserChrome = useStore((s) => s.setBrowserChrome)
  const editorFile = useStore((s) => s.editorFile)
  const dragging = useRef(false)

  const onMove = useCallback(
    (event: MouseEvent) => {
      if (!dragging.current) return
      setDockWidth(window.innerWidth - event.clientX)
    },
    [setDockWidth]
  )

  useEffect(() => {
    const onUp = (): void => {
      dragging.current = false
      document.body.style.cursor = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
  }, [onMove])

  useEffect(() => {
    if (!dock.open || opened.has(dock.tab)) return
    setOpened((current) => new Set(current).add(dock.tab))
  }, [dock.open, dock.tab, opened])

  const wide = dock.width > 700
  // Mirrors the pane's own rule, so the button says what the next click does.
  const addressBar = browserChrome ?? previewTarget(browserUrl) === null

  return (
    // Hidden rather than unmounted: taking the dock out of the tree destroys the
    // <webview>'s guest and the PTY, and Electron then throws
    // "Invalid guestInstanceId" the next time the pane is opened.
    <div
      className={clsx('relative shrink-0', dock.open ? 'flex' : 'hidden')}
      style={{ width: dock.width }}
    >
      {/* The drag handle sits in the gutter so it never overlaps pane content. */}
      <div
        onMouseDown={() => {
          dragging.current = true
          document.body.style.cursor = 'col-resize'
        }}
        className="hover:bg-brand/40 absolute left-0 top-0 z-10 h-full w-1 cursor-col-resize"
      />
      <div className="border-ink-800 bg-ink-850 m-2 ml-1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border">
        <div className="border-ink-800 flex h-10 shrink-0 items-center gap-2 border-b px-3">
          {/* The file's name when one is loaded: the pane already says
              "Browser" by being one, and a file is what you came for. */}
          <span className="text-ink-200 min-w-0 truncate text-[12.5px]">
            {(dock.tab === 'browser'
              ? previewTitle(browserUrl)
              : dock.tab === 'editor' && editorFile
                ? (editorFile.path.split('/').pop() ?? null)
                : null) ?? TITLES[dock.tab]}
          </span>
          <div className="ml-auto flex items-center gap-0.5">
            {dock.tab === 'browser' && browserUrl ? (
              <button
                type="button"
                title={addressBar ? 'Hide the address bar' : 'Show the address bar'}
                onClick={() => setBrowserChrome(!addressBar)}
                className="text-ink-600 hover:bg-ink-800 hover:text-ink-200 rounded p-1"
              >
                {addressBar ? (
                  <PanelTopClose className="h-3.5 w-3.5" />
                ) : (
                  <PanelTopOpen className="h-3.5 w-3.5" />
                )}
              </button>
            ) : null}
            <button
              type="button"
              title={wide ? 'Narrow' : 'Widen'}
              onClick={() => setDockWidth(wide ? 460 : 820)}
              className="text-ink-600 hover:bg-ink-800 hover:text-ink-200 rounded p-1"
            >
              {wide ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </button>
            <button
              type="button"
              title="Close"
              onClick={closeDock}
              className="text-ink-600 hover:bg-ink-800 hover:text-ink-200 rounded p-1"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>

        <div className="flex min-h-0 flex-1 flex-col">
          {/* Mounted on first open, then kept alive and merely hidden. */}
          {opened.has('browser') ? (
            <div className={clsx('min-h-0 flex-1 flex-col', dock.tab === 'browser' ? 'flex' : 'hidden')}>
              <BrowserPane />
            </div>
          ) : null}
          {/* Kept alive like the other two: a textarea that unmounts loses the
              cursor, the selection and the undo history of whatever was open. */}
          {opened.has('editor') ? (
            <div className={clsx('min-h-0 flex-1 flex-col', dock.tab === 'editor' ? 'flex' : 'hidden')}>
              <EditorPane />
            </div>
          ) : null}
          {opened.has('terminal') ? (
            <div className={clsx('min-h-0 flex-1 flex-col', dock.tab === 'terminal' ? 'flex' : 'hidden')}>
              <TerminalPane />
            </div>
          ) : null}
          {dock.open && dock.tab === 'changes' ? <ChangesPane /> : null}
          {dock.open && dock.tab === 'files' ? <FilesPane /> : null}
          {dock.open && dock.tab === 'activity' ? <ActivityPane /> : null}
          {dock.open && dock.tab === 'background' ? <BackgroundTasksPane /> : null}
        </div>
      </div>
    </div>
  )
}
