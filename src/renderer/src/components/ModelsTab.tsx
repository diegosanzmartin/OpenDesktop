import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Check, CircleAlert, Eye, EyeOff, Plus, Trash2 } from 'lucide-react'
import type { ProviderConfig, ProviderModelConfig } from '@shared/types'
import { PROVIDER_PRESETS, mergeDiscovered, presetFor } from '@shared/catalog'
import {
  BILLINGS,
  allowanceFor,
  allowanceUsed,
  capability,
  costTier,
  type Allowance,
  type Billing,
  type Spent
} from '@shared/routing'
import { useStore } from '../state/store'
import { Hint, IconButton, Row, RowInput, RowSelect, RowSlider, Section } from './settings-ui'
import { LocalModelSection } from './LocalModelSection'
import { limitLabel, money, spendLabel, useConfigDraft, useSpend } from '../lib/settings'

const PRESETS = PROVIDER_PRESETS

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
        ) : draft.trim() ? (
          /*
           * A typed key is not a stored key.
           *
           * The field commits to the keychain on its own — the page's Save
           * button writes the config and never touches a secret — so a key
           * typed and left there looks set and is not. One key went missing
           * exactly that way.
           */
          <span className="text-warn">
            Not stored yet — press ↵ or the ✓ to put it in the keychain. The Save button
            below writes settings, not keys.
          </span>
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
  onKeyStored,
  keySpend,
  spentFor
}: {
  provider: ProviderConfig
  onChange: (next: ProviderConfig) => void
  onKeyStored: () => void
  /** What this key has spent against its own limit, when it has one. */
  keySpend?: { allowance: Allowance; spent: Spent } | null
  /** What one model has spent against whichever allowance covers it. */
  spentFor: (ref: string) => Spent
}): ReactNode {
  const patch = (next: Partial<ProviderConfig>): void => onChange({ ...provider, ...next })
  const patchOptions = (next: Record<string, unknown>): void =>
    onChange({ ...provider, options: { ...provider.options, ...next } })

  const models = Object.values(provider.models)
  const usesBaseUrl = provider.npm === '@ai-sdk/openai-compatible' || provider.npm === '@ai-sdk/openai'

  const [asking, setAsking] = useState(false)
  const [found, setFound] = useState<string | null>(null)

  /**
   * Asks the provider which models this key can see, and adds what is missing.
   *
   * What is already configured is never overwritten — a price typed by hand or
   * a slider moved outranks a list of ids. Prices do not come back from any of
   * these endpoints; the ones this app publishes itself are filled in, and the
   * rest are left empty, because an unknown price must not read as free.
   */
  const discover = async (): Promise<void> => {
    setAsking(true)
    setFound(null)
    try {
      const answer = await window.opendesktop.models.discover(provider.id)
      if (answer.error) {
        setFound(`Could not ask: ${answer.error}`)
        return
      }
      const merged = mergeDiscovered(provider.models, answer.models)
      onChange({ ...provider, models: merged.models })
      setFound(
        merged.added.length === 0
          ? `${answer.models.length} models offered, all of them already here.`
          : `Added ${merged.added.length} of the ${answer.models.length} models this key can see` +
            `${merged.priced.length > 0 ? `, ${merged.priced.length} with prices this app publishes` : ''}` +
            `. Anything without a price needs one typed in.`
      )
    } finally {
      setAsking(false)
    }
  }

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

      {/*
       * The limit belongs beside the key, because that is what it is a limit
       * on. $400 a month on an Anthropic key is $400 across every model under
       * it, and setting it here is what makes them share it — a number typed
       * into each model is a separate budget each, which is rarely what anyone
       * means.
       */}
      <Row
        label="Spend limit on this key"
        description={
          keySpend
            ? `Shared by every model under it. ${spendLabel(keySpend.spent, keySpend.allowance)} — counted by this app, since no provider reports a balance back.`
            : 'Shared by every model under it. Leave empty for no limit; a model can still be given one of its own.'
        }
      >
        <div className="flex flex-wrap items-center justify-end gap-x-2 gap-y-1.5">
          <RowInput
            mono
            width="w-[92px]"
            placeholder="tokens"
            value={provider.allowance?.tokens !== undefined ? String(provider.allowance.tokens) : ''}
            onChange={(value) => {
              const parsed = Number(value.replace(/\D/g, ''))
              patch({
                allowance: {
                  ...provider.allowance,
                  period: provider.allowance?.period ?? 'month',
                  tokens: parsed || undefined
                }
              })
            }}
          />
          <Hint>or</Hint>
          <RowInput
            mono
            width="w-[76px]"
            placeholder="$"
            value={provider.allowance?.usd !== undefined ? String(provider.allowance.usd) : ''}
            onChange={(value) =>
              patch({
                allowance: {
                  ...provider.allowance,
                  period: provider.allowance?.period ?? 'month',
                  usd: money(value)
                }
              })
            }
          />
          <RowSelect
            value={provider.allowance?.period ?? 'month'}
            onChange={(event) =>
              patch({
                allowance: {
                  ...provider.allowance,
                  period: event.target.value as 'day' | 'month'
                }
              })
            }
            options={[
              { value: 'month', label: 'per month' },
              { value: 'day', label: 'per day' }
            ]}
          />
        </div>
      </Row>

      <Row
        label="Models"
        description={
          found
            ? found
            : "Id, name, context window, then the price per million tokens in and out — copied straight from the provider's page. Mark a model as vision to let images be attached."
        }
      >
        {presetFor(provider.npm)?.discoverable ? (
          <button
            type="button"
            disabled={asking}
            onClick={() => void discover()}
            className="border-ink-800 text-ink-300 hover:text-ink-100 hover:border-ink-600 rounded-lg border px-2.5 py-1.5 text-[12px] disabled:opacity-50"
          >
            {asking ? 'Asking…' : 'Ask the provider'}
          </button>
        ) : null}
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
        models.map((model, index) => {
          const ref = `${provider.id}/${model.id}`
          const billing: Billing = model.billing ?? 'pay-as-you-go'
          const spend = spentFor(ref)
          const limit = allowanceFor({ provider: { [provider.id]: provider } } as never, provider.id, model)
          const fraction = allowanceUsed(limit, spend)
          const patchModel = (next: Partial<ProviderModelConfig>): void =>
            patch({ models: { ...provider.models, [model.id]: { ...model, ...next } } })

          return (
            /*
             * Everything about one model in one block.
             *
             * Its id and price used to be here and its billing, allowance and
             * two judgements in a separate section listing every model of every
             * provider — so setting up one model meant editing it in two places
             * on the same page, and the comparison view nobody was editing was
             * the one that overflowed. The comparison is on the routing page
             * now, read-only; this is where a model is configured.
             */
            <div
              key={index}
              className="border-ink-800/70 flex flex-col gap-2 border-b py-3.5"
            >
              <div className="flex flex-wrap items-center gap-1.5">
                <input
                  value={model.id}
                  spellCheck={false}
                  placeholder="model-id"
                  onChange={(event) => {
                    const next = models.slice()
                    next[index] = { ...model, id: event.target.value }
                    setModels(next)
                  }}
                  className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 w-[30%] min-w-[150px] rounded-lg border px-2.5 py-1.5 font-mono text-[12px] outline-none"
                />
                <input
                  value={model.name}
                  placeholder="Display name"
                  onChange={(event) => {
                    const next = models.slice()
                    next[index] = { ...model, name: event.target.value }
                    setModels(next)
                  }}
                  className="border-ink-800 bg-ink-850 text-ink-200 placeholder:text-ink-600 focus:border-ink-600 min-w-[120px] flex-1 rounded-lg border px-2.5 py-1.5 text-[12px] outline-none"
                />
                <input
                  value={model.contextWindow ? String(model.contextWindow) : ''}
                  placeholder="context"
                  inputMode="numeric"
                  title="Advertised context window, for the token gauge"
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

              <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                <RowSelect
                  value={billing}
                  onChange={(event) => patchModel({ billing: event.target.value as Billing })}
                  options={BILLINGS.map((kind) => ({ value: kind.id, label: kind.label }))}
                />

                {billing === 'flat' ? (
                  <div className="flex items-center gap-1.5">
                    <RowInput
                      mono
                      width="w-[76px]"
                      placeholder="$"
                      value={model.monthlyCost !== undefined ? String(model.monthlyCost) : ''}
                      onChange={(value) => patchModel({ monthlyCost: money(value) })}
                    />
                    <Hint>/ month</Hint>
                  </div>
                ) : null}

                {billing === 'allowance' ? (
                  provider.allowance && !model.allowance ? (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <Hint tone={(fraction ?? 0) >= 0.9 ? 'warn' : 'muted'}>
                        shares this key&apos;s {limitLabel(provider.allowance)} —{' '}
                        {spendLabel(spend, provider.allowance)}
                        {fraction === null ? '' : ` · ${Math.round(fraction * 100)}%`}
                      </Hint>
                      <button
                        type="button"
                        className="text-ink-400 hover:text-ink-200 text-[11.5px] underline decoration-dotted underline-offset-2"
                        onClick={() =>
                          patchModel({
                            allowance: {
                              period: provider.allowance!.period,
                              usd: provider.allowance!.usd,
                              tokens: provider.allowance!.tokens
                            }
                          })
                        }
                      >
                        give it its own
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <RowInput
                        mono
                        width="w-[92px]"
                        placeholder="tokens"
                        value={model.allowance?.tokens !== undefined ? String(model.allowance.tokens) : ''}
                        onChange={(value) => {
                          const parsed = Number(value.replace(/\D/g, ''))
                          patchModel({
                            allowance: {
                              ...model.allowance,
                              period: model.allowance?.period ?? 'month',
                              tokens: parsed || undefined
                            }
                          })
                        }}
                      />
                      <Hint>or</Hint>
                      <RowInput
                        mono
                        width="w-[76px]"
                        placeholder="$"
                        value={model.allowance?.usd !== undefined ? String(model.allowance.usd) : ''}
                        onChange={(value) =>
                          patchModel({
                            allowance: {
                              ...model.allowance,
                              period: model.allowance?.period ?? 'month',
                              usd: money(value)
                            }
                          })
                        }
                      />
                      <RowSelect
                        value={model.allowance?.period ?? 'month'}
                        onChange={(event) =>
                          patchModel({
                            allowance: {
                              ...model.allowance,
                              period: event.target.value as 'day' | 'month'
                            }
                          })
                        }
                        options={[
                          { value: 'month', label: 'per month' },
                          { value: 'day', label: 'per day' }
                        ]}
                      />
                      <Hint tone={(fraction ?? 0) >= 0.9 ? 'warn' : 'muted'}>
                        {model.allowance
                          ? `its own — ${spendLabel(spend, model.allowance)}`
                          : 'no limit set'}
                        {fraction === null ? '' : ` · ${Math.round(fraction * 100)}%`}
                      </Hint>
                      {provider.allowance && model.allowance ? (
                        <button
                          type="button"
                          className="text-ink-400 hover:text-ink-200 text-[11.5px] underline decoration-dotted underline-offset-2"
                          onClick={() => patchModel({ allowance: undefined })}
                        >
                          share the key&apos;s instead
                        </button>
                      ) : null}
                    </div>
                  )
                ) : null}

                <div className="ml-auto flex flex-wrap items-center gap-x-3 gap-y-2">
                  <RowSlider
                    title="What this model costs relative to the others. A flat rate or an unspent allowance is treated as the cheapest whatever this says, because the next token really is free."
                    low="cheap"
                    high="dear"
                    value={costTier(model)}
                    onChange={(cost) => patchModel({ cost })}
                  />
                  <RowSlider
                    title="How capable this model is — the IQ the router weighs against cost. Reading and boilerplate go to the cheapest model that clears the bar; a plan goes to the best there is."
                    low="modest"
                    high="strong"
                    value={capability(model)}
                    onChange={(iq) => patchModel({ iq })}
                  />
                </div>
              </div>
            </div>
          )
        })
      )}
    </>
  )
}

export function ModelsTab(): ReactNode {
  const refreshSecrets = useStore((s) => s.refreshSecrets)
  const { draft, setDraft, saved, error, setError } = useConfigDraft()
  const { spentFor } = useSpend(draft)
  const [selected, setSelected] = useState<string>('')

  /**
   * A provider being created. It lives here rather than in the config until it
   * has an id, because the id is the key: committing on every keystroke would
   * create "h", "he", "hel" and delete each one again.
   */
  const [creating, setCreating] = useState<ProviderConfig | null>(null)
  const [newId, setNewId] = useState('')

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

  /**
   * Starting a new provider is one choice: which provider.
   *
   * It used to be three things the app already knew — an id to invent, an npm
   * package to recognise, and then every model id, context window and price
   * typed off a pricing page. Picking Anthropic now fills all of that in; the
   * ones whose line-ups move too fast to ship arrive from the key instead.
   */
  const startFrom = (preset: (typeof PRESETS)[number]): void => {
    setCreating({
      id: preset.id,
      name: preset.label.split(' · ')[0],
      npm: preset.npm,
      options: { ...(preset.baseURL ? { baseURL: preset.baseURL } : {}), apiKey: '' },
      models: preset.models ? { ...preset.models } : {}
    })
    setNewId(preset.id)
    setError(null)
  }

  const startNew = (): void => startFrom(PRESETS[0])

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
        title="Providers"
        description="A provider is a key and the models it can reach. Everything about the one you pick is directly below; what the app does with them is under Routing."
        action={
          error ? <Hint tone="bad">{error}</Hint> : saved ? <Hint tone="ok">Saved</Hint> : null
        }
      >
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
              placeholder={creating.id || 'helmcode'}
              onChange={setNewId}
            />
            <IconButton title="Create" tone="accent" disabled={!newId.trim()} onClick={commitNew}>
              <Check className="h-4 w-4" />
            </IconButton>
          </Row>
          <Row
            label="Which provider"
            description={
              creating.models && Object.keys(creating.models).length > 0
                ? `${Object.keys(creating.models).length} models come with it, priced as the provider publishes them. Paste the key afterwards.`
                : 'Its models are asked of the key once you have stored it — prices are typed once, from the page they are published on.'
            }
          >
            <RowSelect
              value={creating.npm}
              onChange={(event) => {
                const preset = PRESETS.find((p) => p.npm === event.target.value) ?? PRESETS[0]
                startFrom(preset)
              }}
              options={PRESETS.map((preset) => ({ value: preset.npm, label: preset.label }))}
            />
          </Row>
        </Section>
      ) : current ? (
        <Section title={current.name || current.id}>
          <ProviderSection
            provider={current}
            spentFor={spentFor}
            keySpend={
              current.allowance
                ? {
                    allowance: current.allowance,
                    // Every model under the key, added up: that is what a limit
                    // on the key is spent by.
                    spent: Object.keys(current.models).reduce<Spent>(
                      (total, modelId) => {
                        const part = spentFor(`${current.id}/${modelId}`)
                        return {
                          tokens: total.tokens + part.tokens,
                          cost: (total.cost ?? 0) + (part.cost ?? 0)
                        }
                      },
                      { tokens: 0, cost: 0 }
                    )
                  }
                : null
            }
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

      <LocalModelSection />
    </>
  )
}
