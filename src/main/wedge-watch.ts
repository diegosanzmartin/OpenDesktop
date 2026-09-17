/**
 * The process that notices when the main process stops answering.
 *
 * Runs as a utility process, which is its whole point: a wedge in the main
 * process — a runaway loop, a pathological parse, anything that never yields —
 * takes the window, every session, the terminal and the quit handler with it,
 * and nothing running *inside* that process can report it. A separate one can.
 *
 * It only ever writes to the log. It does not kill the app: a process that has
 * been busy for eight seconds may be finishing something expensive, and
 * deciding that for the user is not a watchdog's job. What it gives is the line
 * that was missing the first time this happened — thirteen minutes of silence
 * with nothing on disk to say so.
 */
import { appendFileSync } from 'node:fs'

interface Setup {
  logPath: string
  /** How long without a ping counts as wedged. */
  silenceMs: number
}

let setup: Setup | null = null
let lastPing = Date.now()
let reportedAt = 0

function write(level: 'warn' | 'info', text: string): void {
  if (!setup) return
  try {
    appendFileSync(setup.logPath, `${new Date().toISOString()} ${level.padEnd(5)} ${text}\n`)
  } catch {
    // A watchdog that cannot write its line has nothing else to offer, and
    // crashing it would remove the only thing watching.
  }
}

process.parentPort?.on('message', (event) => {
  const message = event.data as { type: string } & Partial<Setup>
  if (message?.type === 'setup' && message.logPath) {
    setup = { logPath: message.logPath, silenceMs: message.silenceMs ?? 8_000 }
    lastPing = Date.now()
    return
  }
  if (message?.type === 'ping') {
    if (reportedAt > 0) {
      write(
        'warn',
        `the main process is answering again after ${Math.round((Date.now() - reportedAt) / 1000)}s ` +
          `(it stopped for at least ${Math.round((Date.now() - lastPing) / 1000)}s)`
      )
      reportedAt = 0
    }
    lastPing = Date.now()
  }
})

setInterval(() => {
  if (!setup) return
  const silent = Date.now() - lastPing
  if (silent < setup.silenceMs || reportedAt > 0) return
  reportedAt = Date.now()
  write(
    'warn',
    `the main process has not answered for ${Math.round(silent / 1000)}s — the window will be ` +
      `frozen and no turn is being read. Nothing was killed; this line is the only thing a wedge ` +
      `leaves behind.`
  )
}, 1_000).unref?.()
