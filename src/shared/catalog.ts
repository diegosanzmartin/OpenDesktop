import type { ProviderModelConfig } from './types'

/**
 * The providers this app knows how to talk to, and what it knows about them.
 *
 * Adding a provider used to mean knowing three things the app already knew:
 * which SDK package talks to it, what its models are called, and what they
 * cost. So "add a provider" was: invent an id, pick a package from a list of npm
 * names, then type three model ids, three context windows and six prices off a
 * pricing page. The catalogue is here so that is one choice instead.
 *
 * Prices are in whole currency units per million tokens, exactly as the
 * provider publishes them, and they are only ever filled in for a model we have
 * a published price for. An unknown price stays unknown: the app shows nothing
 * rather than zero, because zero reads as free.
 */
export interface ProviderPreset {
  /** The id a new provider gets, and the prefix of its model refs. */
  id: string
  label: string
  /** What the key is, in the provider's own words, for the key field's hint. */
  keyName: string
  npm: string
  /** Endpoints that are not one company's own API need to be told where to go. */
  needsBaseURL?: boolean
  baseURL?: string
  /**
   * Whether this app can ask the provider what models the key can see. Prices
   * never come back from one of those endpoints — nobody publishes them there —
   * so what is discovered is ids, names and context windows.
   */
  discoverable?: boolean
  /** Starter models, where their prices are published and stable enough to ship. */
  models?: Record<string, ProviderModelConfig>
}

/**
 * Anthropic's own models, from its pricing page (checked 2026-06-24). Context windows
 * and the output cap come from the same place; `iq` and `cost` are this app's
 * own relative judgements and are meant to be adjusted.
 */
const ANTHROPIC_MODELS: Record<string, ProviderModelConfig> = {
  'claude-opus-5': {
    id: 'claude-opus-5',
    name: 'Claude Opus 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    toolCall: true,
    vision: true,
    price: { input: 5, output: 25 },
    iq: 5,
    cost: 4
  },
  'claude-sonnet-5': {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    contextWindow: 1_000_000,
    maxOutputTokens: 128_000,
    reasoning: true,
    toolCall: true,
    vision: true,
    price: { input: 2, output: 10 },
    iq: 4,
    cost: 3
  },
  'claude-haiku-4-5': {
    id: 'claude-haiku-4-5',
    name: 'Claude Haiku 4.5',
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    toolCall: true,
    vision: true,
    price: { input: 1, output: 5 },
    iq: 3,
    cost: 2
  }
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'anthropic',
    label: 'Anthropic · Claude',
    keyName: 'Anthropic API key',
    npm: '@ai-sdk/anthropic',
    discoverable: true,
    models: ANTHROPIC_MODELS
  },
  {
    /*
     * No starter models for the rest on purpose.
     *
     * Their line-ups and prices move faster than this file can be trusted to,
     * and a wrong price is worse than no price — it goes straight into the
     * router's judgement and into what the app tells you a turn cost. The
     * models come from the key instead, and the prices are typed once from the
     * page they are published on.
     */
    id: 'openai',
    label: 'OpenAI · ChatGPT models',
    keyName: 'OpenAI API key',
    npm: '@ai-sdk/openai',
    discoverable: true
  },
  {
    id: 'google',
    label: 'Google · Gemini',
    keyName: 'Google AI Studio key',
    npm: '@ai-sdk/google',
    discoverable: true
  },
  {
    id: 'endpoint',
    label: 'OpenAI-compatible endpoint',
    keyName: 'API key',
    npm: '@ai-sdk/openai-compatible',
    needsBaseURL: true,
    baseURL: 'https://',
    discoverable: true
  }
]

export function presetFor(npm: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((preset) => preset.npm === npm)
}

/**
 * What the app already knows about a model id, for filling in a discovered one.
 * Matched across every preset, so a model reached through a gateway is
 * still priced.
 */
export function knownModel(id: string): ProviderModelConfig | undefined {
  for (const preset of PROVIDER_PRESETS) {
    const hit = preset.models?.[id]
    if (hit) return hit
  }
  return undefined
}

export interface DiscoveredModel {
  id: string
  name?: string
  contextWindow?: number
  maxOutputTokens?: number
}

/**
 * Merges what the provider says it has into what is already configured.
 *
 * What is configured wins: a price typed by hand, a capability marked, a slider
 * moved — none of that may be overwritten by a list of ids. A model the
 * provider no longer lists is left alone too, since a key losing access to a
 * model is not a reason to throw away what was known about it.
 */
export function mergeDiscovered(
  existing: Record<string, ProviderModelConfig>,
  found: DiscoveredModel[]
): { models: Record<string, ProviderModelConfig>; added: string[]; priced: string[] } {
  const models = { ...existing }
  const added: string[] = []
  const priced: string[] = []

  for (const model of found) {
    if (!model.id) continue
    const known = knownModel(model.id)
    const before = models[model.id]
    if (before) {
      models[model.id] = {
        ...before,
        name: before.name || model.name || model.id,
        contextWindow: before.contextWindow ?? model.contextWindow ?? known?.contextWindow,
        maxOutputTokens: before.maxOutputTokens ?? model.maxOutputTokens ?? known?.maxOutputTokens,
        price: before.price ?? known?.price
      }
      if (!before.price && known?.price) priced.push(model.id)
      continue
    }
    models[model.id] = {
      ...(known ?? {}),
      id: model.id,
      name: known?.name ?? model.name ?? model.id,
      contextWindow: known?.contextWindow ?? model.contextWindow,
      maxOutputTokens: known?.maxOutputTokens ?? model.maxOutputTokens
    }
    added.push(model.id)
    if (known?.price) priced.push(model.id)
  }

  return { models, added, priced }
}
