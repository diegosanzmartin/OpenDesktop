import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, FolderOpen, Square } from 'lucide-react'
import type { Session } from '@shared/types'
import { useStore } from '../state/store'
import { folderName, shortenPath } from '../lib/format'

function Picker({
  value,
  onChange,
  options,
  title
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  title: string
}): ReactNode {
  return (
    <div className="relative inline-flex items-center">
      <select
        title={title}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="text-ink-400 hover:text-ink-200 cursor-pointer appearance-none bg-transparent pr-4 text-[12px] outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-ink-850">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="text-ink-600 pointer-events-none absolute right-0 h-3 w-3" />
    </div>
  )
}

/** The working-tree strip above the composer, mirroring the app's status bar. */
function ChangesBar({ session }: { session: Session }): ReactNode {
  const changes = useStore((s) => s.changes)
  const refreshChanges = useStore((s) => s.refreshChanges)
  const openDock = useStore((s) => s.openDock)

  useEffect(() => {
    void refreshChanges()
  }, [session.id, session.cwd, refreshChanges])

  if (!changes?.isRepo || changes.files.length === 0) return null

  return (
    <div className="border-ink-800 bg-ink-850 mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5">
      <span className="text-ink-300 text-[12px]">{folderName(changes.root)}</span>
      <span className="text-ink-600 text-[12px]">{changes.branch}</span>
      <span className="ml-auto flex items-center gap-1.5 font-mono text-[11.5px]">
        <span className="text-ok">+{changes.added}</span>
        <span className="text-bad">-{changes.removed}</span>
      </span>
      <button
        type="button"
        onClick={() => {
          openDock('changes')
          void refreshChanges()
        }}
        className="bg-ink-800 text-ink-200 hover:bg-ink-700 rounded px-2 py-[3px] text-[11.5px]"
      >
        Review changes
      </button>
    </div>
  )
}

export function Composer({ session }: { session: Session }): ReactNode {
  const [text, setText] = useState('')
  const config = useStore((s) => s.config)
  const models = useStore((s) => s.models)
  const send = useStore((s) => s.send)
  const stop = useStore((s) => s.stop)

  const busy = session.status === 'running' || session.status === 'awaiting-approval'
  const primaryAgents = Object.values(config?.agent ?? {}).filter(
    (a) => a.mode === 'primary' || a.mode === 'all'
  )
  const environments = Object.values(config?.environment ?? {})
  const agent = config?.agent[session.agentId]
  const model = models.find((m) => m.ref === session.model)

  const submit = (): void => {
    const value = text.trim()
    if (!value || busy) return
    setText('')
    void send(value)
  }

  const patch = (next: Partial<Session>): void => {
    void window.opendesktop.sessions.update(session.id, next)
  }

  return (
    <div className="px-6 pb-4 pt-1">
      <div className="mx-auto max-w-[760px]">
        <ChangesBar session={session} />

        <div className="border-ink-700 bg-ink-850 focus-within:border-ink-600 flex items-end gap-2 rounded-2xl border px-3.5 py-2.5">
          <textarea
            value={text}
            rows={1}
            placeholder="Type your message…"
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            className="text-ink-100 placeholder:text-ink-600 max-h-56 min-h-[24px] flex-1 resize-none bg-transparent text-[14px] leading-[1.6] outline-none"
          />
          <button
            type="button"
            onClick={busy ? () => void stop() : submit}
            disabled={!busy && !text.trim()}
            title={busy ? 'Stop' : 'Send'}
            className={clsx(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
              busy
                ? 'bg-bad/20 text-bad hover:bg-bad/30'
                : text.trim()
                  ? 'bg-brand text-ink-950 hover:bg-brand-dim'
                  : 'bg-ink-800 text-ink-600'
            )}
          >
            {busy ? <Square className="h-3 w-3" /> : <ArrowUp className="h-4 w-4" />}
          </button>
        </div>

        <div className="mt-2 flex items-center gap-3 px-1">
          <button
            type="button"
            title={session.cwd}
            onClick={async () => {
              if (session.environmentId !== 'local') return
              const picked = await window.opendesktop.host.pickFolder()
              if (picked) patch({ cwd: picked })
            }}
            className="text-ink-500 hover:text-ink-200 flex items-center gap-1.5 text-[12px]"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {shortenPath(session.cwd, 26)}
          </button>

          <Picker
            title="Agent"
            value={session.agentId}
            onChange={(agentId) => patch({ agentId })}
            options={primaryAgents.map((a) => ({ value: a.id, label: a.name }))}
          />

          <Picker
            title="Environment"
            value={session.environmentId}
            onChange={(next) => {
              const cwd = config?.environment[next]?.cwd
              patch({ environmentId: next, ...(cwd ? { cwd } : {}) })
            }}
            options={environments.map((e) => ({ value: e.id, label: e.name }))}
          />

          <div className="ml-auto flex items-center gap-3">
            <Picker
              title="Model"
              value={session.model}
              onChange={(next) => patch({ model: next })}
              options={
                models.length
                  ? models.map((m) => ({ value: m.ref, label: m.label }))
                  : [{ value: session.model, label: session.model }]
              }
            />
            {busy ? <span className="bg-brand h-2 w-2 animate-pulse rounded-full" /> : null}
            {!model && models.length > 0 ? (
              <span className="text-warn text-[11px]">unknown model</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
