import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, FolderOpen, Plug, Save } from 'lucide-react'
import { useStore } from '../state/store'
import { Button, Label, Panel } from './ui'
import { ModelsTab } from './ModelsTab'
import { EnvironmentsTab } from './EnvironmentsTab'

type Tab = 'config' | 'agents' | 'environments' | 'providers'

const TABS: { id: Tab; label: string }[] = [
  { id: 'providers', label: 'Models & providers' },
  { id: 'config', label: 'Config file' },
  { id: 'agents', label: 'Agents' },
  { id: 'environments', label: 'Remote hosts' },
]

function ConfigEditor(): ReactNode {
  const [text, setText] = useState('')
  const [original, setOriginal] = useState('')
  const [path, setPath] = useState('')
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)
  const refreshConfig = useStore((s) => s.refreshConfig)

  useEffect(() => {
    void window.opendesktop.config.getText().then((value) => {
      setText(value)
      setOriginal(value)
    })
    void window.opendesktop.config.path().then(setPath)
  }, [])

  const save = async (): Promise<void> => {
    try {
      JSON.parse(text)
    } catch (err) {
      setStatus({ kind: 'error', message: `Invalid JSON: ${(err as Error).message}` })
      return
    }
    try {
      await window.opendesktop.config.setText(text)
      await refreshConfig()
      setOriginal(text)
      setStatus({ kind: 'ok', message: 'Saved. Providers and connections were reloaded.' })
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-ink-500 font-mono text-[10.5px]">{path}</span>
        <Button size="sm" onClick={() => void window.opendesktop.config.reveal()}>
          <FolderOpen className="h-3 w-3" />
          Reveal
        </Button>
        <Button
          size="sm"
          variant="primary"
          className="ml-auto"
          disabled={text === original}
          onClick={() => void save()}
        >
          <Save className="h-3 w-3" />
          Save
        </Button>
      </div>

      {status ? (
        <div
          className={clsx(
            'rounded border px-2.5 py-1.5 text-[11px]',
            status.kind === 'ok' ? 'border-ok/40 bg-ok/10 text-ok' : 'border-bad/40 bg-bad/10 text-bad'
          )}
        >
          {status.message}
        </div>
      ) : null}

      <textarea
        value={text}
        spellCheck={false}
        onChange={(event) => setText(event.target.value)}
        className="border-ink-700 bg-ink-950 text-ink-200 focus:border-ink-600 min-h-0 flex-1 resize-none rounded border p-3 font-mono text-[11.5px] leading-[1.6] outline-none"
      />
      <p className="text-ink-600 text-[10.5px]">
        Secrets stay as placeholders: write <span className="font-mono">{'{env:MY_VAR}'}</span> or{' '}
        <span className="font-mono">{'{file:~/.secret}'}</span> and they are resolved at call time,
        never stored in this file.
      </p>
    </div>
  )
}

function AgentsTab(): ReactNode {
  const config = useStore((s) => s.config)
  const agents = Object.values(config?.agent ?? {})

  return (
    <div className="space-y-2 overflow-y-auto">
      {agents.map((agent) => (
        <Panel key={agent.id} className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full" style={{ background: agent.color ?? '#d97757' }} />
            <span className="text-ink-100 text-[12.5px] font-semibold">{agent.name}</span>
            <span className="text-ink-600 font-mono text-[10px]">{agent.id}</span>
            <span className="border-ink-700 text-ink-400 rounded-full border px-1.5 text-[9.5px] uppercase">
              {agent.mode}
            </span>
            {agent.model ? (
              <span className="text-ink-500 font-mono text-[10px]">{agent.model}</span>
            ) : (
              <span className="text-ink-700 text-[10px]">session model</span>
            )}
          </div>
          <p className="text-ink-400 mt-1 text-[11.5px]">{agent.description}</p>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {Object.entries(agent.tools ?? {})
              .filter(([, enabled]) => enabled === false)
              .map(([tool]) => (
                <span key={tool} className="bg-bad/10 text-bad rounded px-1.5 py-[1px] text-[9.5px]">
                  no {tool}
                </span>
              ))}
            {Object.entries(agent.permissions ?? {})
              .filter(([key]) => key !== 'allowlist' && key !== 'denylist')
              .map(([key, mode]) => (
                <span
                  key={key}
                  className="border-ink-700 text-ink-500 rounded border px-1.5 py-[1px] text-[9.5px]"
                >
                  {key}: {String(mode)}
                </span>
              ))}
          </div>
        </Panel>
      ))}
      <p className="text-ink-600 text-[10.5px]">
        Add agents under <span className="font-mono">agent</span> in the config file. A{' '}
        <span className="font-mono">subagent</span> or <span className="font-mono">all</span> mode makes
        it callable by the <span className="font-mono">task</span> tool; primary agents appear in the
        composer picker.
      </p>
    </div>
  )
}

export function SettingsPane(): ReactNode {
  const [tab, setTab] = useState<Tab>('providers')

  return (
    <div className="flex min-h-0 flex-1 flex-col px-5 py-4">
      <div className="mb-3 flex items-center gap-1">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            onClick={() => setTab(item.id)}
            className={clsx(
              'rounded px-2.5 py-1 text-[11.5px] font-medium transition-colors',
              tab === item.id ? 'bg-ink-800 text-ink-100' : 'text-ink-500 hover:text-ink-200'
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      <div className="flex min-h-0 flex-1 flex-col">
        {tab === 'config' ? <ConfigEditor /> : null}
        {tab === 'agents' ? <AgentsTab /> : null}
        {tab === 'environments' ? <EnvironmentsTab /> : null}
        {tab === 'providers' ? <ModelsTab /> : null}
      </div>
    </div>
  )
}
