import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { MeterEntry, Session } from '@shared/types'
import { budgetFor } from '@shared/context'
import { formatCost } from '@shared/cost'
import { tokens } from '../lib/format'
import { useStore } from '../state/store'

/**
 * How full the window is, as a ring, with the whole story a click away.
 *
 * The bar this replaces said one number — 37% — which is enough to know a
 * summary is coming and not enough to do anything about it. A conversation
 * that is nine tenths tool schemas needs fewer tools; one that is nine tenths
 * transcript needs a summary or a fresh session; and the two look identical
 * from a percentage. So the ring is the glance and the panel is the answer,
 * and the panel also carries what has been spent — including by the models
 * nobody chose, which is where a local model and a delegated read show up.
 */

/** Where the ring turns from "filling" to "about to be summarised". */
function toneFor(share: number, at: number): 'calm' | 'near' | 'over' {
  if (share >= at) return 'over'
  if (share >= at * 0.85) return 'near'
  return 'calm'
}

function Ring({ share, tone }: { share: number; tone: 'calm' | 'near' | 'over' }): ReactNode {
  // 14px, which is the height of the line it sits on. Stroke on the outside so
  // a full ring reads as full without the middle going solid.
  const radius = 5.6
  const circumference = 2 * Math.PI * radius
  return (
    <svg viewBox="0 0 14 14" className="h-3.5 w-3.5 shrink-0 -rotate-90">
      <circle cx="7" cy="7" r={radius} fill="none" strokeWidth="1.6" className="stroke-ink-800" />
      <circle
        cx="7"
        cy="7"
        r={radius}
        fill="none"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeDasharray={`${Math.max(0.5, Math.min(1, share)) * circumference} ${circumference}`}
        className={clsx(
          'transition-[stroke-dasharray] duration-500',
          tone === 'over' ? 'stroke-warn' : tone === 'near' ? 'stroke-brand' : 'stroke-ink-500'
        )}
      />
    </svg>
  )
}

function Bar({
  share,
  className
}: {
  share: number
  className: string
}): ReactNode {
  return (
    <span className={clsx('h-1.5 shrink-0 rounded-full', className)} style={{ width: `${Math.max(1, share * 100)}%` }} />
  )
}

interface Part {
  label: string
  tokensUsed: number
  className: string
}

export function ContextMeter({ session }: { session: Session }): ReactNode {
  const config = useStore((s) => s.config)
  const [open, setOpen] = useState(false)
  const [meter, setMeter] = useState<Record<string, MeterEntry>>({})
  const box = useRef<HTMLDivElement>(null)

  // Read when the panel opens rather than on a timer: it is a number nobody
  // watches change, and polling it would be a request a second for a label.
  useEffect(() => {
    if (!open) return
    void window.opendesktop.meter.get().then((next) => setMeter(next ?? {}))
  }, [open, session.usage.input, session.usage.output])

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', away)
      document.removeEventListener('keydown', escape)
    }
  }, [open])

  if (!config) return null

  const window_ = budgetFor(config, session.model)
  const used = session.contextTokens ?? 0
  const at = config.compactAtFraction ?? 0.7
  /*
   * Two shares, and the ring is the second one.
   *
   * How full the window is answers a question nobody asks; how close the
   * conversation is to being summarised is the thing that is about to happen
   * to them. So the ring fills up to the point the summary happens — full ring
   * means now — and the panel carries the absolute figure, which is what you
   * want once you have opened it to see what is taking up the room.
   */
  const share = window_ > 0 ? used / window_ : 0
  const toSummary = at > 0 ? Math.min(1, share / at) : 0
  const tone = toneFor(share, at)

  // Nothing invented: a model that declares no window gets no ring.
  if (window_ <= 0) return null

  const parts = session.contextParts
  const measured = parts?.total ?? used
  const framing = parts ? Math.max(0, measured - parts.messages - parts.system - (parts.skills ?? 0)) : 0
  const rows: Part[] = parts
    ? [
        { label: 'Messages', tokensUsed: parts.messages, className: 'bg-brand' },
        { label: 'Tools and framing', tokensUsed: framing, className: 'bg-ok/70' },
        { label: 'System prompt', tokensUsed: parts.system, className: 'bg-warn/70' },
        ...(parts.skills ? [{ label: 'Skills', tokensUsed: parts.skills, className: 'bg-ink-400' }] : [])
      ]
    : []
  const untilSummary = Math.max(0, Math.round(at * window_) - used)

  // Every model that has been paid anything at all, this session's own included.
  const spending = Object.entries(meter)
    .map(([ref, entry]) => ({ ref, ...entry }))
    .filter((entry) => entry.month > 0)
    .sort((a, b) => b.month - a.month)
  const monthCost = spending.reduce((total, entry) => total + (entry.monthCost ?? 0), 0)

  return (
    <div className="relative shrink-0" ref={box}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title={
          `${Math.round(toSummary * 100)}% of the way to a summary — ` +
          `${tokens(used)} of ${tokens(window_)} tokens, summarised at ${Math.round(at * 100)}% of the window`
        }
        className={clsx(
          'flex items-center gap-1.5 rounded-md px-1 py-0.5 transition-colors',
          open ? 'bg-ink-800' : 'hover:bg-ink-850'
        )}
      >
        <Ring share={toSummary} tone={tone} />
        <span
          className={clsx(
            'text-[11px] tabular-nums',
            tone === 'over' ? 'text-warn' : 'text-ink-500'
          )}
        >
          {Math.round(toSummary * 100)}%
        </span>
      </button>

      {open ? (
        <div className="border-ink-800 bg-ink-900 absolute bottom-[calc(100%+8px)] right-0 z-40 max-h-[70vh] w-[320px] overflow-y-auto rounded-xl border p-3 shadow-2xl">
          <div className="flex items-baseline justify-between">
            <span
              className="text-ink-300 text-[12px]"
              title="The total is what the provider charged for the first step of the last turn; the parts are this app's estimate of it."
            >
              Context window
            </span>
            <span className="text-ink-400 text-[11px] tabular-nums">
              {tokens(used)} / {tokens(window_)} ({Math.round(share * 100)}%)
            </span>
          </div>

          <div className="bg-ink-850 mt-2 flex h-1.5 w-full gap-[1px] overflow-hidden rounded-full">
            {rows.map((row) => (
              <Bar key={row.label} share={row.tokensUsed / window_} className={row.className} />
            ))}
          </div>

          {parts ? (
            <div className="mt-2.5 space-y-1">
              {rows.map((row) => (
                <div key={row.label} className="flex items-center gap-2 text-[11.5px]">
                  <span className={clsx('h-2 w-2 shrink-0 rounded-[2px]', row.className)} />
                  <span className="text-ink-300 min-w-0 flex-1 truncate">{row.label}</span>
                  <span className="text-ink-400 tabular-nums">{tokens(row.tokensUsed)}</span>
                  <span className="text-ink-500 w-9 text-right tabular-nums">
                    {Math.round((row.tokensUsed / window_) * 100)}%
                  </span>
                </div>
              ))}
              <div className="flex items-center gap-2 text-[11.5px]">
                <span className="border-ink-700 h-2 w-2 shrink-0 rounded-[2px] border" />
                <span
                  className="text-ink-400 min-w-0 flex-1 truncate"
                  title={`Summarised at ${Math.round(at * 100)}% of the window, keeping the last ${config.keepRecentMessages ?? 8} messages verbatim`}
                >
                  Room until a summary <span className="text-ink-600">at {Math.round(at * 100)}%</span>
                </span>
                <span className="text-ink-500 tabular-nums">{tokens(untilSummary)}</span>
                <span className="text-ink-600 w-9 text-right tabular-nums">
                  {Math.round((untilSummary / window_) * 100)}%
                </span>
              </div>
            </div>
          ) : (
            <p
              className="text-ink-600 mt-2 text-[11.5px]"
              title="The parts are measured on the first step of a turn"
            >
              Not measured yet.
            </p>
          )}

          <div className="border-ink-800 mt-3 border-t pt-2.5">
            <div className="flex items-baseline justify-between">
              <span
                className="text-ink-300 text-[12px]"
                title="Every model this app has paid for, not only this session's — a delegated read or a plan is charged to whichever model did it. Counted here, since no provider reports a balance back."
              >
                Usage this month
              </span>
              <span className="text-ink-500 text-[11px] tabular-nums">
                {monthCost > 0 ? formatCost(monthCost) : '—'}
              </span>
            </div>
            {spending.length === 0 ? (
              <p className="text-ink-600 mt-1.5 text-[11.5px]">Nothing yet.</p>
            ) : (
              <div className="mt-1.5 space-y-1">
                {spending.map((entry) => (
                  <div key={entry.ref} className="flex items-center gap-2 text-[11.5px]">
                    <span
                      className={clsx(
                        'min-w-0 flex-1 truncate',
                        entry.ref === session.model ? 'text-ink-200' : 'text-ink-400'
                      )}
                    >
                      {entry.ref}
                    </span>
                    <span className="text-ink-500 tabular-nums">{tokens(entry.month)}</span>
                    <span className="text-ink-500 w-12 text-right tabular-nums">
                      {entry.monthCost > 0 ? formatCost(entry.monthCost) : 'free'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
