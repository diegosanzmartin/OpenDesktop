import clsx from 'clsx'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Check, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { useStore } from '../state/store'
import type { SessionGroupBy, SessionQuery, SessionSortBy, SessionStatusFilter } from '../state/store'

interface Option<T> {
  value: T
  label: string
}

const STATUSES: Option<SessionStatusFilter>[] = [
  { value: 'active', label: 'Active' },
  { value: 'all', label: 'All' },
  { value: 'running', label: 'Running' },
  { value: 'approval', label: 'Needs approval' },
  { value: 'error', label: 'Failed' },
  { value: 'idle', label: 'Idle' }
]

const GROUPS: Option<SessionGroupBy>[] = [
  { value: 'date', label: 'Date' },
  { value: 'none', label: 'Nothing' },
  { value: 'folder', label: 'Folder' },
  { value: 'status', label: 'Status' },
  { value: 'environment', label: 'Environment' },
  { value: 'agent', label: 'Agent' }
]

const SORTS: Option<SessionSortBy>[] = [
  { value: 'recent', label: 'Last activity' },
  { value: 'created', label: 'Date created' },
  { value: 'title', label: 'Title' },
  { value: 'folder', label: 'Folder' },
  { value: 'status', label: 'Status' }
]

/** A row that drills into its choices, the value shown on the right. */
function MenuRow<T extends string>({
  label,
  value,
  options,
  open,
  onOpen,
  onPick
}: {
  label: string
  value: T
  options: Option<T>[]
  open: boolean
  onOpen: () => void
  onPick: (value: T) => void
}): ReactNode {
  const current = options.find((option) => option.value === value)

  return (
    <div className="relative">
      <button
        type="button"
        onMouseEnter={onOpen}
        onClick={onOpen}
        className={clsx(
          'flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]',
          open ? 'bg-ink-800 text-ink-100' : 'text-ink-200 hover:bg-ink-800'
        )}
      >
        <span className="flex-1">{label}</span>
        <span className="text-ink-500 max-w-[110px] truncate text-[12.5px]">
          {current?.label ?? value}
        </span>
        <ChevronRight className="text-ink-600 h-3.5 w-3.5 shrink-0" />
      </button>

      {open ? (
        // Flies out beside the row so the parent stays visible.
        <div className="border-ink-700 bg-ink-850 absolute left-full top-[-5px] z-10 ml-1 w-52 rounded-lg border p-1 shadow-2xl">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              onClick={() => onPick(option.value)}
              className="text-ink-200 hover:bg-ink-800 flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]"
            >
              <span className="flex-1">{option.label}</span>
              {option.value === value ? <Check className="text-brand h-3.5 w-3.5" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** The session list's filtering, sorting and grouping, in one popover. */
export function SessionFilters(): ReactNode {
  const query = useStore((s) => s.sessionQuery)
  const setQuery = useStore((s) => s.setSessionQuery)
  const config = useStore((s) => s.config)

  const [open, setOpen] = useState(false)
  const [submenu, setSubmenu] = useState<string | null>(null)
  const [anchor, setAnchor] = useState({ top: 0, right: 0 })
  const root = useRef<HTMLDivElement>(null)
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)

  /**
   * The menu is portalled to the body rather than nested in the sidebar.
   * The session list scrolls, and a container with overflow on one axis clips
   * the other too, so a flyout to the right was being cut off at the sidebar's
   * edge. A portal has no clipping ancestor to fight.
   */
  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    setAnchor({ top: rect.bottom + 6, right: window.innerWidth - rect.right })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!root.current?.contains(target) && !panel.current?.contains(target)) {
        setOpen(false)
        setSubmenu(null)
      }
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setOpen(false)
        setSubmenu(null)
      }
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  const environments: Option<string>[] = [
    { value: 'all', label: 'All' },
    ...Object.values(config?.environment ?? {}).map((env) => ({ value: env.id, label: env.name }))
  ]

  const pick = <K extends keyof SessionQuery>(key: K, value: SessionQuery[K]): void => {
    setQuery({ [key]: value } as Partial<SessionQuery>)
    setSubmenu(null)
  }

  return (
    <div className="relative" ref={root}>
      <button
        ref={button}
        type="button"
        title="Filter and sort"
        onClick={() => {
          setOpen(!open)
          setSubmenu(null)
        }}
        className={clsx(
          'rounded-md p-1 transition-colors',
          open ? 'bg-ink-800 text-ink-100' : 'text-ink-600 hover:text-ink-300'
        )}
      >
        <SlidersHorizontal className="h-3.5 w-3.5" />
      </button>

      {open
        ? createPortal(
            <div
              ref={panel}
              style={{ top: anchor.top, right: anchor.right }}
              className="border-ink-700 bg-ink-850 fixed z-[60] w-56 rounded-lg border p-1 shadow-2xl"
            >
              <MenuRow
                label="Status"
                value={query.status}
                options={STATUSES}
                open={submenu === 'status'}
                onOpen={() => setSubmenu('status')}
                onPick={(value) => pick('status', value)}
              />
              <MenuRow
                label="Environment"
                value={query.environment}
                options={environments}
                open={submenu === 'environment'}
                onOpen={() => setSubmenu('environment')}
                onPick={(value) => pick('environment', value)}
              />

              <div className="bg-ink-800 my-1 h-px" />

              <MenuRow
                label="Group by"
                value={query.groupBy}
                options={GROUPS}
                open={submenu === 'group'}
                onOpen={() => setSubmenu('group')}
                onPick={(value) => pick('groupBy', value)}
              />
              <MenuRow
                label="Sort by"
                value={query.sortBy}
                options={SORTS}
                open={submenu === 'sort'}
                onOpen={() => setSubmenu('sort')}
                onPick={(value) => pick('sortBy', value)}
              />

              <div className="bg-ink-800 my-1 h-px" />

              <button
                type="button"
                onMouseEnter={() => setSubmenu(null)}
                onClick={() => setQuery({ showGitStatus: !query.showGitStatus })}
                className="text-ink-200 hover:bg-ink-800 flex w-full items-center gap-2 rounded-md px-2.5 py-[6px] text-left text-[13px]"
              >
                <span className="flex-1">Show git status</span>
                {query.showGitStatus ? <Check className="text-brand h-3.5 w-3.5" /> : null}
              </button>
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
