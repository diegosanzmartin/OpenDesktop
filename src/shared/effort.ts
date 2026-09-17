import type { ProviderModelConfig } from './types'

/**
 * How hard to try, as one dial.
 *
 * Every AI client has grown one of these, and they all mean roughly "spend more
 * for a better answer". What it must not mean is a hidden second model picker:
 * the model is chosen in the model picker, and a slider that silently swapped
 * it would make the label above it a lie. So it moves the two things that
 * belong to *this* turn of *this* model — how much it may think, and how many
 * steps it gets — and the interface says which of the two is actually in force,
 * because a model with no reasoning setting can only be given the second.
 */
export interface EffortLevel {
  value: number
  label: string
  /**
   * What to ask a reasoning model for. `off` is a model told not to think at
   * all, which some support and most ignore.
   */
  reasoning: 'off' | 'minimal' | 'low' | 'medium' | 'high'
  /**
   * The thinking budget in tokens, for providers that take a number rather than
   * a word. Absent at the bottom of the scale, where thinking is off.
   */
  budgetTokens?: number
  /** Share of the configured step ceiling this level allows. */
  steps: number
}

export const EFFORT_LEVELS: EffortLevel[] = [
  { value: 1, label: 'Minimal', reasoning: 'off', steps: 0.25 },
  { value: 2, label: 'Low', reasoning: 'low', budgetTokens: 2_048, steps: 0.5 },
  { value: 3, label: 'Medium', reasoning: 'medium', budgetTokens: 8_192, steps: 1 },
  { value: 4, label: 'High', reasoning: 'high', budgetTokens: 16_384, steps: 1 },
  { value: 5, label: 'Max', reasoning: 'high', budgetTokens: 32_768, steps: 1 }
]

export const DEFAULT_EFFORT = 3

export function effortLevel(value: number | undefined): EffortLevel {
  return EFFORT_LEVELS.find((level) => level.value === (value ?? DEFAULT_EFFORT)) ?? EFFORT_LEVELS[2]
}

/**
 * Whether this model has anything to think with.
 *
 * Declared, not guessed: `reasoning` is a field on the model, set from the
 * catalogue or by hand, and a provider that is sent a setting it does not
 * understand is a request that might fail. So the dial only reaches the models
 * that say they have one, and says so plainly about the rest.
 */
export function canReason(model: ProviderModelConfig | undefined): boolean {
  return model?.reasoning === true
}

/**
 * The provider-specific shape for a reasoning setting.
 *
 * Each SDK package spells this differently and there is no common option, so
 * the mapping lives here in one place. Returns nothing when there is nothing to
 * say, which is the usual case.
 */
export type ReasoningOptions = Record<string, Record<string, import('ai').JSONValue>>

export function reasoningOptions(
  npm: string,
  providerId: string,
  level: EffortLevel
): ReasoningOptions | undefined {
  if (npm === '@ai-sdk/anthropic') {
    // Anthropic takes a budget and refuses one below 1024, and a thinking
    // request must not also set a temperature — the runner handles that.
    return level.budgetTokens
      ? { anthropic: { thinking: { type: 'enabled', budgetTokens: Math.max(1_024, level.budgetTokens) } } }
      : { anthropic: { thinking: { type: 'disabled' } } }
  }
  if (npm === '@ai-sdk/openai') {
    return { openai: { reasoningEffort: level.reasoning === 'off' ? 'minimal' : level.reasoning } }
  }
  if (npm === '@ai-sdk/google') {
    return { google: { thinkingConfig: { thinkingBudget: level.budgetTokens ?? 0 } } }
  }
  if (npm === '@ai-sdk/openai-compatible') {
    /*
     * The OpenAI field, which is what llama.cpp and most gateways read. Sent
     * under the provider's own id because that is how this SDK forwards extra
     * body fields, and only ever for a model that declared it reasons.
     */
    return { [providerId]: { reasoning_effort: level.reasoning === 'off' ? 'none' : level.reasoning } }
  }
  return undefined
}
