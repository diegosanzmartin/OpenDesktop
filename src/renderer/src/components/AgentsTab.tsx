import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { Download, FileCode2, FolderOpen, Plus, Save, Trash2 } from 'lucide-react'
import type { AgentConfig, AgentMode } from '@shared/types'
import { useStore } from '../state/store'
import { Button, Label, Panel, Select } from './ui'

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
    <Panel className="px-3 py-3">
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
        <Button size="sm" onClick={() => void window.opendesktop.agents.reveal(agent.id)} title="Reveal file">
          <FolderOpen className="h-3 w-3" />
        </Button>
        <Button size="sm" onClick={() => setOpen(!open)}>
          {open ? 'Close' : 'Edit'}
        </Button>
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

          <div className="flex items-center gap-2">
            <Button variant="primary" disabled={!dirty || busy} onClick={() => void save()}>
              <Save className="h-3 w-3" />
              {dirty ? 'Save' : 'Saved'}
            </Button>
            <Button
              variant="danger"
              className="ml-auto"
              onClick={async () => {
                await window.opendesktop.agents.remove(agent.id)
                onDeleted()
              }}
            >
              <Trash2 className="h-3 w-3" />
              Delete
            </Button>
          </div>
        </div>
      ) : null}
    </Panel>
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
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <span className="text-ink-500 font-mono text-[11.5px]">{dir}</span>
        <span className="text-ink-600 text-[11.5px]">
          — one markdown file per agent, frontmatter plus prompt
        </span>
      </div>

      {status ? (
        <div className="border-bad/40 bg-bad/10 text-bad rounded-md border px-2.5 py-1.5 text-[12px]">
          {status}
        </div>
      ) : null}

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {agents.map((agent) => (
          <AgentCard
            key={agent.id}
            agent={agent}
            onSaved={() => void refreshConfig()}
            onDeleted={() => void refreshConfig()}
          />
        ))}

        <Panel className="flex flex-wrap items-end gap-2 px-3 py-3">
          <label className="flex flex-col gap-1">
            <Label>New agent id</Label>
            <input
              value={newId}
              spellCheck={false}
              placeholder="terraform"
              onChange={(event) => setNewId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void create()
              }}
              className="border-ink-800 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-48 rounded-md border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
            />
          </label>
          <Button variant="primary" onClick={() => void create()}>
            <Plus className="h-3 w-3" />
            Create agent
          </Button>
        </Panel>

        <Panel className="px-3 py-3">
          <div className="mb-2 flex items-center gap-2">
            <FileCode2 className="text-ink-500 h-3.5 w-3.5" />
            <span className="text-ink-200 text-[13px]">Import from ~/.claude/agents</span>
            <Button
              size="sm"
              variant="outline"
              className="ml-auto"
              disabled={picked.size === 0}
              onClick={async () => {
                const count = await window.opendesktop.agents.importFrom([...picked])
                setPicked(new Set())
                await refreshConfig()
                setStatus(count > 0 ? null : 'Nothing was imported.')
              }}
            >
              <Download className="h-3 w-3" />
              Import {picked.size > 0 ? picked.size : ''}
            </Button>
          </div>
          {importable.length === 0 ? (
            <span className="text-ink-600 text-[11.5px]">
              No agents found there. The format is the same, so any file you drop into either
              directory works in both.
            </span>
          ) : (
            <div className="space-y-1">
              {importable.map((agent) => (
                <label key={agent.id} className="flex cursor-pointer items-start gap-2">
                  <input
                    type="checkbox"
                    checked={picked.has(agent.id)}
                    onChange={(event) => {
                      const next = new Set(picked)
                      if (event.target.checked) next.add(agent.id)
                      else next.delete(agent.id)
                      setPicked(next)
                    }}
                    className="accent-brand mt-[3px]"
                  />
                  <span className="min-w-0">
                    <span className="text-ink-200 font-mono text-[12px]">{agent.id}</span>
                    {agent.description ? (
                      <span className="text-ink-600 ml-2 text-[11.5px]">{agent.description}</span>
                    ) : null}
                  </span>
                </label>
              ))}
            </div>
          )}
        </Panel>
      </div>
    </div>
  )
}
