import clsx from 'clsx'
import { useEffect, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { activeSession, useStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { TopBar } from './components/TopBar'
import { RightDock } from './components/RightDock'
import { ChatView } from './components/ChatView'
import { SettingsPane } from './components/SettingsPane'
import { BoardView } from './components/BoardView'

function Toasts(): ReactNode {
  const toasts = useStore((s) => s.toasts)
  const dismiss = useStore((s) => s.dismissToast)
  if (toasts.length === 0) return null
  return (
    <div className="pointer-events-none fixed bottom-4 left-1/2 z-50 flex -translate-x-1/2 flex-col gap-2">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={clsx(
            'pointer-events-auto flex max-w-lg items-start gap-2 rounded-lg border px-3 py-2 text-[12px] shadow-2xl',
            toast.level === 'error'
              ? 'border-bad/50 bg-ink-850 text-bad'
              : toast.level === 'warn'
                ? 'border-warn/50 bg-ink-850 text-warn'
                : 'border-ink-700 bg-ink-850 text-ink-200'
          )}
        >
          <span className="whitespace-pre-wrap">{toast.message}</span>
          <button type="button" onClick={() => dismiss(toast.id)} className="ml-auto shrink-0">
            <X className="h-3 w-3" />
          </button>
        </div>
      ))}
    </div>
  )
}

/** Settings is a sheet over the workspace rather than a pane, so the chat stays put. */
function SettingsOverlay(): ReactNode {
  const open = useStore((s) => s.settingsOpen)
  const setOpen = useStore((s) => s.setSettingsOpen)

  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setOpen])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/50 p-8">
      {/* No title bar: the sidebar says where you are, so the only chrome is a
          way out, floated over the content rather than replacing it. */}
      <div className="border-ink-700 bg-ink-900 relative flex h-full max-h-[880px] w-full max-w-[1040px] flex-col overflow-hidden rounded-xl border shadow-2xl">
        <button
          type="button"
          title="Close"
          onClick={() => setOpen(false)}
          className="text-ink-500 hover:bg-ink-800 hover:text-ink-100 absolute right-3 top-3 z-10 rounded-md p-1.5"
        >
          <X className="h-4 w-4" />
        </button>
        <SettingsPane />
      </div>
    </div>
  )
}

export default function App(): ReactNode {
  const ready = useStore((s) => s.ready)
  const view = useStore((s) => s.view)
  const session = useStore(activeSession)
  const bootstrap = useStore((s) => s.bootstrap)
  const applyEvent = useStore((s) => s.applyEvent)
  const toggleSidebar = useStore((s) => s.toggleSidebar)

  useEffect(() => {
    const unsubscribe = window.opendesktop.onEvent(applyEvent)
    void bootstrap()
    return unsubscribe
  }, [applyEvent, bootstrap])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'b') {
        event.preventDefault()
        toggleSidebar()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [toggleSidebar])

  if (!ready) {
    return (
      <div className="text-ink-500 flex h-full items-center justify-center text-[13px]">
        Starting OpenDesktop…
      </div>
    )
  }

  return (
    <div className="bg-ink-900 flex h-full flex-col">
      {/* One row across the window, owning the traffic-light gutter, so the
          controls beside them never move and never get overlapped. */}
      <TopBar />

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <div className="border-ink-800 bg-ink-950 mb-2 ml-1 mr-1 flex min-w-0 flex-1 flex-col overflow-hidden rounded-lg border">
          {view === 'board' ? (
            <BoardView />
          ) : session ? (
            <ChatView session={session} />
          ) : (
            <div className="text-ink-500 flex flex-1 items-center justify-center text-[13px]">
              Create a session to begin.
            </div>
          )}
        </div>
        {view === 'board' ? null : <RightDock />}
      </div>

      <SettingsOverlay />
      <Toasts />
    </div>
  )
}
