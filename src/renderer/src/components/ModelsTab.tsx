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

  const setModels = (
    list: { id: string; name: string; contextWindow?: number; vision?: boolean }[]
  ): void => {
    const map: ProviderConfig['models'] = {}
    for (const m of list) map[m.id || 'unnamed'] = { ...m, id: m.id || 'unnamed' }
    patch({ models: map })
  }

  return (
    <Section
      title={provider.name || provider.id}
      description={
        <span className="font-mono text-[12px]">
          {provider.id}/&lt;model&gt; — how a model of this provider is named
        </span>
      }
      action={
        <IconButton title={`Remove ${provider.name || provider.id}`} tone="danger" onClick={onRemove}>
          <Trash2 className="h-4 w-4" />
        </IconButton>
      }
    >
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
        description="Mark a model as vision to let images be attached to it."
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
    </Section>
  )
}

export function ModelsTab(): ReactNode {
  const config = useStore((s) => s.config)
  const refreshConfig = useStore((s) => s.refreshConfig)
  const refreshSecrets = useStore((s) => s.refreshSecrets)

  const [draft, setDraft] = useState<AppConfig | null>(config)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [newId, setNewId] = useState('')
  const [newPreset, setNewPreset] = useState(PRESETS[0].id)

  /**
   * What we last wrote. Config changes echo back through the store, and without
   * this the echo would arrive after another keystroke and replace what is
   * being typed with the value from a moment ago.
   */
  const lastSaved = useRef<string | null>(null)

  useEffect(() => {
    if (!config) return
    if (lastSaved.current === JSON.stringify(config)) return
    setDraft(config)
  }, [config])

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(config), [draft, config])

  /**
   * Saved as you type, with no button to press. A settings screen that makes
   * you confirm is a settings screen that can be left half-applied, and the
   * old one silently did exactly that: a key stored against a provider whose
   * pending edit had not been saved read as doing nothing at all.
   */
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

  if (!draft) return null

  const allModels = Object.values(draft.provider).flatMap((p) =>
    Object.values(p.models).map((m) => ({
      value: `${p.id}/${m.id}`,
      label: `${m.name || m.id} · ${p.name || p.id}`
    }))
  )

  const addProvider = (): void => {
    const id = newId.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '-')
    if (!id) return setError('Give the provider an id first.')
    if (draft.provider[id]) return setError(`"${id}" already exists.`)
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
    setError(null)
  }

  return (
    <>
      <Section
        title="Models"
        description="Providers, their keys and the models they offer."
        action={
          error ? (
            <Hint tone="bad">{error}</Hint>
          ) : saved ? (
            <Hint tone="ok">Saved</Hint>
          ) : null
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
      </Section>

      {Object.values(draft.provider).map((provider) => (
        <ProviderSection
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
            // Point the config at the keychain entry that was just written. The
            // autosave below persists it; without this the provider would keep
            // reading whatever placeholder was there before.
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

      <Section title="Add a provider">
        <Row label="Provider id" description="Lowercase, used as the prefix of every model name.">
          <RowInput
            mono
            width="w-[160px]"
            value={newId}
            placeholder="helmcode"
            onChange={setNewId}
          />
          <RowSelect
            value={newPreset}
            onChange={(event) => setNewPreset(event.target.value)}
            options={PRESETS.map((p) => ({ value: p.id, label: p.label }))}
          />
          <IconButton title="Add provider" tone="accent" onClick={addProvider}>
            <Plus className="h-4 w-4" />
          </IconButton>
        </Row>
      </Section>
    </>
  )
}
