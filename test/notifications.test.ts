import { beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import { DEFAULT_NOTIFICATIONS, decideNotice, noticeContent } from '../src/shared/notifications'
import * as store from '../src/main/store'
import { boot, newSession } from './helpers'

const os = vi.hoisted(() => ({
  shown: [] as { options: { title: string; body: string }; emit: (event: string, ...args: unknown[]) => void }[],
  appEvents: [] as string[]
}))

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events')
  class Notification extends EventEmitter {
    static isSupported = (): boolean => true
    constructor(public options: { title: string; body: string }) {
      super()
    }
    show(): void {
      os.shown.push(this)
    }
  }
  return { Notification, BrowserWindow: { getAllWindows: () => [] }, app: { setAppUserModelId: () => {}, emit: (event: string) => os.appEvents.push(event) } }
})

const { startNotifications, takePendingFocus, testNotification } = await import('../src/main/notifications')

beforeAll(() => {
  boot()
  startNotifications()
})
beforeEach(() => {
  os.shown.length = 0
})

const unfocused = { settings: DEFAULT_NOTIFICATIONS, windowFocused: false }

describe('who is told', () => {
  test("a subagent's approval is worth telling; its finished turn is reported by its parent", () => {
    expect(decideNotice({ ...unfocused, kind: 'approval', subagent: true }).show).toBe(true)
    expect(decideNotice({ ...unfocused, kind: 'done', subagent: true }).show).toBe(false)
  })

  test('"Every turn" tells even while the window is in front', () => {
    expect(decideNotice({ ...unfocused, windowFocused: true, kind: 'done', session: 'all' }).show).toBe(true)
    expect(decideNotice({ ...unfocused, windowFocused: true, kind: 'done' }).show).toBe(false)
  })
})

describe('what it says', () => {
  test('a wait that is not an approval says what it is waiting for', () => {
    expect(noticeContent({ kind: 'approval', title: 'T', waiting: 'Stopped a loop of identical tool calls.' }).body).toBe(
      'Stopped a loop of identical tool calls.'
    )
    expect(noticeContent({ kind: 'approval', title: 'T' }).body).toBe('Waiting for your approval.')
  })
})

describe('the notifications the app sends', () => {
  test("a subagent waiting on approval is announced under its parent's name", () => {
    const parent = newSession({ title: 'Split the CLAUDE.md' })
    const child = store.createSession({ ...parent, title: 'child', parentSessionId: parent.id })
    store.setSessionStatus(child.id, 'running')
    store.setSessionStatus(child.id, 'awaiting-approval')
    expect(os.shown.map((n) => n.options.title)).toEqual(['Split the CLAUDE.md'])
  })

  test("a muted parent silences its subagents' approvals too", () => {
    const parent = newSession({ title: 'quiet' })
    store.updateSession(parent.id, { notify: 'muted' })
    const child = store.createSession({ ...parent, title: 'child', parentSessionId: parent.id })
    store.setSessionStatus(child.id, 'running')
    store.setSessionStatus(child.id, 'awaiting-approval')
    expect(os.shown).toHaveLength(0)
  })

  test('a failed turn says why it failed', () => {
    const session = newSession({ title: 'broken' })
    store.setSessionStatus(session.id, 'running')
    const message = store.addMessage({ sessionId: session.id, role: 'assistant', parts: [] })
    store.pushPart(session.id, message.id, { type: 'error', text: 'The provider refused the key (401).' })
    store.setSessionStatus(session.id, 'error')
    expect(os.shown[0]?.options.body).toBe('Stopped: The provider refused the key (401).')
  })

  test('the test button reports a notification the system refused', async () => {
    const result = testNotification()
    os.shown[0].emit('failed', {}, 'not allowed')
    expect(await result).toBe(false)
  })
})

describe('a click with every window closed', () => {
  // macOS keeps the app running with no window; the click used to do nothing at all.
  test('opens a window and leaves the conversation for it to show', () => {
    const session = newSession({ title: 'Closed window' })
    store.setSessionStatus(session.id, 'running')
    store.setSessionStatus(session.id, 'idle')
    const notice = os.shown.at(-1)
    expect(notice).toBeDefined()
    notice!.emit('click')
    expect(os.appEvents).toContain('activate')
    expect(takePendingFocus()).toBe(session.id)
    expect(takePendingFocus()).toBeNull()
  })
})
