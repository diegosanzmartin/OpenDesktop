import { beforeAll, describe, expect, test } from 'vitest'
import { runTurn } from '../src/main/agent/runner'
import * as store from '../src/main/store'
import { boot, newSession, scriptedModel, useModel, type Captured } from './helpers'

beforeAll(boot)

describe('the live to-do list', () => {
  // Claude Code, Cursor, OpenCode and Copilot keep one; the person sees progress and drift at a glance.
  test('the agent writes its list on the session, and is told where it stands', async () => {
    const session = newSession({ autoApprove: true })
    const seen: Captured[] = []
    useModel(
      scriptedModel(
        [
          {
            calls: [
              {
                tool: 'todo',
                input: {
                  items: [
                    { text: 'Read the config', status: 'done' },
                    { text: 'Change the port', status: 'in_progress' },
                    { text: 'Run the tests', status: 'pending' }
                  ]
                }
              }
            ]
          },
          { text: 'working on it' }
        ],
        seen
      )
    )
    await runTurn({ sessionId: session.id, userText: 'move the server to 8080' })
    expect(store.getSession(session.id)?.todos).toEqual([
      { text: 'Read the config', status: 'done' },
      { text: 'Change the port', status: 'in_progress' },
      { text: 'Run the tests', status: 'pending' }
    ])
    expect(JSON.stringify(seen[1].prompt)).toContain('1 of 3 done')
    // A checklist, not a tool call to read: nothing for the transcript to draw.
    expect(store.listBlocks(session.id).some((b) => b.tool === 'todo')).toBe(false)
  })

  test('is offered to the agent as a tool', async () => {
    const session = newSession()
    const seen: Captured[] = []
    useModel(scriptedModel([{ text: 'ok' }], seen))
    await runTurn({ sessionId: session.id, userText: 'hello' })
    expect(seen[0].tools.some((t) => t.name === 'todo')).toBe(true)
  })
})

describe('a turn that grows into several steps', () => {
  // DeepSeek did three-part work without the checklist its tool description asked for.
  const bash = (n: number) => ({ calls: [{ tool: 'bash', input: { command: `echo step-${n}`, description: 'x' } }] })

  test('is reminded once to keep a checklist', async () => {
    const session = newSession({ autoApprove: true })
    const seen: Captured[] = []
    useModel(scriptedModel([bash(1), bash(2), bash(3), bash(4), bash(5), bash(6), bash(7), { text: 'done' }], seen))
    await runTurn({ sessionId: session.id, userText: 'do the thing' })
    const reminded = seen.map((step) => JSON.stringify(step.prompt).includes('<plan>'))
    expect(reminded.filter(Boolean).length).toBeGreaterThanOrEqual(1)
    expect(reminded.slice(0, 6).some(Boolean)).toBe(false)
    // Once: the note is not repeated on every later step.
    const notes = seen.map((step) => (JSON.stringify(step.prompt.at(-1)) ?? '').includes('<plan>'))
    expect(notes.filter(Boolean).length).toBe(1)
  })

  test('is not reminded when it already keeps one', async () => {
    const session = newSession({ autoApprove: true })
    const seen: Captured[] = []
    useModel(
      scriptedModel(
        [{ calls: [{ tool: 'todo', input: { items: [{ text: 'a', status: 'in_progress' }] } }] }, bash(1), bash(2), bash(3), bash(4), bash(5), bash(6), { text: 'done' }],
        seen
      )
    )
    await runTurn({ sessionId: session.id, userText: 'do the thing' })
    expect(seen.some((step) => (JSON.stringify(step.prompt.at(-1)) ?? '').includes('<plan>'))).toBe(false)
  })
})
