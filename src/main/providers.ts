import { createOpenAICompatible } from '@ai-sdk/openai-compatible'
import { createOpenAI } from '@ai-sdk/openai'
import { createAnthropic } from '@ai-sdk/anthropic'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { LanguageModel } from 'ai'
import type { AppConfig } from '@shared/types'

export interface ResolvedModel {
  providerId: string
  modelId: string
  label: string
  model: LanguageModel
  contextWindow?: number
}

type Factory = (options: Record<string, unknown>) => (modelId: string) => LanguageModel

/**
 * The AI SDK packages we ship with. A config can name any of these in `npm`;
 * anything else is loaded dynamically and must be installed alongside the app.
 */
const FACTORIES: Record<string, Factory> = {
  '@ai-sdk/openai-compatible': (options) =>
    createOpenAICompatible({ name: 'compat', ...options } as never) as unknown as (
      id: string
    ) => LanguageModel,
  '@ai-sdk/openai': (options) => createOpenAI(options as never) as unknown as (id: string) => LanguageModel,
  '@ai-sdk/anthropic': (options) =>
    createAnthropic(options as never) as unknown as (id: string) => LanguageModel,
  '@ai-sdk/google': (options) =>
    createGoogleGenerativeAI(options as never) as unknown as (id: string) => LanguageModel
}

const cache = new Map<string, (modelId: string) => LanguageModel>()

let overrideResolver: ((ref: string) => ResolvedModel | null) | null = null

/**
 * Test seam: lets the headless smoke test substitute a mock model without a
 * provider or a network call. Never set in normal operation.
 */
export function setModelResolverOverride(fn: ((ref: string) => ResolvedModel | null) | null): void {
  overrideResolver = fn
}

async function providerFor(
  config: AppConfig,
  providerId: string
): Promise<(modelId: string) => LanguageModel> {
  const provider = config.provider[providerId]
  if (!provider) {
    throw new Error(
      `Provider "${providerId}" is not configured. Add it under "provider" in the Settings tab.`
    )
  }

  const key = `${providerId}:${JSON.stringify(provider.options)}:${provider.npm}`
  const cached = cache.get(key)
  if (cached) return cached

  const options: Record<string, unknown> = { ...provider.options }
  if (provider.npm === '@ai-sdk/openai-compatible') options.name = provider.id

  let factory = FACTORIES[provider.npm]
  if (!factory) {
    const mod = (await import(/* @vite-ignore */ provider.npm)) as Record<string, unknown>
    const create = Object.entries(mod).find(
      ([name, value]) => name.startsWith('create') && typeof value === 'function'
    )?.[1] as Factory | undefined
    if (!create) throw new Error(`Package "${provider.npm}" exports no create* factory.`)
    factory = create
  }

  const instance = factory(options)
  cache.set(key, instance)
  return instance
}

/** Parses `provider/model` — model ids may themselves contain slashes. */
export function parseModelRef(ref: string): { providerId: string; modelId: string } {
  const slash = ref.indexOf('/')
  if (slash === -1) throw new Error(`Model "${ref}" must be written as "provider/model".`)
  return { providerId: ref.slice(0, slash), modelId: ref.slice(slash + 1) }
}

export async function resolveModel(config: AppConfig, ref: string): Promise<ResolvedModel> {
  const overridden = overrideResolver?.(ref)
  if (overridden) return overridden

  const { providerId, modelId } = parseModelRef(ref)
  const provider = await providerFor(config, providerId)
  const declared = config.provider[providerId]?.models[modelId]
  const apiKey = config.provider[providerId]?.options.apiKey

  if (!apiKey && config.provider[providerId]?.npm !== '@ai-sdk/openai-compatible') {
    // Other providers read their own env vars; only warn for compat providers below.
  }
  if (!apiKey && config.provider[providerId]?.npm === '@ai-sdk/openai-compatible') {
    throw new Error(
      `No API key resolved for provider "${providerId}". Its apiKey is "${
        (config.provider[providerId]?.options.apiKey as string) ?? ''
      }" — make sure that environment variable is exported where OpenDesktop runs.`
    )
  }

  return {
    providerId,
    modelId,
    label: declared?.name ?? modelId,
    model: provider(modelId),
    contextWindow: declared?.contextWindow
  }
}

export function invalidateProviderCache(): void {
  cache.clear()
}

/** Every `provider/model` pair the config declares, for the model picker. */
export function listModels(config: AppConfig): { ref: string; label: string; provider: string }[] {
  const out: { ref: string; label: string; provider: string }[] = []
  for (const provider of Object.values(config.provider)) {
    for (const model of Object.values(provider.models)) {
      out.push({ ref: `${provider.id}/${model.id}`, label: model.name, provider: provider.name })
    }
  }
  return out
}
