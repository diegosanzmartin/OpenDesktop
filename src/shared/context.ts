import type { AppConfig } from './types'

/**
 * How much of a model's window this session is allowed to fill, and how much of
 * that it has filled.
 *
 * Shared because both sides need the same answer: the runner decides when to
 * summarise, and the interface shows a person why it happened. Two definitions
 * would drift, and a gauge that disagrees with the behaviour it describes is
 * worse than no gauge.
 */

/** Room the rest of the request needs: the system prompt and the tool schemas. */
const OVERHEAD_TOKENS = 4_000

/** Assumed room for the reply when the model does not declare a limit. */
const DEFAULT_REPLY_TOKENS = 8_000

/**
 * Tokens of transcript this model can actually be sent — its declared window
 * less what the reply and the request's own framing need. Without the reserve
 * the budget would be reached at the point the model has no space left to
 * answer.
 *
 * Zero when the window is not declared, which means "unknown": callers fall
 * back to counting characters, and the interface shows nothing rather than a
 * made-up percentage.
 */
export function budgetFor(config: AppConfig, modelRef: string): number {
  const slash = modelRef.indexOf('/')
  if (slash === -1) return 0
  const model = config.provider[modelRef.slice(0, slash)]?.models[modelRef.slice(slash + 1)]
  if (!model?.contextWindow) return 0

  const reply = model.maxOutputTokens ?? DEFAULT_REPLY_TOKENS
  return Math.max(0, model.contextWindow - reply - OVERHEAD_TOKENS)
}

/** The share of the budget in use, or null when either number is unknown. */
export function contextShare(used: number | undefined, budget: number): number | null {
  if (!budget || used === undefined || used <= 0) return null
  return used / budget
}
