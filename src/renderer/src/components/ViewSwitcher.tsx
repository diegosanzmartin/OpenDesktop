import clsx from 'clsx'
import type { ReactNode } from 'react'
import { MessageSquare, SquareKanban } from 'lucide-react'
import { useStore, type AppView } from '../state/store'

const VIEWS: { id: AppView; label: string; icon: ReactNode }[] = [
  { id: 'chat', label: 'Chat', icon: <MessageSquare className="h-3.5 w-3.5" /> },
  { id: 'board', label: 'Board', icon: <SquareKanban className="h-3.5 w-3.5" /> }
]

/** The two ways of working, as a segmented control at the top of the sidebar. */
export function ViewSwitcher(): ReactNode {
  const view = useStore((s) => s.view)
  const setView = useStore((s) => s.setView)

  return (
    <div className="bg-ink-850 mx-2.5 mb-2 flex gap-1 rounded-lg p-1">
      {VIEWS.map((entry) => (
        <button
          key={entry.id}
          type="button"
          onClick={() => setView(entry.id)}
          className={clsx(
            'flex flex-1 items-center justify-center gap-1.5 rounded-md py-[5px] text-[12.5px] transition-colors',
            view === entry.id
              ? 'bg-ink-700 text-ink-100 shadow-sm'
              : 'text-ink-400 hover:text-ink-200'
          )}
        >
          {entry.icon}
          {entry.label}
        </button>
      ))}
    </div>
  )
}
