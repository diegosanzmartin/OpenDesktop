import clsx from 'clsx'
import type { ReactNode } from 'react'
import type { Session } from '@shared/types'
import { budgetFor, contextShare } from '@shared/context'
import { tokens } from '../lib/format'
import { useStore } from '../state/store'

/**
 * How full the model's window is, for the session you are in.
 *
 * Always visible rather than per message, because it is a property of the
 * conversation. Someone watching it climb past 70% understands why a summary
 * happened; someone who never saw it experiences the same event as the app
 * losing their work.
 *
 * Nothing is shown when the model declares no context window: an invented
 * percentage would be worse than an absent one.
 */
export function ContextGauge({ session }: { session: Session }): ReactNode {
  const config = useStore((s) => s.config)
  if (!config) return null

  const budget = budgetFor(config, session.model)
  const share = contextShare(session.contextTokens, budget)
  if (share === null) return null

  const fraction = config.compactAtFraction ?? 0.7
  const near = share >= fraction * 0.85
  const over = share >= fraction

  return (
    <span
      title={`${tokens(session.contextTokens ?? 0)} of about ${tokens(budget)} tokens of context. Summarised at ${Math.round(fraction * 100)}%.`}
      className="flex shrink-0 items-center gap-1.5"
    >
      <span className="bg-ink-800 relative h-1 w-10 overflow-hidden rounded-full">
        <span
          className={clsx(
            'absolute inset-y-0 left-0 rounded-full',
            over ? 'bg-warn' : near ? 'bg-brand' : 'bg-ink-600'
          )}
          style={{ width: `${Math.min(100, Math.round(share * 100))}%` }}
        />
      </span>
      <span className={clsx('text-[11.5px]', over ? 'text-warn' : 'text-ink-600')}>
        {Math.round(share * 100)}%
      </span>
    </span>
  )
}
