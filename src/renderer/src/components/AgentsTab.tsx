import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, Download, FolderOpen, Plus, Save, Trash2 } from 'lucide-react'
import type { AgentConfig, AgentMode } from '@shared/types'
import { useStore } from '../state/store'
import { Label, Select } from './ui'
import { Hint, IconButton, Row, Section } from './settings-ui'

const TOOLS = ['bash', 'read', 'write', 'edit', 'grep', 'glob', 'list', 'fetch', 'task']

const MODES: { value: AgentMode; label: string }[] = [
  { value: 'all', label: 'Pickable and delegatable' },
  { value: 'primary', label: 'Pickable only' },
  { value: 'subagent', label: 'Delegatable only' }
]

function AgentCard({
  agent,
  onSaved,
  onDeleted
}: {
  agent: AgentConfig
  onSaved: () => void
  onDeleted: () => void
}): ReactNode {
  const models = useStore((s) => s.models)
  const [draft, setDraft] = useState(agent)
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    setDraft(agent)
  }, [agent])

  const dirty = JSON.stringify(draft) !== JSON.stringify(agent)
  const patch = (next: Partial<AgentConfig>): void => setDraft({ ...draft, ...next })

  const save = async (): Promise<void> => {
    setBusy(true)
    await window.opendesktop.agents.save(draft)
    setBusy(false)
    onSaved()
  }

  return (
    <div className="border-ink-800/70 border-b py-3">
      <div className="flex items-center gap-2">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: draft.color ?? '#d97757' }}
        />
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <span className="text-ink-100 text-[13.5px] font-medium">{draft.name || draft.id}</span>
          <span className="text-ink-600 ml-2 font-mono text-[11px]">{draft.id}.md</span>
          <div className="text-ink-500 truncate text-[12px]">{draft.description}</div>
        </button>
        <span className="border-ink-700 text-ink-500 shrink-0 rounded-full border px-1.5 text-[10.5px]">
          {draft.mode}
        </span>
        <IconButton
          title="Reveal the file"
          onClick={() => void window.opendesktop.agents.reveal(agent.id)}
        >
          <FolderOpen className="h-4 w-4" />
        </IconButton>
        <IconButton title={open ? 'Close' : 'Edit'} onClick={() => setOpen(!open)}>
          <ChevronDown className={clsx('h-4 w-4 transition-transform', open && 'rotate-180')} />
        </IconButton>
      </div>

      {open ? (
        <div className="mt-3 space-y-2.5">
          <div className="grid grid-cols-2 gap-2.5">
            <label className="flex flex-col gap-1">
              <Label>Name</Label>
              <input
                value={draft.name}
                onChange={(event) => patch({ name: event.target.value })}
                className="border-ink-800 bg-ink-900 text-ink-200 focus:border-ink-600 rounded-md border px-2.5 py-1.5 text-[12.5px] outline-none"
              />
            </label>
            <Select
              label="Availability"
              value={draft.mode}
              onChange={(event) => patch({ mode: event.target.value as AgentMode })}
              options={MODES}
            />
          </div>

          <label className="flex flex-col gap-1">
            <Label>Description — the orchestrator picks an agent by this, so be concrete</Label>
            <input
              value={draft.description}
              onChange={(event) => patch({ description: event.target.value })}
              className="border-ink-800 bg-ink-900 text-ink-200 focus:border-ink-600 rounded-md border px-2.5 py-1.5 text-[12.5px] outline-none"
            />
          </label>

          <div className="flex items-center gap-2.5">
            <Select
              label="Model"
              value={draft.model ?? ''}
              onChange={(event) => patch({ model: event.target.value || undefined })}
              options={[
                { value: '', label: 'Session model' },
                ...models.map((m) => ({ value: m.ref, label: m.label }))
              ]}
            />
            <label className="flex items-center gap-1.5">
              <Label>Colour</Label>
              <input
                type="color"
                value={draft.color ?? '#d97757'}
                onChange={(event) => patch({ color: event.target.value })}
                className="border-ink-800 h-6 w-10 cursor-pointer rounded border bg-transparent"
              />
            </label>
          </div>

          <div className="flex flex-col gap-1">
            <Label>Tools it may use</Label>
            <div className="flex flex-wrap gap-1.5">
              {TOOLS.map((tool) => {
                const enabled = draft.tools?.[tool] !== false
                return (
                  <button
                    key={tool}
                    type="button"
                    onClick={() =>
                      patch({ tools: { ...(draft.tools ?? {}), [tool]: !enabled } })
                    }
                    className={clsx(
                      'rounded-md border px-2 py-[3px] font-mono text-[11.5px]',
                      enabled
                        ? 'border-ok/40 bg-ok/10 text-ok'
                        : 'border-ink-700 text-ink-600 line-through'
                    )}
                  >
                    {tool}
                  </button>
                )
              })}
            </div>
          </div>

          <label className="flex flex-col gap-1">
            <Label>System prompt</Label>
            <textarea
              value={draft.prompt ?? ''}
              spellCheck={false}
              onChange={(event) => patch({ prompt: event.target.value })}
              className="border-ink-800 bg-ink-950 text-ink-200 focus:border-ink-600 min-h-40 rounded-md border px-3 py-2 font-mono text-[12px] leading-[1.6] outline-none"
            />
          </label>

          <div className="flex items-center gap-1">
            {dirty ? <Hint tone="warn">unsaved</Hint> : <Hint tone="ok">saved</Hint>}
            <IconButton
              title="Save"
              tone="accent"
              disabled={!dirty || busy}
              onClick={() => void save()}
            >
              <Save className="h-4 w-4" />
            </IconButton>
            <IconButton
              title={`Delete ${draft.name || draft.id}`}
              tone="danger"
              onClick={async () => {
                await window.opendesktop.agents.remove(agent.id)
                onDeleted()
              }}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function AgentsTab(): ReactNode {
  const config = useStore((s) => s.config)
  const refreshConfig = useStore((s) => s.refreshConfig)

  const [dir, setDir] = useState('')
  const [importable, setImportable] = useState<{ id: string; name: string; description: string }[]>([])
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [status, setStatus] = useState<string | null>(null)
  const [newId, setNewId] = useState('')

  useEffect(() => {
    void window.opendesktop.agents.dir().then(setDir)
    void window.opendesktop.agents.importable().then(setImportable)
  }, [])

  const agents = Object.values(config?.agent ?? {})

  const create = async (): Promise<void> => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-')
    if (!id) return setStatus('Give the agent an id first.')
    if (config?.agent[id]) return setStatus(`"${id}" already exists.`)
    await window.opendesktop.agents.save({
      id,
      name: id,
      description: '',
      mode: 'all',
      color: '#8d8a84',
      prompt: 'You are a specialist agent. Describe what you do here.'
    })
    setNewId('')
    setStatus(null)
    await refreshConfig()
  }

  return (
    <>
      <Section
        title="Agents"
        description={
          <>
            The manager hands work to these, and you can name one in a message with{' '}
            <span className="font-mono">@</span>. One markdown file per agent in{' '}
            <span className="font-mono">{dir}</span>.
          </>
        }
        action={status ? <Hint tone="bad">{status}</Hint> : null}
      >
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onSaved={() => void refreshConfig()}
            onDeleted={() => void refreshConfig()}
          />
        ))}
        <Row label="New agent" description="Lowercase id; it becomes the file name.">
          <input
            value={newId}
            spellCheck={false}
            placeholder="terraform"
            onChange={(event) => setNewId(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void create()
            }}
            className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[180px] rounded-lg border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
          />
          <IconButton title="Create agent" tone="accent" onClick={() => void create()}>
            <Plus className="h-4 w-4" />
          </IconButton>
        </Row>
      </Section>

      <Section
        title="Import"
        description="From ~/.claude/agents — the format is the same, so a file dropped into either directory works in both."
        action={
          <IconButton
            title={picked.size > 0 ? `Import ${picked.size}` : 'Select some to import'}
            tone="accent"
            disabled={picked.size === 0}
            onClick={async () => {
              const count = await window.opendesktop.agents.importFrom([...picked])
              setPicked(new Set())
              await refreshConfig()
              setStatus(count > 0 ? null : 'Nothing was imported.')
            }}
          >
            <Download className="h-4 w-4" />
          </IconButton>
        }
      >
        {importable.length === 0 ? (
          <Row label={<Hint>No agents found there.</Hint>} />
        ) : (
          importable.map((agent) => (
            <Row
              key={agent.id}
              label={
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={picked.has(agent.id)}
                    onChange={(event) => {
                      const next = new Set(picked)
                      if (event.target.checked) next.add(agent.id)
                      else next.delete(agent.id)
                      setPicked(next)
                    }}
                    className="accent-brand shrink-0"
                  />
                  <span className="text-ink-200 font-mono text-[12.5px]">{agent.id}</span>
                </span>
              }
              description={agent.description}
            />
          ))
        )}
      </Section>
    </>
  )
}
