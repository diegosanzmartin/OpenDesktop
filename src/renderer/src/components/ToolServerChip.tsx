import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Plug } from 'lucide-react'
import type { McpStatus, Session } from '@shared/types'
import { tokens } from '../lib/format'
import { useStore } from '../state/store'

/**
 * Which tool servers this conversation is carrying.
 *
 * Absent entirely when none are declared, because most sessions want none and
 * a control for a thing you do not have is furniture. When they are declared,
 * this is where they are switched on — per session, because a tool is a schema
 * in the prefix of every step and the bill for one is paid by whoever is
 * talking, not by whoever configured it.
 *
 * The token cost of each server is on its row. That is the whole reason this
 * exists as a choice rather than a setting: 130 tools is 57,800 tokens, which
 * is more than the entire window of the model on this machine.
 */
export function ToolServerChip({ session }: { session: Session }): ReactNode {
  const config = useStore((s) => s.config)
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<Record<string, McpStatus>>({})
  const box = useRef<HTMLDivElement>(null)

  const declared = Object.values(config?.mcp ?? {})
  const chosen = session.mcp ?? []

  useEffect(() => {
    if (!open) return
    void window.opendesktop.mcp.list().then((all) => {
      setStatus(Object.fromEntries((all ?? []).map((entry) => [entry.id, entry])))
    })
  }, [open])

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

  if (declared.length === 0) return null

  const toggle = (id: string): void => {
    const next = chosen.includes(id) ? chosen.filter((entry) => entry !== id) : [...chosen, id]
    void window.opendesktop.sessions.update(session.id, { mcp: next.length > 0 ? next : undefined })
  }

  const carried = chosen.reduce((total, id) => total + (status[id]?.tokens ?? 0), 0)

  return (
    <div className="relative shrink-0" ref={box}>
      <button
        type="button"
        title="Tool servers this session is carrying"
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-[3px] text-[11.5px] transition-colors',
          open ? 'bg-ink-800 text-ink-100' : chosen.length > 0 ? 'text-ink-300 hover:bg-ink-850' : 'text-ink-500 hover:text-ink-200'
        )}
      >
        <Plug className="h-3.5 w-3.5" />
        <span className="hidden @[620px]:inline">
          {chosen.length === 0 ? 'No tools' : `${chosen.length} server${chosen.length === 1 ? '' : 's'}`}
        </span>
      </button>

      {open ? (
        <div className="border-ink-800 bg-ink-900 absolute bottom-[calc(100%+8px)] left-0 z-40 w-[300px] rounded-xl border p-3 shadow-2xl">
          <div className="flex items-baseline justify-between">
            <span className="text-ink-300 text-[12px]">Tool servers</span>
            {carried > 0 ? (
              <span className="text-warn text-[11px] tabular-nums">
                +{tokens(carried)} / step
              </span>
            ) : null}
          </div>

          <div className="mt-2 space-y-1">
            {declared.map((server) => {
              const on = chosen.includes(server.id)
              const state = status[server.id]
              return (
                <button
                  key={server.id}
                  type="button"
                  onClick={() => toggle(server.id)}
                  className="hover:bg-ink-850 flex w-full items-start gap-2 rounded-md px-1.5 py-1.5 text-left"
                >
                  <span
                    className={clsx(
                      'mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                      on ? 'border-brand bg-brand' : 'border-ink-600'
                    )}
                  />
                  <span className="min-w-0 flex-1">
                    <span className="text-ink-200 block text-[12px]">{server.name || server.id}</span>
                    <span className="text-ink-600 block text-[11px]">
                      {state?.state === 'ready'
                        ? `${state.tools.length} tools · ${tokens(state.tokens)} tokens`
                        : state?.state === 'failed'
                          ? 'would not start'
                          : 'not asked yet'}
                    </span>
                  </span>
                </button>
              )
            })}
          </div>

          <p className="text-ink-600 mt-2 text-[11px] leading-[1.5]">
            Resent on every step of every turn. Off is free.
          </p>
        </div>
      ) : null}
    </div>
  )
}
