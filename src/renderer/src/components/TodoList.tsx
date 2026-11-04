import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, ChevronRight, Circle, Loader2 } from 'lucide-react'
import type { Session } from '@shared/types'

/**
 * The agent's checklist, above the composer.
 *
 * What it is working through, and where it is: the glance that tells a person
 * whether a long turn is on track or has wandered. It stays while there is
 * anything left or the turn is still going, and goes once it is all done.
 */
export function TodoList({ session }: { session: Session }): ReactNode {
  const [open, setOpen] = useState(true)
  const items = session.todos ?? []
  const done = items.filter((item) => item.status === 'done').length
  const working = session.status === 'running' || session.status === 'awaiting-approval'
  if (items.length === 0 || (done === items.length && !working)) return null

  return (
    <div className="border-ink-800 bg-ink-900 mx-auto mb-1.5 w-[calc(100%-3rem)] max-w-[760px] rounded-lg border px-3 py-2 text-[12px]">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="text-ink-400 hover:text-ink-200 flex w-full items-center gap-1.5"
      >
        {open ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        <span>Plan</span>
        <span className="tabular-nums">
          {done}/{items.length}
        </span>
      </button>
      {open ? (
        <ul className="mt-1.5 space-y-0.5">
          {items.map((item, index) => (
            <li
              key={index}
              data-status={item.status}
              className={clsx(
                'flex items-start gap-1.5',
                item.status === 'done' && 'text-ink-600 line-through',
                item.status === 'in_progress' && 'text-ink-100',
                item.status === 'pending' && 'text-ink-400'
              )}
            >
              {item.status === 'done' ? (
                <Check className="text-ok mt-0.5 h-3 w-3 shrink-0" />
              ) : item.status === 'in_progress' ? (
                <Loader2 className="text-brand mt-0.5 h-3 w-3 shrink-0 animate-spin" />
              ) : (
                <Circle className="mt-0.5 h-3 w-3 shrink-0" />
              )}
              <span>{item.text}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}
