import { beforeAll, describe, expect, test, vi } from 'vitest'
import * as store from '../src/main/store'
import { boot, newSession } from './helpers'

const os = vi.hoisted(() => ({ started: [] as number[], stopped: [] as number[], next: 1 }))

vi.mock('electron', () => ({
  powerSaveBlocker: {
    start: () => {
      const id = os.next++
      os.started.push(id)
      return id
    },
    stop: (id: number) => os.stopped.push(id),
    isStarted: (id: number) => os.started.includes(id) && !os.stopped.includes(id)
  }
}))

const { startKeepAwake } = await import('../src/main/keep-awake')

beforeAll(() => {
  boot()
  startKeepAwake()
})

describe('the machine stays awake while a turn runs', () => {
  test('one blocker for any number of running turns, released when the last one ends', () => {
    const first = newSession()
    const second = newSession()
    store.setSessionStatus(first.id, 'running')
    store.setSessionStatus(second.id, 'running')
    expect(os.started).toHaveLength(1)
    store.setSessionStatus(first.id, 'idle')
    expect(os.stopped).toHaveLength(0)
    store.setSessionStatus(second.id, 'idle')
    expect(os.stopped).toEqual(os.started)
  })

  test('a turn waiting on a person does not keep the machine awake', () => {
    const waiting = newSession()
    const before = os.started.length
    store.setSessionStatus(waiting.id, 'running')
    store.setSessionStatus(waiting.id, 'awaiting-approval')
    expect(os.started.length).toBe(before + 1)
    expect(os.stopped.length).toBe(os.started.length)
  })
})
