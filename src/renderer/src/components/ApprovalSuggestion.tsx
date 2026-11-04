import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@shared/types'
import { useStore } from '../state/store'

interface Suggestion {
  pattern: string
  count: number
  example: string
}

/**
 * "You keep approving this": the command approved by hand most often, offered
 * for the allowlist. Asked again after every approval, since that is when the
 * count moves; one at a time, the most approved first.
 */
export function ApprovalSuggestion({ session }: { session: Session }): ReactNode {
  const approvals = useStore((s) => s.approvals.length)
  const [offer, setOffer] = useState<Suggestion | null>(null)

  useEffect(() => {
    let alive = true
    void window.opendesktop.learn.suggestions().then((list) => {
      if (alive) setOffer(list?.[0] ?? null)
    })
    return () => {
      alive = false
    }
  }, [approvals, session.id])

  if (!offer) return null
  const settle = (accept: boolean): void => {
    const done = accept
      ? window.opendesktop.learn.accept(offer.pattern)
      : window.opendesktop.learn.dismiss(offer.pattern)
    void done.then(() => window.opendesktop.learn.suggestions()).then((list) => setOffer(list?.[0] ?? null))
  }
  return (
    <div className="border-ink-800 bg-ink-900 mx-auto mb-1.5 w-[calc(100%-3rem)] max-w-[760px] flex flex-wrap items-center gap-2 rounded-lg border px-3 py-2 text-[12px]">
      <span className="text-ink-300 min-w-0 flex-1">
        You approved <span className="font-mono">{offer.example}</span> and the like {offer.count} times. Run{' '}
        <span className="font-mono">{offer.pattern}</span> without asking?
      </span>
      <button
        type="button"
        onClick={() => settle(true)}
        className="border-ink-700 text-ink-100 hover:bg-ink-800 rounded-md border px-2 py-1"
      >
        Add to allowlist
      </button>
      <button type="button" onClick={() => settle(false)} className="text-ink-500 hover:text-ink-200 px-1.5 py-1">
        Not this one
      </button>
    </div>
  )
}
