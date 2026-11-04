import { beforeAll, describe, expect, test } from 'vitest'
import { isRunning } from '../src/main/agent/runner'
import { sendMessage } from '../src/main/send'
import * as store from '../src/main/store'
import { boot, newSession, scriptedModel, useModel } from './helpers'

beforeAll(boot)

async function settled(sessionId: string): Promise<void> {
  for (let i = 0; i < 100 && isRunning(sessionId); i++) {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('sending a message', () => {
  // Found live: sent, then the window closed at once; it reopened with the sent message back in the box.
  test('clears the saved draft, so a window closed right after sending does not bring it back', async () => {
    const session = newSession({ autoApprove: true })
    store.setSessionDraft(session.id, 'say hello again')
    useModel(scriptedModel([{ text: 'hello again' }]))
    await sendMessage(session.id, 'say hello again')
    await settled(session.id)
    expect(store.getSession(session.id)?.draft).toBeUndefined()
  })

  test('typed while a turn works, it also clears the draft', async () => {
    const session = newSession({ autoApprove: true })
    useModel(
      scriptedModel([
        { calls: [{ tool: 'bash', input: { command: 'sleep 0.4', description: 'wait' } }] },
        { text: 'done' }
      ])
    )
    await sendMessage(session.id, 'start')
    store.setSessionDraft(session.id, 'and this')
    await sendMessage(session.id, 'and this')
    expect(store.getSession(session.id)?.draft).toBeUndefined()
    await settled(session.id)
  })
})
