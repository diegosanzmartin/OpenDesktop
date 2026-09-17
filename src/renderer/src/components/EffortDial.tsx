import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@shared/types'
import { DEFAULT_EFFORT, EFFORT_LEVELS, canReason, effortLevel } from '@shared/effort'
import { useStore } from '../state/store'

/**
 * How hard to try, as one dial with the ends named.
 *
 * Deliberately not a second model picker. The temptation is to have "smarter"
 * quietly move the work to a better model, which makes the label above it a
 * lie — you would be reading "GLM 5.3 Flash" while Opus answered. It moves the
 * two things that belong to this turn instead: how much the model may think,
 * where it has a setting for that, and how many steps it gets. The panel says
 * which of the two is actually in force for the model you are on, because for
 * most models it is only the second.
 */
export function EffortDial({ session }: { session: Session }): ReactNode {
  const config = useStore((s) => s.config)
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

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

  const level = effortLevel(session.effort)
  const slash = session.model.indexOf('/')
  const model =
    slash === -1
      ? undefined
      : config.provider[session.model.slice(0, slash)]?.models[session.model.slice(slash + 1)]
  const thinks = canReason(model)
  const steps = Math.max(1, Math.round((config.maxSteps ?? 60) * level.steps))

  /*
   * Written straight to the session, like the model and the folder beside it:
   * the store picks the change up from the event the main process emits, so
   * there is nothing to keep in step here.
   */
  const set = (value: number): void => {
    void window.opendesktop.sessions.update(session.id, {
      effort: value === DEFAULT_EFFORT ? undefined : value
    })
  }

  return (
    <div className="relative shrink-0" ref={box}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        title="How hard to try"
        className={clsx(
          'rounded-md px-1.5 py-0.5 text-[11px] transition-colors',
          open ? 'bg-ink-800 text-ink-200' : 'text-ink-500 hover:text-ink-200 hover:bg-ink-850'
        )}
      >
        {level.label}
      </button>

      {open ? (
        <div className="border-ink-800 bg-ink-900 absolute bottom-[calc(100%+8px)] right-0 z-40 w-[268px] rounded-xl border p-3 shadow-2xl">
          <div className="flex items-baseline justify-between">
            <span className="text-ink-300 text-[12px]">Effort</span>
            <span className="text-ink-200 text-[12px]">{level.label}</span>
          </div>

          <div className="text-ink-600 mt-2.5 flex items-center justify-between text-[11px]">
            <span>Faster</span>
            <span>Smarter</span>
          </div>

          {/* One track, one knob per stop: a range input cannot be styled into
              this and a row of buttons is the same gesture with a hit area. */}
          <div className="bg-ink-850 mt-1.5 flex items-center gap-0.5 rounded-lg p-1">
            {EFFORT_LEVELS.map((stop) => {
              const here = stop.value === level.value
              return (
                <button
                  key={stop.value}
                  type="button"
                  title={stop.label}
                  onClick={() => set(stop.value)}
                  className={clsx(
                    'group flex h-5 flex-1 items-center justify-center rounded-md transition-colors',
                    here ? 'bg-ink-200' : 'hover:bg-ink-800'
                  )}
                >
                  <span
                    className={clsx(
                      'h-1 w-1 rounded-full',
                      here ? 'bg-ink-900' : 'bg-ink-600 group-hover:bg-ink-400'
                    )}
                  />
                </button>
              )
            })}
          </div>

          {/* What it does, in the fewest words that are still true. The
              sentence this replaces explained that a model without a reasoning
              setting only gets the step ceiling — which is worth knowing once
              and is now the tooltip, not three lines of the panel. */}
          <p
            className="text-ink-500 mt-2.5 text-[11.5px] tabular-nums"
            title={
              thinks
                ? 'Sent to the model as its reasoning setting, with a ceiling on the steps a turn may take'
                : `${model?.name ?? session.model} declares no reasoning setting, so the dial only moves the step ceiling. Mark it as reasoning under Providers & keys to have the dial reach it.`
            }
          >
            {thinks ? (
              <>
                {level.reasoning === 'off'
                  ? 'No thinking'
                  : `Thinking ${level.reasoning}${level.budgetTokens ? ` · ${Math.round(level.budgetTokens / 1024)}k` : ''}`}
                {' · '}
                {steps} steps
              </>
            ) : (
              <>
                {steps} steps <span className="text-ink-600">· no thinking to set</span>
              </>
            )}
          </p>
        </div>
      ) : null}
    </div>
  )
}
