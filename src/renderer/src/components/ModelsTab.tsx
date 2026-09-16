import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import type { AppConfig, ProviderConfig } from '@shared/types'
import { useStore } from '../state/store'
import { Hint, IconButton, Row, RowInput, RowSelect, Section } from './settings-ui'

const PRESETS: { id: string; label: string; npm: string; baseURL?: string }[] = [
  {
    id: 'openai-compatible',
    label: 'OpenAI-compatible endpoint',
    npm: '@ai-sdk/openai-compatible',
    baseURL: 'https://'
  },
  { id: 'anthropic', label: 'Anthropic', npm: '@ai-sdk/anthropic' },
  { id: 'openai', label: 'OpenAI', npm: '@ai-sdk/openai' },
  { id: 'google', label: 'Google', npm: '@ai-sdk/google' }
]

/**
 * A price as typed. An empty box means unknown, which is not the same as free,
 * so it stays undefined rather than becoming 0.
 */
function money(value: string): number | undefined {
  const cleaned = value.replace(/[^0-9.]/g, '')
  if (!cleaned) return undefined
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** The API key row. The value only ever travels one way: into the keychain. */
function ApiKeyRow({ providerId, onStored }: { providerId: string; onStored: () => void }): ReactNode {
  const secrets = useStore((s) => s.secrets)
  const keyStatus = useStore((s) => s.keyStatus)
  const refreshSecrets = useStore((s) => s.refreshSecrets)

  const [draft, setDraft] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const hint = secrets.hints[providerId] ?? null
  const unreadable = secrets.failed.includes(providerId)
  const status = keyStatus[providerId]

  const save = async (): Promise<void> => {
    if (!draft.trim()) return
    setBusy(true)
    setError(null)
    try {
      await window.opendesktop.secrets.set(providerId, draft.trim())
      setDraft('')
      await refreshSecrets()
      onStored()
    } catch (err) {
      setError((err as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const remove = async (): Promise<void> => {
    setBusy(true)
    await window.opendesktop.secrets.remove(providerId)
    await refreshSecrets()
    setBusy(false)
  }

  if (!secrets.available) {
    return (
      <Row
        label="API key"
        description={
          <>
            The system keychain is unavailable, so keys cannot be stored here. Use{' '}
            <span className="font-mono">{'{env:VAR}'}</span> in the config file instead.
          </>
        }
      />
    )
  }

  return (
    <Row
      label="API key"
      description={
        error ? (
          <span className="text-bad">{error}</span>
        ) : unreadable ? (
          <span className="text-warn">
            A key is stored but this build cannot decrypt it — the keychain entry was written by
            another identity. Paste it again to replace it.
          </span>
        ) : status && !status.resolved ? (
          <span className="text-warn inline-flex items-center gap-1">
            <CircleAlert className="h-3 w-3" />
            not resolved ({status.source})
          </span>
        ) : status?.resolved ? (
          `resolved from ${status.source}`
        ) : (
          'Kept in the keychain. The config only stores the reference.'
        )
      }
    >
      {hint ? <Hint>{hint}</Hint> : null}
      <input
        type={reveal ? 'text' : 'password'}
        value={draft}
        spellCheck={false}
        autoComplete="off"
        placeholder={hint ? 'Replace…' : 'Paste the key'}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void save()
        }}
        className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[220px] rounded-lg border px-2.5 py-1.5 font-mono text-[12.5px] outline-none"
      />
      <IconButton title={reveal ? 'Hide' : 'Show'} onClick={() => setReveal(!reveal)}>
        {reveal ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
      </IconButton>
      <IconButton
        title="Store in the keychain"
        tone="accent"
        disabled={!draft.trim() || busy}
        onClick={() => void save()}
      >
        <Check className="h-4 w-4" />
      </IconButton>
      {hint ? (
        <IconButton title="Delete the stored key" tone="danger" disabled={busy} onClick={() => void remove()}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      ) : null}
    </Row>
  )
}

function ProviderSection({
  provider,
  onChange,
  onKeyStored
}: {
  provider: ProviderConfig
  onChange: (next: ProviderConfig) => void
  onKeyStored: () => void
}): ReactNode {
  const patch = (next: Partial<ProviderConfig>): void => onChange({ ...provider, ...next })
  const patchOptions = (next: Record<string, unknown>): void =>
    onChange({ ...provider, options: { ...provider.options, ...next } })

  const models = Object.values(provider.models)
  const usesBaseUrl = provider.npm === '@ai-sdk/openai-compatible' || provider.npm === '@ai-sdk/openai'

  const setModels = (
    list: {
      id: string
      name: string
      contextWindow?: number
      vision?: boolean
      price?: { input?: number; output?: number }
    }[]
  ): void => {
    const map: ProviderConfig['models'] = {}
    for (const m of list) map[m.id || 'unnamed'] = { ...m, id: m.id || 'unnamed' }
    patch({ models: map })
  }

  return (
    <>
      <Row
        label="Id"
        description={
          <>
            Its models are named <span className="font-mono">{provider.id}/&lt;model&gt;</span>. Set
            when the provider is created — sessions, agents and the stored key all refer to it.
          </>
        }
      >
        <RowInput mono disabled value={provider.id} onChange={() => undefined} width="w-[160px]" />
      </Row>

      <Row label="Display name">
        <RowInput value={provider.name} onChange={(name) => patch({ name })} />
      </Row>

      <Row label="AI SDK package">
        <RowSelect
          value={provider.npm}
          onChange={(event) => patch({ npm: event.target.value })}
          className="font-mono text-[12.5px]"
          options={[
            ...PRESETS.map((preset) => ({ value: preset.npm, label: preset.npm })),
            ...(PRESETS.every((p) => p.npm !== provider.npm)
              ? [{ value: provider.npm, label: provider.npm }]
              : [])
          ]}
        />
      </Row>

      {usesBaseUrl ? (
        <Row label="Base URL">
          <RowInput
            mono
            value={String(provider.options.baseURL ?? '')}
            placeholder="https://api.example.com/v1"
            onChange={(baseURL) => patchOptions({ baseURL })}
          />
        </Row>
      ) : null}

      <ApiKeyRow providerId={provider.id} onStored={onKeyStored} />

      <Row
        label="Models"
        description="Id, name, context window, then the price per million tokens in and out — copied straight from the provider's page. Mark a model as vision to let images be attached."
      >
        <IconButton
          title="Add a model"
          onClick={() => setModels([...models, { id: '', name: '' }])}
        >
          <Plus className="h-4 w-4" />
        </IconButton>
      </Row>

      {models.length === 0 ? (
        <Row label={<Hint>No models yet — add one to make this provider selectable.</Hint>} />
      ) : (
        models.map((model, index) => (
          <Row key={index}>
            <div className="flex w-full items-center gap-1.5">
              <input
                value={model.id}
                spellCheck={false}
                placeholder="model-id"
                onChange={(event) => {
                  const next = models.slice()
                  next[index] = { ...model, id: event.target.value }
                  setModels(next)
                }}
                className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[34%] rounded-lg border px-2.5 py-1.5 font-mono text-[12px] outline-none"
              />
              <input
                value={model.name}
                placeholder="Display name"
                onChange={(event) => {
                  const next = models.slice()
                  next[index] = { ...model, name: event.target.value }
                  setModels(next)
                }}
                className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-w-0 flex-1 rounded-lg border px-2.5 py-1.5 text-[12px] outline-none"
              />
              <input
                value={model.contextWindow ? String(model.contextWindow) : ''}
                placeholder="context"
                inputMode="numeric"
                onChange={(event) => {
                  const next = models.slice()
                  const parsed = Number(event.target.value.replace(/\D/g, ''))
                  next[index] = { ...model, contextWindow: parsed || undefined }
                  setModels(next)
                }}
                className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[84px] rounded-lg border px-2.5 py-1.5 font-mono text-[12px] outline-none"
              />
              <input
                value={model.price?.input !== undefined ? String(model.price.input) : ''}
                placeholder="$ in"
                inputMode="decimal"
                title="Price per million input tokens"
                onChange={(event) => {
                  const next = models.slice()
                  next[index] = { ...model, price: { ...model.price, input: money(event.target.value) } }
                  setModels(next)
                }}
                className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[64px] rounded-lg border px-2 py-1.5 font-mono text-[12px] outline-none"
              />
              <input
                value={model.price?.output !== undefined ? String(model.price.output) : ''}
                placeholder="$ out"
                inputMode="decimal"
                title="Price per million output tokens"
                onChange={(event) => {
                  const next = models.slice()
                  next[index] = { ...model, price: { ...model.price, output: money(event.target.value) } }
                  setModels(next)
                }}
                className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[64px] rounded-lg border px-2 py-1.5 font-mono text-[12px] outline-none"
              />
              <button
                type="button"
                title={
                  model.vision
                    ? 'Images are sent to this model'
                    : 'Mark this model as able to read images'
                }
                onClick={() => {
                  const next = models.slice()
                  next[index] = { ...model, vision: !model.vision }
                  setModels(next)
                }}
                className={clsx(
                  'rounded-md border px-2 py-1.5 text-[11px]',
                  model.vision
                    ? 'border-ok/40 bg-ok/10 text-ok'
                    : 'border-ink-800 text-ink-600 hover:text-ink-300'
                )}
              >
                vision
              </button>
              <IconButton
                title="Remove model"
                tone="danger"
                onClick={() => setModels(models.filter((_, i) => i !== index))}
              >
                <Trash2 className="h-4 w-4" />
              </IconButton>
            </div>
          </Row>
        ))
      )}
    </>
  )
}

export function ModelsTab(): ReactNode {
  const config = useStore((s) => s.config)
  const refreshConfig = useStore((s) => s.refreshConfig)
  const refreshSecrets = useStore((s) => s.refreshSecrets)

  const [draft, setDraft] = useState<AppConfig | null>(config)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [selected, setSelected] = useState<string>('')

  /**
   * A provider being created. It lives here rather than in the config until it
   * has an id, because the id is the key: committing on every keystroke would
   * create "h", "he", "hel" and delete each one again.
   */
  const [creating, setCreating] = useState<ProviderConfig | null>(null)
  const [newId, setNewId] = useState('')

  const lastSaved = useRef<string | null>(null)

  useEffect(() => {
    if (!config) return
    if (lastSaved.current === JSON.stringify(config)) return
    setDraft(config)
  }, [config])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config])

  useEffect(() => {
    if (!draft || !dirty) return
    const timer = setTimeout(() => {
      const payload = JSON.stringify(draft)
      void window.opendesktop.config
        .save(draft)
        .then(() => {
          lastSaved.current = payload
          setError(null)
          setSaved(true)
          setTimeout(() => setSaved(false), 1600)
          return refreshConfig()
        })
        .catch((err: Error) => setError(err.message))
    }, 700)
    return () => clearTimeout(timer)
  }, [draft, dirty, refreshConfig])

  // Whatever the picker is on, falling back to the first real provider.
  const providers = useMemo(() => Object.values(draft?.provider ?? {}), [draft])
  useEffect(() => {
    if (creating) return
    if (!selected || !draft?.provider[selected]) setSelected(providers[0]?.id ?? '')
  }, [providers, selected, draft, creating])

  if (!draft) return null

  const current = creating ?? draft.provider[selected]

  const allModels = Object.values(draft.provider).flatMap((p) =>
    Object.values(p.models).map((m) => ({
      value: `${p.id}/${m.id}`,
      label: `${m.name || m.id} · ${p.name || p.id}`
    }))
  )

  const startNew = (): void => {
    setCreating({
      id: '',
      name: '',
      npm: PRESETS[0].npm,
      options: { baseURL: PRESETS[0].baseURL, apiKey: '' },
      models: {}
    })
    setNewId('')
    setError(null)
  }

  /** Commits the new provider once its id is something that can be a key. */
  const commitNew = (): void => {
    if (!creating) return
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (!id) return setError('The id is required.')
    if (draft.provider[id]) return setError(`"${id}" already exists.`)
    const provider: ProviderConfig = {
      ...creating,
      id,
      name: creating.name || id,
      // The key is stored in the keychain under the provider id.
      options: { ...creating.options, apiKey: `{secret:${id}}` }
    }
    setDraft({ ...draft, provider: { ...draft.provider, [id]: provider } })
    setCreating(null)
    setSelected(id)
    setError(null)
  }

  const removeCurrent = (): void => {
    if (creating) {
      setCreating(null)
      return
    }
    const rest = { ...draft.provider }
    delete rest[selected]
    setDraft({ ...draft, provider: rest })
    setSelected(Object.keys(rest)[0] ?? '')
  }

  return (
    <>
      <Section
        title="Models"
        description="Providers, their keys and the models they offer."
        action={
          error ? <Hint tone="bad">{error}</Hint> : saved ? <Hint tone="ok">Saved</Hint> : null
        }
      >
        <Row
          label="Default model"
          description="Used by new sessions, and by agents with no model of their own."
        >
          <RowSelect
            value={draft.model}
            onChange={(event) => setDraft({ ...draft, model: event.target.value })}
            options={allModels.length ? allModels : [{ value: draft.model, label: draft.model }]}
          />
        </Row>

        <Row
          label="Tasks at once"
          description="How many board tasks the scheduler runs in parallel. A task waiting on your approval does not count against this."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(draft.maxConcurrentTasks ?? 2)}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({ ...draft, maxConcurrentTasks: Math.min(12, Math.max(1, parsed || 1)) })
            }}
          />
        </Row>

        <Row label="Provider" description="Which one you are editing.">
          <RowSelect
            value={creating ? '__new__' : selected}
            onChange={(event) => {
              if (event.target.value === '__new__') return
              setCreating(null)
              setSelected(event.target.value)
            }}
            options={[
              ...providers.map((provider) => ({
                value: provider.id,
                label: provider.name || provider.id
              })),
              ...(creating ? [{ value: '__new__', label: 'New provider…' }] : []),
              ...(providers.length === 0 && !creating
                ? [{ value: '', label: 'None yet' }]
                : [])
            ]}
          />
          <IconButton title="Add a provider" tone="accent" onClick={startNew}>
            <Plus className="h-4 w-4" />
          </IconButton>
          {current ? (
            <IconButton
              title={creating ? 'Discard' : `Remove ${current.name || current.id}`}
              tone="danger"
              onClick={removeCurrent}
            >
              <Trash2 className="h-4 w-4" />
            </IconButton>
          ) : null}
        </Row>
      </Section>

      <Section
        title="Context"
        description="How much of a model's window a session may fill before its older half is summarised, and when tool output stops being resent."
      >
        <Row
          label="Summarise at"
          description="Share of the usable window — the model's context minus room for its reply — at which the older messages are replaced by a summary."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(Math.round((draft.compactAtFraction ?? 0.7) * 100))}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({
                ...draft,
                compactAtFraction: Math.min(0.95, Math.max(0.2, (parsed || 70) / 100))
              })
            }}
          />
          <Hint>%</Hint>
        </Row>
        <Row
          label="Keep verbatim"
          description="Messages at the end of the transcript that a summary never touches."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(draft.keepRecentMessages ?? 8)}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({ ...draft, keepRecentMessages: Math.min(40, Math.max(2, parsed || 8)) })
            }}
          />
        </Row>
        <Row
          label="Drop tool output after"
          description="Turns after which a command's output stops being resent, replaced by a note naming the call. Costs nothing and usually saves more than a summary."
        >
          <RowInput
            mono
            width="w-[72px]"
            value={String(draft.dehydrateAfterTurns ?? 2)}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              setDraft({ ...draft, dehydrateAfterTurns: Math.min(20, Math.max(1, parsed || 2)) })
            }}
          />
          <Hint>turns</Hint>
        </Row>
      </Section>

      {creating ? (
        <Section title="New provider">
          <Row
            label="Id"
            description="Required, lowercase. Its models will be named <id>/<model>."
          >
            <RowInput
              mono
              width="w-[160px]"
              value={newId}
              placeholder="helmcode"
              onChange={setNewId}
            />
            <IconButton title="Create" tone="accent" disabled={!newId.trim()} onClick={commitNew}>
              <Check className="h-4 w-4" />
            </IconButton>
          </Row>
          <Row label="Kind" description="Which SDK package talks to it.">
            <RowSelect
              value={creating.npm}
              onChange={(event) => {
                const preset = PRESETS.find((p) => p.npm === event.target.value) ?? PRESETS[0]
                setCreating({
                  ...creating,
                  npm: preset.npm,
                  options: { ...creating.options, baseURL: preset.baseURL }
                })
              }}
              options={PRESETS.map((preset) => ({ value: preset.npm, label: preset.label }))}
            />
          </Row>
        </Section>
      ) : current ? (
        <Section title={current.name || current.id}>
          <ProviderSection
            provider={current}
            onChange={(next) =>
              setDraft({ ...draft, provider: { ...draft.provider, [current.id]: next } })
            }
            onKeyStored={() => {
              // Point the config at the keychain entry that was just written.
              // The autosave persists it; without this the provider would keep
              // reading whatever placeholder was there before.
              const existing = draft.provider[current.id]
              if (existing && existing.options.apiKey !== `{secret:${current.id}}`) {
                setDraft({
                  ...draft,
                  provider: {
                    ...draft.provider,
                    [current.id]: {
                      ...existing,
                      options: { ...existing.options, apiKey: `{secret:${current.id}}` }
                    }
                  }
                })
              }
              void refreshSecrets()
            }}
          />
        </Section>
      ) : (
        <Section title="No providers">
          <Row label={<Hint>Add one to make a model selectable.</Hint>} />
        </Section>
      )}
    </>
  )
}
