import clsx from 'clsx'
import { useEffect, type ReactNode } from 'react'
import { FolderTree, Globe, MessageSquare, Settings, X } from 'lucide-react'
import { activeSession, useStore, type Pane } from './state/store'
import { SessionSidebar } from './components/SessionSidebar'
import { ActivityRail } from './components/ActivityRail'
import { ChatView } from './components/ChatView'
import { BrowserPane } from './components/BrowserPane'
import { FilesPane } from './components/FilesPane'
import { SettingsPane } from './components/SettingsPane'
import { StatusDot } from './components/ui'
import { shortenPath } from './lib/format'

const PANES: { id: Pane; label: string; icon: typeof MessageSquare }[] = [
  { id: 'chat', label: 'Chat', icon: MessageSquare },
  { id: 'browser', label: 'Browser', icon: Globe },
  { id: 'files', label: 'Files', icon: FolderTree },
  { id: 'settings', label: 'Settings', icon: Settings }
]

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
            'pointer-events-auto flex max-w-lg items-start gap-2 rounded-md border px-3 py-2 text-[11.5px] shadow-lg',
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

function TopBar(): ReactNode {
  const pane = useStore((s) => s.pane)
  const setPane = useStore((s) => s.setPane)
  const session = useStore(activeSession)
  const config = useStore((s) => s.config)
  const approvals = useStore((s) => s.approvals.length)
  const env = session ? config?.environment[session.environmentId] : undefined

  return (
    <header className="drag-region border-ink-800 bg-ink-900 flex h-11 shrink-0 items-center gap-3 border-b pl-[86px] pr-3">
      <div className="no-drag flex items-center gap-0.5">
        {PANES.map((item) => {
          const Icon = item.icon
          return (
            <button
              key={item.id}
              type="button"
              onClick={() => setPane(item.id)}
              className={clsx(
                'flex items-center gap-1.5 rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors',
                pane === item.id ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-200'
              )}
            >
              <Icon className="h-3.5 w-3.5" />
              {item.label}
              {item.id === 'chat' && approvals > 0 ? (
                <span className="bg-warn text-ink-950 rounded-full px-1 text-[9px] font-bold">
                  {approvals}
                </span>
              ) : null}
            </button>
          )
        })}
      </div>

      {session ? (
        <div className="no-drag ml-2 flex min-w-0 items-center gap-2">
          <StatusDot status={session.status} />
          <span className="text-ink-200 min-w-0 truncate text-[12px]">{session.title}</span>
          <span className="text-ink-600 shrink-0 font-mono text-[10.5px]">
            {shortenPath(session.cwd, 30)}
          </span>
          {env ? (
            <span
              className={clsx(
                'shrink-0 rounded-full border px-1.5 text-[9.5px]',
                env.kind === 'ssh' ? 'border-info/50 text-info' : 'border-ink-700 text-ink-500'
              )}
            >
              {env.name}
            </span>
          ) : null}
        </div>
      ) : null}

      <div className="ml-auto" />
    </header>
  )
}

export default function App(): ReactNode {
  const ready = useStore((s) => s.ready)
  const pane = useStore((s) => s.pane)
  const session = useStore(activeSession)
  const bootstrap = useStore((s) => s.bootstrap)
  const applyEvent = useStore((s) => s.applyEvent)

  useEffect(() => {
    const unsubscribe = window.opendesktop.onEvent(applyEvent)
    void bootstrap()
    return unsubscribe
  }, [applyEvent, bootstrap])

  if (!ready) {
    return (
      <div className="text-ink-500 flex h-full items-center justify-center text-[12px]">
        Starting OpenDesktop…
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <TopBar />
      <div className="flex min-h-0 flex-1">
        <SessionSidebar />
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {pane === 'chat' && session ? <ChatView session={session} /> : null}
          {pane === 'browser' ? <BrowserPane /> : null}
          {pane === 'files' ? <FilesPane /> : null}
          {pane === 'settings' ? <SettingsPane /> : null}
          {pane === 'chat' && !session ? (
            <div className="text-ink-500 flex flex-1 items-center justify-center text-[12px]">
              Create a session to begin.
            </div>
          ) : null}
        </main>
        <ActivityRail />
      </div>
      <Toasts />
    </div>
  )
}
