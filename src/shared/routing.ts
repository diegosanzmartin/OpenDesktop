/**
 * Which model does which job.
 *
 * Two numbers per model, both set by hand because nothing else can know them:
 * how expensive it is relative to the others, and how capable it is. Then one
 * rule — send the work to the cheapest model that can do it, and the thinking
 * to the best one available — so that a session can use a strong model for the
 * part that needs one and stop paying for it on the part that does not.
 *
 * The numbers are deliberately coarse. A five-step slider is a judgement, and
 * a judgement is what this is: nobody can say a model is 0.72 as capable as
 * another, and pretending to would make the routing look more principled than
 * it is.
 */
import type { AppConfig, ProviderModelConfig } from './types'

export type Billing = 'pay-as-you-go' | 'flat' | 'allowance'

export const BILLINGS: { id: Billing; label: string; blurb: string }[] = [
  {
    id: 'pay-as-you-go',
    label: 'Pay as you go',
    blurb: 'Charged per token, at the prices above. The default, and the only one that is priced.'
  },
  {
    id: 'flat',
    label: 'Flat rate',
    blurb:
      'A subscription: the next token costs nothing, so work is routed here first when it is capable enough.'
  },
  {
    id: 'allowance',
    label: 'Included allowance',
    blurb:
      'A quota that resets. Free until it runs out, and counted here from what this app has spent — no provider reports it back.'
  }
]

export const TIERS = [1, 2, 3, 4, 5] as const
export const CHEAPEST = 1
export const DEAREST = 5

/** How expensive this model is, on the slider's terms. */
export function costTier(model: ProviderModelConfig): number {
  if (model.cost !== undefined) return clamp(model.cost)
  // Nothing set: read it off the price, so a config written before the slider
  // existed still routes sensibly. The bands are dollars per million input
  // tokens, which is how every provider publishes it.
  const price = model.price?.input
  if (price === undefined) return 3
  if (price <= 0.3) return 1
  if (price <= 1.5) return 2
  if (price <= 5) return 3
  if (price <= 15) return 4
  return 5
}

/** How capable this model is, on the slider's terms. Unset is the middle. */
export function capability(model: ProviderModelConfig): number {
  return clamp(model.iq ?? 3)
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 3
  return Math.min(DEAREST, Math.max(CHEAPEST, Math.round(value)))
}

/**
 * What the next token really costs, which is not always what it is priced at.
 *
 * A flat-rate model is paid for whether it is used or not, so at the margin it
 * is the cheapest thing available — which is the whole reason for saying so in
 * the settings. An allowance behaves the same way until it runs out and like
 * its own price afterwards.
 */
export function marginalCost(
  model: ProviderModelConfig,
  spent?: { tokens: number } | null
): number {
  const billing = model.billing ?? 'pay-as-you-go'
  if (billing === 'flat') return CHEAPEST
  if (billing === 'allowance') {
    const included = model.allowance?.tokens
    if (!included) return CHEAPEST
    const used = spent?.tokens ?? 0
    if (used >= included) return costTier(model)
    // Near the end of the allowance it stops being free: past nine tenths the
    // next token is likely to be the one that is charged.
    return used > included * 0.9 ? Math.max(CHEAPEST, costTier(model) - 1) : CHEAPEST
  }
  return costTier(model)
}

export interface Candidate {
  ref: string
  label: string
  model: ProviderModelConfig
  cost: number
  iq: number
}

/** Every `provider/model` the config declares, with its two numbers resolved. */
export function candidates(
  config: AppConfig,
  spent?: (ref: string) => { tokens: number } | null
): Candidate[] {
  const out: Candidate[] = []
  for (const provider of Object.values(config.provider ?? {})) {
    for (const model of Object.values(provider.models ?? {})) {
      const ref = `${provider.id}/${model.id}`
      out.push({
        ref,
        label: model.name || model.id,
        model,
        cost: marginalCost(model, spent?.(ref)),
        iq: capability(model)
      })
    }
  }
  // A stable order, so a tie resolves the same way every time and the choice
  // does not move around between turns for no reason anyone can see.
  return out.sort((a, b) => a.ref.localeCompare(b.ref))
}

export type Purpose =
  /** Reading files, summarising, boilerplate: cheap, and capable enough. */
  | 'delegate'
  /** Working out how to do something hard: the best there is. */
  | 'plan'

export interface Choice {
  ref: string
  label: string
  /** One line for the UI and the block: why this one. */
  why: string
}

/**
 * The model for a job, or null when the config declares none.
 *
 * `delegate` takes the cheapest model that clears a capability floor — a model
 * too weak to read a file accurately saves nothing, it just moves the error.
 * The floor is 2 when anything meets it, so a config of one model still works.
 * `plan` takes the most capable, and among equals the cheapest.
 */
export function pickModel(
  config: AppConfig,
  purpose: Purpose,
  options?: { exclude?: string[]; spent?: (ref: string) => { tokens: number } | null }
): Choice | null {
  const pool = candidates(config, options?.spent).filter(
    (candidate) => !(options?.exclude ?? []).includes(candidate.ref)
  )
  if (pool.length === 0) return null

  if (purpose === 'plan') {
    const best = pool.reduce((a, b) => (b.iq > a.iq || (b.iq === a.iq && b.cost < a.cost) ? b : a))
    return {
      ref: best.ref,
      label: best.label,
      why: `the most capable model declared (${best.iq}/5)`
    }
  }

  const floor = pool.some((candidate) => candidate.iq >= 2) ? 2 : CHEAPEST
  const able = pool.filter((candidate) => candidate.iq >= floor)
  const cheapest = able.reduce((a, b) => (b.cost < a.cost || (b.cost === a.cost && b.iq > a.iq) ? b : a))
  const billing = cheapest.model.billing ?? 'pay-as-you-go'
  return {
    ref: cheapest.ref,
    label: cheapest.label,
    why:
      billing === 'flat'
        ? 'already paid for, and capable enough'
        : billing === 'allowance'
          ? 'inside its included allowance, and capable enough'
          : `the cheapest model that clears the bar (cost ${cheapest.cost}/5, ${cheapest.iq}/5)`
  }
}

/**
 * Which model shunt delegates reading to: what the user named, or the routed
 * choice, or the session's own — which still keeps the files out of the
 * conversation but is charged at full price.
 */
export function workerModelRef(
  config: AppConfig,
  sessionModel: string,
  spent?: (ref: string) => { tokens: number } | null
): string {
  // Named for the job, then the app's existing "something cheap for work that
  // is not the work", then the router. A choice someone made by hand outranks
  // one this file inferred, whichever order they were added in.
  if (config.shuntModel) return config.shuntModel
  if (config.smallModel) return config.smallModel
  return pickModel(config, 'delegate', { spent })?.ref ?? sessionModel
}

/** Which model is asked how to do something hard. */
export function plannerModelRef(
  config: AppConfig,
  sessionModel: string,
  spent?: (ref: string) => { tokens: number } | null
): string {
  if (config.plannerModel) return config.plannerModel
  return pickModel(config, 'plan', { spent })?.ref ?? sessionModel
}

/** True when delegating would land on the session's own model, saving nothing on price. */
export function workerIsTheSameModel(
  config: AppConfig,
  sessionModel: string,
  spent?: (ref: string) => { tokens: number } | null
): boolean {
  return workerModelRef(config, sessionModel, spent) === sessionModel
}
