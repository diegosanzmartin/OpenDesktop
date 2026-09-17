/**
 * What has been spent on each model, so an allowance can be counted.
 *
 * No provider tells us how much of a monthly quota is left — the OpenAI-shaped
 * endpoints have nowhere to say it, and the ones that do all say it
 * differently. But every token this app spends passes through here, so the
 * honest version of "how much is left" is "how much have *we* used", counted
 * locally and labelled as such. It is a floor, not a balance: anything spent
 * from another client or another machine is invisible to it.
 *
 * Kept beside the sessions rather than in the config: it is a record of what
 * happened, not a setting, and a config that rewrote itself on every turn
 * would be unpleasant to keep in version control.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig, MeterEntry } from '@shared/types'
import { allowanceFor, type Spent } from '@shared/routing'
import { DATA_DIR } from './config'

interface Row {
  /** The day and month these counts belong to, so they reset by themselves. */
  day: string
  dayTokens: number
  month: string
  monthTokens: number
  /*
   * And what those tokens came to in money, where the model is priced.
   *
   * Tokens alone cannot be compared with the limit that matters on a paid key:
   * $400 a month is a budget, and the same number of tokens is worth ten times
   * as much on one model as on another. Absent on rows written before this,
   * which is why both are read with a default rather than assumed present.
   */
  dayCost?: number
  monthCost?: number
}

const rows = new Map<string, Row>()
let loaded = false
let flushTimer: NodeJS.Timeout | null = null

const FILE = (): string => join(DATA_DIR, 'meter.json')

function today(): { day: string; month: string } {
  const now = new Date().toISOString()
  return { day: now.slice(0, 10), month: now.slice(0, 7) }
}

function load(): void {
  if (loaded) return
  loaded = true
  try {
    if (!existsSync(FILE())) return
    const parsed = JSON.parse(readFileSync(FILE(), 'utf8')) as Record<string, Row>
    for (const [ref, row] of Object.entries(parsed)) rows.set(ref, row)
  } catch {
    // A meter that cannot be read starts again from zero. It is a count of
    // tokens, not an accounting record, and losing it costs nothing that
    // matters.
  }
}

function flushSoon(): void {
  if (flushTimer) return
  flushTimer = setTimeout(() => {
    flushTimer = null
    flush()
  }, 1000)
}

export function flush(): void {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    writeFileSync(FILE(), JSON.stringify(Object.fromEntries(rows), null, 2), 'utf8')
  } catch {
    // Nothing to do about it, and nothing depends on it having worked.
  }
}

/**
 * Counts what went through a model. Input and output together: an allowance
 * rarely splits them. The cost is counted beside them when the model is priced,
 * since that is what a money limit is measured in.
 */
export function record(ref: string, usage: { input: number; output: number; cost?: number }): void {
  load()
  const total = (usage.input ?? 0) + (usage.output ?? 0)
  const cost = usage.cost ?? 0
  if (total <= 0 && cost <= 0) return
  const { day, month } = today()
  const row = rows.get(ref) ?? { day, dayTokens: 0, month, monthTokens: 0, dayCost: 0, monthCost: 0 }
  if (row.day !== day) {
    row.day = day
    row.dayTokens = 0
    row.dayCost = 0
  }
  if (row.month !== month) {
    row.month = month
    row.monthTokens = 0
    row.monthCost = 0
  }
  row.dayTokens += total
  row.monthTokens += total
  row.dayCost = (row.dayCost ?? 0) + cost
  row.monthCost = (row.monthCost ?? 0) + cost
  rows.set(ref, row)
  flushSoon()
}

/** What has gone through this model in the period that has not reset yet. */
export function spentOn(ref: string, period: 'day' | 'month'): Spent {
  load()
  const row = rows.get(ref)
  if (!row) return { tokens: 0, cost: 0 }
  const { day, month } = today()
  if (period === 'day') {
    return row.day === day ? { tokens: row.dayTokens, cost: row.dayCost ?? 0 } : { tokens: 0, cost: 0 }
  }
  return row.month === month
    ? { tokens: row.monthTokens, cost: row.monthCost ?? 0 }
    : { tokens: 0, cost: 0 }
}

/**
 * The same for a whole provider — every model under one key added up, which is
 * what a limit on the key is measured against.
 */
export function spentOnProvider(providerId: string, period: 'day' | 'month'): Spent {
  load()
  const total: Spent = { tokens: 0, cost: 0 }
  for (const ref of rows.keys()) {
    if (!ref.startsWith(`${providerId}/`)) continue
    const part = spentOn(ref, period)
    total.tokens += part.tokens
    total.cost = (total.cost ?? 0) + (part.cost ?? 0)
  }
  return total
}

/**
 * The lookup the router wants: for each model, what has been spent in the
 * period *that model's* allowance resets on.
 */
export function spentLookup(config: AppConfig): (ref: string) => Spent | null {
  const scopes = new Map<string, { period: 'day' | 'month'; providerId: string; whole: boolean }>()
  for (const provider of Object.values(config.provider ?? {})) {
    for (const model of Object.values(provider.models ?? {})) {
      const allowance = allowanceFor(config, provider.id, model)
      scopes.set(`${provider.id}/${model.id}`, {
        period: allowance?.period ?? 'month',
        providerId: provider.id,
        // A limit on the key is spent by every model under it, so that is what
        // has to be added up — counting one model's spend against a shared cap
        // would report a key as untouched while it was being emptied elsewhere.
        whole: model.allowance === undefined && provider.allowance !== undefined
      })
    }
  }
  return (ref) => {
    const scope = scopes.get(ref)
    if (!scope) return spentOn(ref, 'month')
    return scope.whole
      ? spentOnProvider(scope.providerId, scope.period)
      : spentOn(ref, scope.period)
  }
}

/** Every model that has been used, for the settings page. */
export function meterSnapshot(): Record<string, MeterEntry> {
  load()
  const { day, month } = today()
  const out: Record<string, MeterEntry> = {}
  for (const [ref, row] of rows) {
    out[ref] = {
      day: row.day === day ? row.dayTokens : 0,
      month: row.month === month ? row.monthTokens : 0,
      dayCost: row.day === day ? (row.dayCost ?? 0) : 0,
      monthCost: row.month === month ? (row.monthCost ?? 0) : 0
    }
  }
  return out
}

/** For tests, and for a user who wants the count to start again. */
export function resetMeter(): void {
  rows.clear()
  loaded = true
  flush()
}
