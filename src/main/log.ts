/**
 * A log file, because the alternative was archaeology.
 *
 * When two agents failed mid-turn, everything about it was gone the moment the
 * toast was dismissed: no file, no console anyone was watching, and a
 * transcript holding only the wrapper message. Reconstructing what happened
 * meant reading session JSON by hand and reasoning from timestamps.
 *
 * So: one file, appended to, rotated once at 2MB, holding the things a person
 * cannot reconstruct afterwards — failures, with their whole cause chain, and
 * the turn they belong to. Not a trace of everything the app does; a record of
 * what went wrong.
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describeError, scrubSecrets } from '@shared/errors'
import { DATA_DIR } from './config'

const MAX_BYTES = 2_000_000

export function logPath(): string {
  return join(DATA_DIR, 'opendesktop.log')
}

function rotateIfNeeded(path: string): void {
  try {
    if (!existsSync(path) || statSync(path).size < MAX_BYTES) return
    renameSync(path, `${path}.1`)
  } catch {
    /* a log that cannot be rotated is still a log */
  }
}

export function logLine(level: 'info' | 'warn' | 'error', text: string): void {
  const path = logPath()
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    rotateIfNeeded(path)
    appendFileSync(path, `${new Date().toISOString()} ${level.padEnd(5)} ${scrubSecrets(text)}\n`)
  } catch {
    // Nothing sensible to do: the log is a convenience, and failing to write it
    // must never become the error the user sees instead of the real one.
  }
}

/**
 * Records a failure and hands back the same description it wrote, so the
 * caller can put exactly what is in the log in front of the user.
 */
export function logError(where: string, error: unknown): string {
  const described = describeError(error)
  logLine('error', `${where}: ${described}`)
  // The stack is worth having in the file and not in the interface.
  const stack = (error as { stack?: unknown })?.stack
  if (typeof stack === 'string') logLine('error', `${where}: ${stack.split('\n').slice(0, 12).join(' | ')}`)
  return described
}
