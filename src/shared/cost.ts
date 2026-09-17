import type { AppConfig } from './types'

/**
 * What a turn cost, from the price declared on the model.
 *
 * Returns null when the price is unknown, which is different from zero and has
 * to stay different: a model with no price should show nothing, not "$0.00".
 * A guessed price is worse than no price at all, so nothing here has defaults.
 */
export interface Usage {
  input: number
  output: number
  /**
   * The part of `input` the provider served from its cache, and the part it
   * charged extra to write there. Both are subsets of `input`, which is the
   * total — that is the shape the AI SDK reports and the shape the providers
   * bill in.
   */
  cacheRead?: number
  cacheWrite?: number
}

/**
 * The usual rates for a cached token, relative to a fresh one: a tenth to read,
 * a quarter more to write. Every provider that caches and publishes prices is
 * within a hair of these, and a provider that caches without saying so is still
 * charging them — so assuming them is far closer to the truth than counting a
 * cache read at full price, which overstates a long turn by most of its bill.
 */
const CACHE_READ_SHARE = 0.1
const CACHE_WRITE_SHARE = 1.25

export function costOf(
  config: AppConfig,
  modelRef: string,
  usage: Usage
): number | null {
  const slash = modelRef.indexOf('/')
  if (slash === -1) return null
  const provider = config.provider[modelRef.slice(0, slash)]
  const price = provider?.models[modelRef.slice(slash + 1)]?.price
  if (!price || (price.input === undefined && price.output === undefined)) return null

  const inRate = price.input ?? 0
  const readRate = price.cacheRead ?? inRate * CACHE_READ_SHARE
  const writeRate = price.cacheWrite ?? inRate * CACHE_WRITE_SHARE

  // What was neither read from the cache nor written to it is ordinary input.
  const cacheRead = Math.min(usage.cacheRead ?? 0, usage.input)
  const cacheWrite = Math.min(usage.cacheWrite ?? 0, Math.max(0, usage.input - cacheRead))
  const fresh = Math.max(0, usage.input - cacheRead - cacheWrite)

  return (
    (fresh * inRate + cacheRead * readRate + cacheWrite * writeRate + usage.output * (price.output ?? 0)) /
    1_000_000
  )
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
