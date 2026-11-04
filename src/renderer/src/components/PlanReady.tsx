import type { ReactNode } from 'react'
import type { Session } from '@shared/types'
import { useStore } from '../state/store'

const EMPTY: never[] = []

/**
 * A finished plan, and the one click that runs it.
 *
 * Plan mode keeps the agent read-only until the person approves; approving is
 * switching it off and saying go, so the button does both.
 */
export function PlanReady({ session }: { session: Session }): ReactNode {
  const messages = useStore((s) => s.messages[session.id] ?? EMPTY)
  const send = useStore((s) => s.send)
  const last = messages.at(-1)
  const answered =
    last?.role === 'assistant' &&
    last.createdAt >= (session.planSince ?? 0) &&
    last.parts.some((part) => part.type === 'text' && (part.text ?? '').trim())
  if (!session.planMode || session.status === 'running' || session.status === 'awaiting-approval' || !answered) {
    return null
  }
  return (
    <div className="border-ink-800 bg-ink-900 mx-auto mb-1.5 w-[calc(100%-3rem)] max-w-[760px] flex items-center gap-2 rounded-lg border px-3 py-2 text-[12px]">
      <span className="text-ink-300 flex-1">Plan ready. Nothing has been changed yet.</span>
      <button
        type="button"
        onClick={() => {
          void window.opendesktop.sessions
            .update(session.id, { planMode: false })
            .then(() => send('Go ahead with the plan.'))
        }}
        className="bg-brand hover:bg-brand/90 rounded-md px-2.5 py-1 text-[12px] text-white"
      >
        Run this plan
      </button>
    </div>
  )
}
