import type { AppConfig } from '@shared/types'
import { presetFor, type DiscoveredModel } from '@shared/catalog'
import { describeError } from '@shared/errors'

/**
 * Asks a provider which models this key can see.
 *
 * Typing model ids by hand is how a provider gets added with a typo in it, and
 * a typo only shows up as a failed turn later. Every one of these APIs will
 * list them; none of them will say what they cost, so prices stay a separate,
 * deliberate thing — the catalogue fills in the ones we publish ourselves.
 *
 * Read-only, and it never returns the key or anything derived from it.
 */
const TIMEOUT_MS = 20_000

interface ListResponse {
  data?: { id?: string; display_name?: string; max_input_tokens?: number; max_tokens?: number }[]
  models?: {
    name?: string
    displayName?: string
    inputTokenLimit?: number
    outputTokenLimit?: number
  }[]
}

async function ask(url: string, headers: Record<string, string>): Promise<ListResponse> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      const body = (await res.text()).slice(0, 300)
      throw new Error(
        res.status === 401 || res.status === 403
          ? `the provider refused the key (HTTP ${res.status})`
          : `HTTP ${res.status}: ${body}`
      )
    }
    return (await res.json()) as ListResponse
  } finally {
    clearTimeout(timer)
  }
}

export async function discoverModels(
  config: AppConfig,
  providerId: string
): Promise<{ models: DiscoveredModel[]; error?: string }> {
  const provider = config.provider[providerId]
  if (!provider) return { models: [], error: `no provider "${providerId}"` }

  const key = typeof provider.options.apiKey === 'string' ? provider.options.apiKey : ''
  const preset = presetFor(provider.npm)
  if (!preset?.discoverable) {
    return { models: [], error: `${provider.npm} cannot be asked for a model list` }
  }
  if (!key) {
    return {
      models: [],
      // The most common reason by far, and the fix is one field away.
      error: 'no key resolved for this provider — store one first, then ask again'
    }
  }

  try {
    if (provider.npm === '@ai-sdk/anthropic') {
      const body = await ask('https://api.anthropic.com/v1/models?limit=100', {
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      })
      return {
        models: (body.data ?? []).flatMap((entry) =>
          entry.id
            ? [
                {
                  id: entry.id,
                  name: entry.display_name,
                  contextWindow: entry.max_input_tokens,
                  maxOutputTokens: entry.max_tokens
                }
              ]
            : []
        )
      }
    }

    if (provider.npm === '@ai-sdk/google') {
      const body = await ask(
        `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`,
        {}
      )
      return {
        models: (body.models ?? []).flatMap((entry) => {
          // Google names them "models/gemini-…"; the ref uses the bare id.
          const id = (entry.name ?? '').replace(/^models\//, '')
          return id
            ? [
                {
                  id,
                  name: entry.displayName,
                  contextWindow: entry.inputTokenLimit,
                  maxOutputTokens: entry.outputTokenLimit
                }
              ]
            : []
        })
      }
    }

    // OpenAI, and anything speaking its shape — including a gateway of your own.
    const base = String(provider.options.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '')
    const body = await ask(`${base}/models`, { Authorization: `Bearer ${key}` })
    return {
      models: (body.data ?? []).flatMap((entry) => (entry.id ? [{ id: entry.id }] : []))
    }
  } catch (err) {
    return { models: [], error: describeError(err) }
  }
}
