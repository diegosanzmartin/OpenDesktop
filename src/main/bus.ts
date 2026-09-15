import { EventEmitter } from 'node:events'
import type { AppEvent } from '@shared/types'

/**
 * Single fan-out point for everything the renderer needs to observe.
 * The main process never pushes to a window directly; it emits here.
 */
class Bus {
  private readonly emitter = new EventEmitter()

  constructor() {
    this.emitter.setMaxListeners(0)
  }

  emit(event: AppEvent): void {
    this.emitter.emit('event', event)
  }

  subscribe(listener: (event: AppEvent) => void): () => void {
    this.emitter.on('event', listener)
    return () => this.emitter.off('event', listener)
  }
}

export const bus = new Bus()
