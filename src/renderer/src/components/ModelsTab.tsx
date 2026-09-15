import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { CheckCircle2, CircleAlert, Eye, EyeOff, KeyRound, Plus, Save, Trash2 } from 'lucide-react'
import type { AppConfig, ProviderConfig } from '@shared/types'
import { useStore } from '../state/store'
import { Button, Label, Panel, Select } from './ui'

const PRESETS: { id: string; label: string; npm: string; baseURL?: string; model?: string }[] = [
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

function Field({
  label,
  value,
  onChange,
  placeholder,
  mono = true,
  className
}: {
  label: string
  value: string
  onChange: (value: string) => void
  placeholder?: string
  mono?: boolean
  className?: string
}): ReactNode {
  return (
    <label className={clsx('flex flex-col gap-1', className)}>
      <Label>{label}</Label>
      <input
        value={value}
        spellCheck={false}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={clsx(
          'border-ink-700 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 rounded border px-2 py-1 text-[11.5px] outline-none',
          mono && 'font-mono'
        )}
      />
    </label>
  )
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

  return (
    <div className="border-ink-700 bg-ink-900 rounded border px-2.5 py-2">
      <div className="mb-1.5 flex items-center gap-2">
        <KeyRound className="text-ink-500 h-3.5 w-3.5" />
        <Label>API key</Label>
        {status ? (
          <span
            className={clsx(
              'flex items-center gap-1 text-[10px]',
              status.resolved ? 'text-ok' : 'text-warn'
            )}
          >
            {status.resolved ? (
              <CheckCircle2 className="h-3 w-3" />
            ) : (
              <CircleAlert className="h-3 w-3" />
            )}
            {status.resolved ? `resolved from ${status.source}` : `not resolved (${status.source})`}
          </span>
        ) : null}
        {hint ? <span className="text-ink-500 ml-auto font-mono text-[10.5px]">{hint}</span> : null}
      </div>

      {!secrets.available ? (
        <div className="text-warn text-[10.5px]">
          The system keychain is unavailable, so keys cannot be stored here. Use{' '}
          <span className="font-mono">{'{env:VAR}'}</span> or{' '}
          <span className="font-mono">{'{file:~/path}'}</span> in the config file instead.
        </div>
      ) : (
        <div className="flex items-center gap-1.5">
          <input
            type={reveal ? 'text' : 'password'}
            value={draft}
            spellCheck={false}
            autoComplete="off"
            placeholder={hint ? 'Replace the stored key…' : 'Paste the key to store it in the keychain'}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void save()
            }}
            className="border-ink-700 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11.5px] outline-none"
          />
          <Button size="sm" onClick={() => setReveal(!reveal)} title={reveal ? 'Hide' : 'Show'}>
            {reveal ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
          </Button>
          <Button size="sm" variant="primary" disabled={!draft.trim() || busy} onClick={() => void save()}>
            Store
          </Button>
          {hint ? (
            <Button size="sm" variant="danger" disabled={busy} onClick={() => void remove()}>
              Remove
            </Button>
          ) : null}
        </div>
      )}

      {error ? <div className="text-bad mt-1 text-[10.5px]">{error}</div> : null}
      <div className="text-ink-600 mt-1 text-[10px]">
        Encrypted with the system keychain and written to secrets.json. It never goes into the
        config file, which only stores the reference{' '}
        <span className="font-mono">{`{secret:${providerId}}`}</span>.
      </div>
    </div>
  )
}

function ProviderCard({
  provider,
  onChange,
  onRemove,
  onKeyStored
}: {
  provider: ProviderConfig
  onChange: (next: ProviderConfig) => void
  onRemove: () => void
  onKeyStored: () => void
}): ReactNode {
  const patch = (next: Partial<ProviderConfig>): void => onChange({ ...provider, ...next })
  const patchOptions = (next: Record<string, unknown>): void =>
    onChange({ ...provider, options: { ...provider.options, ...next } })

  const models = Object.values(provider.models)
  const usesBaseUrl = provider.npm === '@ai-sdk/openai-compatible' || provider.npm === '@ai-sdk/openai'

  const setModels = (list: { id: string; name: string; contextWindow?: number }[]): void => {
    const map: ProviderConfig['models'] = {}
    for (const m of list) map[m.id || 'unnamed'] = { ...m, id: m.id || 'unnamed' }
    patch({ models: map })
  }

  return (
    <Panel className="px-3 py-3">
      <div className="mb-2 flex items-center gap-2">
        <span className="text-ink-100 text-[12.5px] font-semibold">{provider.name || provider.id}</span>
        <span className="border-ink-700 text-ink-500 rounded border px-1.5 font-mono text-[10px]">
          {provider.id}
        </span>
        <Button size="sm" variant="danger" className="ml-auto" onClick={onRemove}>
          <Trash2 className="h-3 w-3" />
          Remove provider
        </Button>
      </div>

      <div className="mb-2 grid grid-cols-2 gap-2">
        <Field label="Display name" value={provider.name} mono={false} onChange={(name) => patch({ name })} />
        <label className="flex flex-col gap-1">
          <Label>AI SDK package</Label>
          <select
            value={provider.npm}
            onChange={(event) => patch({ npm: event.target.value })}
            className="border-ink-700 bg-ink-900 text-ink-200 focus:border-ink-600 cursor-pointer rounded border px-2 py-1 font-mono text-[11.5px] outline-none"
          >
            {PRESETS.map((preset) => (
              <option key={preset.npm} value={preset.npm}>
                {preset.npm}
              </option>
            ))}
            {PRESETS.every((p) => p.npm !== provider.npm) ? (
              <option value={provider.npm}>{provider.npm}</option>
            ) : null}
          </select>
        </label>
      </div>

      {usesBaseUrl ? (
        <Field
          className="mb-2"
          label="Base URL"
          value={String(provider.options.baseURL ?? '')}
          placeholder="https://api.example.com/v1"
          onChange={(baseURL) => patchOptions({ baseURL })}
        />
      ) : null}

      <div className="mb-2">
        <ApiKeyRow providerId={provider.id} onStored={onKeyStored} />
      </div>

      <div className="border-ink-700 rounded border">
        <div className="border-ink-700 flex items-center gap-2 border-b px-2.5 py-1.5">
          <Label>Models</Label>
          <span className="text-ink-600 text-[10px]">
            referenced as {provider.id}/&lt;id&gt;
          </span>
          <Button
            size="sm"
            className="ml-auto"
            onClick={() => setModels([...models, { id: '', name: '' }])}
          >
            <Plus className="h-3 w-3" />
            Add model
          </Button>
        </div>
        {models.length === 0 ? (
          <div className="text-ink-600 px-2.5 py-2 text-[11px]">
            No models yet — add one to make this provider selectable.
          </div>
        ) : (
          models.map((model, index) => (
            <div key={index} className="border-ink-800 flex items-center gap-1.5 border-b px-2.5 py-1.5 last:border-b-0">
              <input
                value={model.id}
                spellCheck={false}
                placeholder="model-id"
                onChange={(event) => {
                  const next = models.slice()
                  next[index] = { ...model, id: event.target.value }
                  setModels(next)
                }}
                className="border-ink-700 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[38%] rounded border px-2 py-1 font-mono text-[11px] outline-none"
              />
              <input
                value={model.name}
                placeholder="Display name"
                onChange={(event) => {
                  const next = models.slice()
                  next[index] = { ...model, name: event.target.value }
                  setModels(next)
                }}
                className="border-ink-700 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-w-0 flex-1 rounded border px-2 py-1 text-[11px] outline-none"
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
                className="border-ink-700 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-20 rounded border px-2 py-1 font-mono text-[11px] outline-none"
              />
              <button
                type="button"
                title="Remove model"
                onClick={() => setModels(models.filter((_, i) => i !== index))}
                className="text-ink-600 hover:text-bad"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>
          ))
        )}
      </div>
    </Panel>
  )
}

export function ModelsTab(): ReactNode {
  const config = useStore((s) => s.config)
  const refreshConfig = useStore((s) => s.refreshConfig)
  const refreshSecrets = useStore((s) => s.refreshSecrets)

  const [draft, setDraft] = useState<AppConfig | null>(config)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; message: string } | null>(null)
  const [newId, setNewId] = useState('')
  const [newPreset, setNewPreset] = useState(PRESETS[0].id)

  useEffect(() => {
    setDraft(config)
  }, [config])

  const dirty = useMemo(
    () => JSON.stringify(draft) !== JSON.stringify(config),
    [draft, config]
  )

  if (!draft) return null

  const allModels = Object.values(draft.provider).flatMap((p) =>
    Object.values(p.models).map((m) => ({
      value: `${p.id}/${m.id}`,
      label: `${m.name || m.id} · ${p.name || p.id}`
    }))
  )

  const save = async (): Promise<void> => {
    try {
      await window.opendesktop.config.save(draft)
      await refreshConfig()
      setStatus({ kind: 'ok', message: 'Saved. Providers were reloaded.' })
    } catch (err) {
      setStatus({ kind: 'error', message: (err as Error).message })
    }
  }

  const addProvider = (): void => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (!id) return setStatus({ kind: 'error', message: 'Give the provider an id first.' })
    if (draft.provider[id]) return setStatus({ kind: 'error', message: `"${id}" already exists.` })
    const preset = PRESETS.find((p) => p.id === newPreset) ?? PRESETS[0]
    setDraft({
      ...draft,
      provider: {
        ...draft.provider,
        [id]: {
          id,
          name: id,
          npm: preset.npm,
          // The key is stored in the keychain under the provider id.
          options: { baseURL: preset.baseURL, apiKey: `{secret:${id}}` },
          models: {}
        }
      }
    })
    setNewId('')
    setStatus(null)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <div className="flex items-center gap-2">
        <Select
          label="Default model"
          value={draft.model}
          onChange={(event) => setDraft({ ...draft, model: event.target.value })}
          options={allModels.length ? allModels : [{ value: draft.model, label: draft.model }]}
        />
        <span className="text-ink-600 text-[10px]">Used by new sessions and by agents with no model of their own.</span>
        <Button variant="primary" className="ml-auto" disabled={!dirty} onClick={() => void save()}>
          <Save className="h-3 w-3" />
          {dirty ? 'Save changes' : 'Saved'}
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

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto pr-1">
        {Object.values(draft.provider).map((provider) => (
          <ProviderCard
            key={provider.id}
            provider={provider}
            onChange={(next) =>
              setDraft({ ...draft, provider: { ...draft.provider, [provider.id]: next } })
            }
            onRemove={() => {
              const rest = { ...draft.provider }
              delete rest[provider.id]
              setDraft({ ...draft, provider: rest })
            }}
            onKeyStored={() => {
              // Point the config at the keychain entry that was just written.
              const current = draft.provider[provider.id]
              if (current && current.options.apiKey !== `{secret:${provider.id}}`) {
                setDraft({
                  ...draft,
                  provider: {
                    ...draft.provider,
                    [provider.id]: {
                      ...current,
                      options: { ...current.options, apiKey: `{secret:${provider.id}}` }
                    }
                  }
                })
              }
              void refreshSecrets()
            }}
          />
        ))}

        <Panel className="flex items-end gap-2 px-3 py-2.5">
          <label className="flex flex-col gap-1">
            <Label>New provider id</Label>
            <input
              value={newId}
              spellCheck={false}
              placeholder="helmcode"
              onChange={(event) => setNewId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') addProvider()
              }}
              className="border-ink-700 bg-ink-900 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-44 rounded border px-2 py-1 font-mono text-[11.5px] outline-none"
            />
          </label>
          <Select
            label="Kind"
            value={newPreset}
            onChange={(event) => setNewPreset(event.target.value)}
            options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          />
          <Button variant="outline" onClick={addProvider}>
            <Plus className="h-3 w-3" />
            Add
          </Button>
        </Panel>
      </div>
    </div>
  )
}
