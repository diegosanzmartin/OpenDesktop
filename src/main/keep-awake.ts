import { powerSaveBlocker } from 'electron'
import { bus } from './bus'

/**
 * The machine does not go to sleep while a turn is working.
 *
 * A laptop left alone with a long task used to sleep halfway through it, and the
 * turn came back as a dropped stream. Only while something is running: a turn
 * waiting on a person has nothing to lose to sleep, and the display may still
 * turn off ("prevent-app-suspension" keeps the system up, not the screen).
 */
const running = new Set<string>()
let blocker: number | null = null
let started = false

function update(): void {
  if (running.size > 0 && blocker === null) blocker = powerSaveBlocker.start('prevent-app-suspension')
  if (running.size === 0 && blocker !== null) {
    powerSaveBlocker.stop(blocker)
    blocker = null
  }
}

export function startKeepAwake(): void {
  if (started) return
  started = true
  bus.subscribe((event) => {
    if (event.type === 'session.updated') {
      if (event.session.status === 'running') running.add(event.session.id)
      else running.delete(event.session.id)
    } else if (event.type === 'session.deleted') running.delete(event.sessionId)
    else return
    update()
  })
}
