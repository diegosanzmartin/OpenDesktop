import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Activity,
  PanelLeft,
  Plus,
  Search,
  Archive,
  Copy,
  FolderTree,
  Globe,
  MessageSquare,
  ListTree,
  MoreVertical,
  Settings as SettingsIcon,
  SquareTerminal,
  Trash2
} from 'lucide-react'
import { activeSession, useStore, type DockTab } from '../state/store'
import { folderName } from '../lib/format'
import { EditableTitle } from './EditableTitle'
import { DiffSquare } from './icons'

function DockButton({
  tab,
  title,
  children
}: {
  tab: DockTab
  title: string
  children: ReactNode
}): ReactNode {
  const dock = useStore((s) => s.dock)
  const toggleDock = useStore((s) => s.toggleDock)
  const active = dock.open && dock.tab === tab
  return (
    <button
      type="button"
      title={title}
      onClick={() => toggleDock(tab)}
      className={clsx(
        'no-drag rounded-md p-1.5 transition-colors',
        active ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:bg-ink-850 hover:text-ink-100'
      )}
    >
      {children}
    </button>
  )
}

function MenuItem({
  icon,
  label,
  shortcut,
  onClick,
  danger
}: {
  icon: ReactNode
  label: string
  shortcut?: string
  onClick: () => void
  danger?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-md px-2.5 py-[6px] text-left text-[13px]',
        danger ? 'text-bad hover:bg-bad/10' : 'text-ink-200 hover:bg-ink-800'
      )}
    >
      {icon}
      {label}
      {shortcut ? <span className="text-ink-600 ml-auto text-[11px]">{shortcut}</span> : null}
    </button>
  )
}

export function TopBar(): ReactNode {
  const session = useStore(activeSession)
  const collapsed = useStore((s) => s.sidebarCollapsed)
  const toggleSidebar = useStore((s) => s.toggleSidebar)
  const searchOpen = useStore((s) => s.searchOpen)
  const toggleSearch = useStore((s) => s.toggleSearch)
  const view = useStore((s) => s.view)
  const openDock = useStore((s) => s.openDock)
  const setSettingsOpen = useStore((s) => s.setSettingsOpen)
  const approvals = useStore((s) => s.approvals.length)
  const backgroundRunning = useStore(
    (s) =>
      s.backgroundTasks.filter(
        (task) =>
          (task.rootSessionId === s.activeSessionId || task.sessionId === s.activeSessionId) &&
          task.status === 'running'
      ).length
  )
  const newSession = useStore((s) => s.newSession)

  const [menuOpen, setMenuOpen] = useState(false)
  const menu = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menuOpen) return
    const onClick = (event: MouseEvent): void => {
      if (!menu.current?.contains(event.target as Node)) setMenuOpen(false)
    }
    window.addEventListener('mousedown', onClick)
    return () => window.removeEventListener('mousedown', onClick)
  }, [menuOpen])

  return (
    /**
     * One row across the whole window, above both columns.
     *
     * The traffic lights live at a fixed place in the window, so whatever sits
     * next to them has to be fixed too. When this was two headers — one in the
     * sidebar, one over the chat — collapsing the sidebar moved the toggle from
     * one to the other and left the green light overlapping the pane behind it.
     * The gutter is reserved here, once, and nothing moves again.
     */
    <header className="drag-region flex h-11 shrink-0 items-center gap-1 pl-[82px] pr-2.5">
      <button
        type="button"
        onClick={toggleSidebar}
        title={collapsed ? 'Show sidebar' : 'Hide sidebar'}
        className="no-drag text-ink-500 hover:bg-ink-800 hover:text-ink-100 shrink-0 rounded-md p-1.5"
      >
        <PanelLeft className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={toggleSearch}
        title="Search sessions"
        className={clsx(
          'no-drag shrink-0 rounded-md p-1.5',
          searchOpen ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:bg-ink-800 hover:text-ink-100'
        )}
      >
        <Search className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => void newSession()}
        title="New session"
        className="no-drag text-ink-500 hover:bg-ink-800 hover:text-ink-100 mr-1 shrink-0 rounded-md p-1.5"
      >
        <Plus className="h-4 w-4" />
      </button>

      {view === 'board' ? <span className="flex-1" /> : null}

      {view === 'chat' && session ? (
        <EditableTitle
          value={session.title}
          onCommit={(title) => void window.opendesktop.sessions.update(session.id, { title })}
          className="no-drag text-ink-100 text-[13.5px] font-medium"
          inputClassName="no-drag min-w-0 flex-1 text-[13.5px] font-medium"
        />
      ) : view === 'chat' ? (
        <span className="text-ink-100 min-w-0 truncate text-[13.5px] font-medium">OpenDesktop</span>
      ) : null}
      {view === 'chat' && session ? (
        <span className="bg-ink-800 text-ink-400 shrink-0 rounded-md px-1.5 py-[2px] text-[11.5px]">
          {folderName(session.cwd)}
        </span>
      ) : null}

      {/* The dock is a chat-side thing; on the board the panel is the task. */}
      <div className={clsx('no-drag ml-auto flex items-center gap-0.5', view === 'board' && 'hidden')}>
        <DockButton tab="activity" title="Activity">
          <span className="relative block">
            <Activity className="h-4 w-4" />
            {approvals > 0 ? (
              <span className="bg-warn absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full" />
            ) : null}
          </span>
        </DockButton>
        <DockButton tab="background" title="Background tasks">
          <span className="relative block">
            <ListTree className="h-4 w-4" />
            {backgroundRunning > 0 ? (
              <span className="bg-info absolute -right-1 -top-1 h-1.5 w-1.5 rounded-full" />
            ) : null}
          </span>
        </DockButton>
        <DockButton tab="terminal" title="Terminal">
          <SquareTerminal className="h-4 w-4" />
        </DockButton>
        <DockButton tab="changes" title="Changes">
          <DiffSquare className="h-4 w-4" />
        </DockButton>
        <DockButton tab="browser" title="Browser">
          <Globe className="h-4 w-4" />
        </DockButton>

        <div className="relative" ref={menu}>
          <button
            type="button"
            title="More"
            onClick={() => setMenuOpen(!menuOpen)}
            className={clsx(
              'rounded-md p-1.5 transition-colors',
              menuOpen ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:bg-ink-850 hover:text-ink-100'
            )}
          >
            <MoreVertical className="h-4 w-4" />
          </button>

          {menuOpen ? (
            <div className="border-ink-700 bg-ink-850 absolute right-0 top-9 z-50 w-56 rounded-lg border p-1 shadow-2xl">
              <MenuItem
                icon={<FolderTree className="h-4 w-4" />}
                label="Files"
                onClick={() => {
                  openDock('files')
                  setMenuOpen(false)
                }}
              />
              <MenuItem
                icon={<SettingsIcon className="h-4 w-4" />}
                label="Settings"
                onClick={() => {
                  setSettingsOpen(true)
                  setMenuOpen(false)
                }}
              />
              <div className="bg-ink-800 my-1 h-px" />
              <MenuItem
                icon={<Copy className="h-4 w-4" />}
                label="Duplicate"
                onClick={() => {
                  if (session) {
                    void newSession({
                      cwd: session.cwd,
                      environmentId: session.environmentId,
                      agentId: session.agentId,
                      model: session.model
                    })
                  }
                  setMenuOpen(false)
                }}
              />
              <div className="bg-ink-800 my-1 h-px" />
              <MenuItem
                icon={<Archive className="h-4 w-4" />}
                label="Archive"
                onClick={() => {
                  if (session) void window.opendesktop.sessions.update(session.id, { archived: true })
                  setMenuOpen(false)
                }}
              />
              <MenuItem
                danger
                icon={<Trash2 className="h-4 w-4" />}
                label="Delete"
                onClick={() => {
                  if (session) void window.opendesktop.sessions.remove(session.id)
                  setMenuOpen(false)
                }}
              />
            </div>
          ) : null}
        </div>
      </div>
    </header>
  )
}
