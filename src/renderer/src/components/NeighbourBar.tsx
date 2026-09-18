import clsx from 'clsx'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { Link2, Loader2 } from 'lucide-react'
import type { Neighbour, Session } from '@shared/types'
import { useStore } from '../state/store'

/**
 * Who else is in these files.
 *
 * The app has always known this — every write records the path it touched, and
 * an agent is told when it saves a file another task has changed. The person
 * running four conversations at once was the one left guessing. So: one line
 * above the composer when, and only when, another conversation has changed a
 * file this one has changed, naming it and the files, and opening it on click.
 *
 * Deliberately not a badge on the sidebar. The question is not "which chats
 * are related" in the abstract — it is "am I about to undo what the other one
 * just did", which is only worth asking where the next message gets typed.
 *
 * Nothing here polls. It asks on open and when a claim is recorded, because
 * answering reads the working tree and the answer changes only on a write.
 */
export function NeighbourBar({ session }: { session: Session }): ReactNode {
  const [neighbours, setNeighbours] = useState<Neighbour[]>([])
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const selectSession = useStore((s) => s.selectSession)

  const load = useCallback(() => {
    let live = true
    setBusy(true)
    void window.opendesktop.sessions
      .neighbours(session.id)
      .then((found) => {
        if (live) setNeighbours(found)
      })
      .catch(() => {
        if (live) setNeighbours([])
      })
      .finally(() => {
        if (live) setBusy(false)
      })
    return () => {
      live = false
    }
  }, [session.id])

  useEffect(() => load(), [load])

  useEffect(() => {
    return window.opendesktop.onEvent((event) => {
      if (event.type === 'claims.updated') load()
    })
  }, [load])

  // Collapse when switching conversation: the panel was about the other one.
  useEffect(() => setOpen(false), [session.id])

  if (neighbours.length === 0) return null

  const files = [...new Set(neighbours.flatMap((one) => one.shared))]
  const live = neighbours.filter((one) => one.live).length
  const headline =
    neighbours.length === 1
      ? `Also working in ${files.length === 1 ? 'this file' : 'these files'}: ${neighbours[0].title}`
      : `${neighbours.length} other chats are working in the same files`

  return (
    <div className="border-violet/30 bg-violet/5 mb-2 rounded-lg border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        {busy ? (
          <Loader2 className="text-violet h-3 w-3 shrink-0 animate-spin" />
        ) : (
          <Link2 className="text-violet h-3 w-3 shrink-0" />
        )}
        <span className="text-ink-200 min-w-0 flex-1 truncate text-[12px]">{headline}</span>
        {live > 0 ? (
          <span className="text-violet shrink-0 text-[11px]">
            {live === neighbours.length && live === 1 ? 'running now' : `${live} running`}
          </span>
        ) : null}
        <span className="text-ink-600 shrink-0 text-[11px]">{open ? '▲' : '▾'}</span>
      </button>

      {open ? (
        <div className="border-violet/20 space-y-2 border-t px-3 py-2">
          {neighbours.map((one) => (
            <div key={one.sessionId} className="min-w-0">
              <button
                type="button"
                onClick={() => void selectSession(one.sessionId)}
                className="flex w-full items-center gap-2 text-left"
              >
                <span
                  className={clsx(
                    'h-1.5 w-1.5 shrink-0 rounded-full',
                    one.live ? 'bg-info' : 'bg-ink-600'
                  )}
                />
                <span className="text-ink-200 hover:text-brand min-w-0 flex-1 truncate text-[12px]">
                  {one.title}
                </span>
                <span className="text-ink-600 shrink-0 text-[11px]">{one.status}</span>
              </button>
              {/* The files, not a count: the point is to recognise one. */}
              {one.shared.length > 0 ? (
                <div className="text-ink-500 mt-0.5 pl-3.5 font-mono text-[11px] leading-[1.5]">
                  {one.shared.map((path) => (
                    <div key={path} className="truncate" title={path}>
                      {path.split('/').pop()}
                    </div>
                  ))}
                </div>
              ) : (
                <div className="text-ink-500 mt-0.5 pl-3.5 text-[11px]">{one.why}</div>
              )}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}
