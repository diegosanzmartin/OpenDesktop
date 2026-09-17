import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppConfig, MeterEntry } from '@shared/types'
import { allowanceFor, type Allowance, type Spent } from '@shared/routing'
import { formatCost } from '@shared/cost'
import { useStore } from '../state/store'

/**
 * The settings pages edit one document between them.
 *
 * Providers and keys are one page and routing is another, but both are views of
 * `config.json`, so both need the same arrangement: a draft that follows the
 * saved document until it is touched, an autosave a beat after the last
 * keystroke, and the error the save came back with. Keeping that here is what
 * lets the pages be split without either of them fighting the other's writes.
 */
export function useConfigDraft(): {
  draft: AppConfig | null
  setDraft: (next: AppConfig) => void
  dirty: boolean
  saved: boolean
  error: string | null
  setError: (next: string | null) => void
} {
  const config = useStore((s) => s.config)
  const refreshConfig = useStore((s) => s.refreshConfig)

  const [draft, setDraft] = useState<AppConfig | null>(config)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const lastSaved = useRef<string | null>(null)

  useEffect(() => {
    if (!config) return
    // Not while this page is the one that wrote it: the round trip would
    // replace what is being typed with what was typed a moment ago.
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

  return { draft, setDraft, dirty, saved, error, setError }
}

/**
 * What has been spent against each model's allowance.
 *
 * Counted locally — no provider reports a balance back — and against the right
 * thing: a model with its own allowance is judged on its own spend, and one
 * under a limit that belongs to the key is judged on everything that key has
 * spent. In money as well as tokens, since a $400-a-month key is measured in
 * one and not the other.
 */
export function useSpend(draft: AppConfig | null): {
  meter: Record<string, MeterEntry>
  spentFor: (ref: string) => Spent
} {
  const [meter, setMeter] = useState<Record<string, MeterEntry>>({})
  useEffect(() => {
    // An empty object when the answer is missing: a settings page that throws
    // because nothing has been spent yet is a poor trade for one saved line.
    void window.opendesktop.meter.get().then((next) => setMeter(next ?? {}))
  }, [])

  const spentFor = useMemo(() => {
    if (!draft) return () => ({ tokens: 0, cost: 0 })
    return (ref: string): Spent => {
      const slash = ref.indexOf('/')
      const providerId = slash === -1 ? ref : ref.slice(0, slash)
      const provider = draft.provider[providerId]
      const model = provider?.models[ref.slice(slash + 1)]
      const period = (model ? allowanceFor(draft, providerId, model)?.period : undefined) ?? 'month'
      const ownScope = model?.allowance !== undefined || provider?.allowance === undefined
      const pick = (entry?: MeterEntry): Spent =>
        period === 'day'
          ? { tokens: entry?.day ?? 0, cost: entry?.dayCost ?? 0 }
          : { tokens: entry?.month ?? 0, cost: entry?.monthCost ?? 0 }

      if (ownScope) return pick(meter[ref])

      const total: Spent = { tokens: 0, cost: 0 }
      for (const [key, entry] of Object.entries(meter)) {
        if (!key.startsWith(`${providerId}/`)) continue
        const part = pick(entry)
        total.tokens += part.tokens
        total.cost = (total.cost ?? 0) + (part.cost ?? 0)
      }
      return total
    }
  }, [draft, meter])

  return { meter, spentFor }
}

/** Every `provider/model` the document declares, for the pickers. */
export function declaredModels(draft: AppConfig | null): {
  ref: string
  providerId: string
  modelId: string
  label: string
}[] {
  return Object.values(draft?.provider ?? {}).flatMap((provider) =>
    Object.values(provider.models).map((model) => ({
      ref: `${provider.id}/${model.id}`,
      providerId: provider.id,
      modelId: model.id,
      label: `${provider.name} · ${model.name || model.id}`
    }))
  )
}

/**
 * A price as typed. An empty box means unknown, which is not the same as free,
 * so it stays undefined rather than becoming 0.
 */
export function money(value: string): number | undefined {
  const cleaned = value.replace(/[^0-9.]/g, '')
  if (!cleaned) return undefined
  const parsed = Number(cleaned)
  return Number.isFinite(parsed) ? parsed : undefined
}

/** A limit as a sentence: money, tokens, or both when both are set. */
export function limitLabel(allowance: Allowance): string {
  const parts: string[] = []
  if (allowance.usd) parts.push(formatCost(allowance.usd))
  if (allowance.tokens) parts.push(`${allowance.tokens.toLocaleString('en-US')} tokens`)
  return `${parts.join(' / ') || 'no limit'} per ${allowance.period === 'day' ? 'day' : 'month'}`
}

/** What has gone against that limit, in whichever unit the limit is set in. */
export function spendLabel(spent: Spent, allowance: Allowance): string {
  if (allowance.usd) return `${formatCost(spent.cost ?? 0)} of ${formatCost(allowance.usd)} used`
  if (allowance.tokens) {
    return `${spent.tokens.toLocaleString('en-US')} of ${allowance.tokens.toLocaleString('en-US')} used`
  }
  return `${spent.tokens.toLocaleString('en-US')} counted here`
}
