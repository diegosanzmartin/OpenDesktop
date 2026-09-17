import { utilityProcess } from 'electron'
import { join } from 'node:path'
import { logLine, logPath } from './log'

/**
 * Keeps a second process watching this one.
 *
 * Every loop in the main process is one wedge away from taking the window,
 * every session and the quit handler with it — that is what happened once, and
 * the guards that stopped *that* one do not make the class of failure go away.
 * A ping a second from here is a heartbeat something outside can miss, and the
 * line it writes is the trace that was missing the first time.
 *
 * Diagnosis only. It does not restart or kill anything: a main process busy for
 * eight seconds might be finishing something expensive, and a watchdog that
 * shoots first is worse than the fault it is watching for.
 */
let child: ReturnType<typeof utilityProcess.fork> | null = null
let beat: NodeJS.Timeout | null = null

const SILENCE_MS = 8_000
const BEAT_MS = 1_000

export function startWedgeWatch(): void {
  if (child) return
  try {
    child = utilityProcess.fork(join(__dirname, 'wedge-watch.js'), [], {
      serviceName: 'opendesktop-wedge-watch',
      stdio: 'ignore'
    })
    child.postMessage({ type: 'setup', logPath: logPath(), silenceMs: SILENCE_MS })
    child.on('exit', () => {
      child = null
    })
    beat = setInterval(() => child?.postMessage({ type: 'ping' }), BEAT_MS)
  } catch (err) {
    // Never fatal: the app works without a watchdog, and a watchdog that stops
    // the app from starting is a worse bug than the one it looks for.
    logLine('warn', `could not start the wedge watcher: ${(err as Error).message}`)
    child = null
  }
}

export function stopWedgeWatch(): void {
  if (beat) clearInterval(beat)
  beat = null
  child?.kill()
  child = null
}
