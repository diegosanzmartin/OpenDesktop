import { useState, type ReactNode } from 'react'
import { ArrowUp, FolderOpen, Square } from 'lucide-react'
import type { Session } from '@shared/types'
import { useStore } from '../state/store'
import { shortenPath, tokens } from '../lib/format'
import { Button, Select } from './ui'

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

  const submit = (): void => {
    const value = text.trim()
    if (!value || busy) return
    setText('')
    void send(value)
  }

  const patch = (next: Partial<Session>): void => {
    void window.opendesktop.sessions.update(session.id, next)
  }

  const pickFolder = async (): Promise<void> => {
    if (session.environmentId !== 'local') return
    const picked = await window.opendesktop.host.pickFolder()
    if (picked) patch({ cwd: picked })
  }

  return (
    <div className="border-ink-800 bg-ink-900 border-t px-4 pb-3 pt-2">
      <div className="mx-auto max-w-3xl">
        <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
          <Select
            label="Agent"
            value={session.agentId}
            onChange={(event) => patch({ agentId: event.target.value })}
            options={primaryAgents.map((a) => ({ value: a.id, label: a.name }))}
          />
          <Select
            label="Model"
            value={session.model}
            onChange={(event) => patch({ model: event.target.value })}
            options={
              models.length
                ? models.map((m) => ({ value: m.ref, label: `${m.label} · ${m.provider}` }))
                : [{ value: session.model, label: session.model }]
            }
          />
          <Select
            label="Env"
            value={session.environmentId}
            onChange={(event) => {
              const next = event.target.value
              const cwd = config?.environment[next]?.cwd
              patch({ environmentId: next, ...(cwd ? { cwd } : {}) })
            }}
            options={environments.map((e) => ({
              value: e.id,
              label: `${e.name}${e.kind === 'ssh' ? ' (ssh)' : ''}`
            }))}
          />
          <button
            type="button"
            onClick={() => void pickFolder()}
            title={session.environmentId === 'local' ? session.cwd : 'Set the path in the config for remote environments'}
            className="text-ink-500 hover:text-ink-200 flex items-center gap-1 font-mono text-[10.5px]"
          >
            <FolderOpen className="h-3 w-3" />
            {shortenPath(session.cwd)}
          </button>
          {session.usage.input + session.usage.output > 0 ? (
            <span className="text-ink-600 ml-auto text-[10px]">
              {tokens(session.usage.input)} in · {tokens(session.usage.output)} out
            </span>
          ) : null}
        </div>

        <div className="border-ink-700 bg-ink-850 focus-within:border-ink-600 flex items-end gap-2 rounded-lg border px-3 py-2">
          <textarea
            value={text}
            rows={1}
            placeholder={
              agent ? `Message ${agent.name}… (Enter to send, Shift+Enter for a new line)` : 'Message…'
            }
            onChange={(event) => setText(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            className="text-ink-100 placeholder:text-ink-600 max-h-48 min-h-[22px] flex-1 resize-none bg-transparent text-[13px] leading-[1.6] outline-none"
          />
          {busy ? (
            <Button variant="danger" onClick={() => void stop()} title="Stop">
              <Square className="h-3 w-3" />
              Stop
            </Button>
          ) : (
            <Button variant="primary" onClick={submit} disabled={!text.trim()} title="Send">
              <ArrowUp className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>

        {agent?.description ? (
          <div className="text-ink-600 mt-1.5 text-[10.5px]">{agent.description}</div>
        ) : null}
      </div>
    </div>
  )
}
