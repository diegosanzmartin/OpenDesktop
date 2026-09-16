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
import type { AppConfig } from '@shared/types'
import { DATA_DIR } from './config'

interface Row {
  /** The day and month these counts belong to, so they reset by themselves. */
  day: string
  dayTokens: number
  month: string
  monthTokens: number
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

/** Counts tokens against a model. Input and output together: an allowance rarely splits them. */
export function record(ref: string, usage: { input: number; output: number }): void {
  load()
  const total = (usage.input ?? 0) + (usage.output ?? 0)
  if (total <= 0) return
  const { day, month } = today()
  const row = rows.get(ref) ?? { day, dayTokens: 0, month, monthTokens: 0 }
  if (row.day !== day) {
    row.day = day
    row.dayTokens = 0
  }
  if (row.month !== month) {
    row.month = month
    row.monthTokens = 0
  }
  row.dayTokens += total
  row.monthTokens += total
  rows.set(ref, row)
  flushSoon()
}

/** What has gone through this model in the period that has not reset yet. */
export function spentOn(ref: string, period: 'day' | 'month'): { tokens: number } {
  load()
  const row = rows.get(ref)
  if (!row) return { tokens: 0 }
  const { day, month } = today()
  if (period === 'day') return { tokens: row.day === day ? row.dayTokens : 0 }
  return { tokens: row.month === month ? row.monthTokens : 0 }
}

/**
 * The lookup the router wants: for each model, what has been spent in the
 * period *that model's* allowance resets on.
 */
export function spentLookup(config: AppConfig): (ref: string) => { tokens: number } | null {
  const periods = new Map<string, 'day' | 'month'>()
  for (const provider of Object.values(config.provider ?? {})) {
    for (const model of Object.values(provider.models ?? {})) {
      periods.set(`${provider.id}/${model.id}`, model.allowance?.period ?? 'month')
    }
  }
  return (ref) => spentOn(ref, periods.get(ref) ?? 'month')
}

/** Every model that has been used, for the settings page. */
export function meterSnapshot(): Record<string, { day: number; month: number }> {
  load()
  const { day, month } = today()
  const out: Record<string, { day: number; month: number }> = {}
  for (const [ref, row] of rows) {
    out[ref] = {
      day: row.day === day ? row.dayTokens : 0,
      month: row.month === month ? row.monthTokens : 0
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
