import type { AppConfig } from './types'

/**
 * What a turn cost, from the price declared on the model.
 *
 * Returns null when the price is unknown, which is different from zero and has
 * to stay different: a model with no price should show nothing, not "$0.00".
 * A guessed price is worse than no price at all, so nothing here has defaults.
 */
export function costOf(
  config: AppConfig,
  modelRef: string,
  usage: { input: number; output: number }
): number | null {
  const slash = modelRef.indexOf('/')
  if (slash === -1) return null
  const provider = config.provider[modelRef.slice(0, slash)]
  const price = provider?.models[modelRef.slice(slash + 1)]?.price
  if (!price || (price.input === undefined && price.output === undefined)) return null

  const input = ((price.input ?? 0) * usage.input) / 1_000_000
  const output = ((price.output ?? 0) * usage.output) / 1_000_000
  return input + output
}

/**
 * Money, at the precision it is worth reading.
 *
 * A turn often costs a fraction of a cent, and rounding that to two decimals
 * would print "$0.00" for everything — which reads as free. Small amounts keep
 * enough figures to be a number.
 */
export function formatCost(amount: number, currency = '$'): string {
  if (amount === 0) return `${currency}0`
  if (amount < 0.01) return `${currency}${amount.toFixed(4)}`
  if (amount < 1) return `${currency}${amount.toFixed(3)}`
  return `${currency}${amount.toFixed(2)}`
}
