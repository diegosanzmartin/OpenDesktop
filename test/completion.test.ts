import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { runTurn } from '../src/main/agent/runner'
import { setCompletionJudge, type CompletionQuestion } from '../src/main/completion'
import { loadConfig, saveConfig } from '../src/main/config'
import * as store from '../src/main/store'
import { boot, newSession, scriptedModel, useModel, type Captured } from './helpers'

beforeAll(boot)
afterEach(() => setCompletionJudge(null))

const work = { calls: [{ tool: 'bash', input: { command: 'echo working', description: 'work' } }] }

function judging(answer: (q: CompletionQuestion) => { done: boolean; missing?: string }) {
  const asked: CompletionQuestion[] = []
  setCompletionJudge(async (question) => {
    asked.push(question)
    return answer(question)
  })
  return asked
}

describe('checking that a turn really finished', () => {
  // After Copilot's Autopilot: a small model compares the ask with what was done.
  test('an unfinished turn carries on with what is missing, then stops once it is done', async () => {
    let n = 0
    const asked = judging(() => (++n === 1 ? { done: false, missing: 'the tests were not run' } : { done: true }))
    const session = newSession({ autoApprove: true })
    const seen: Captured[] = []
    useModel(scriptedModel([work, { text: 'Changed it.' }, { text: 'Ran the tests too: they pass.' }], seen))
    await runTurn({ sessionId: session.id, userText: 'change it and run the tests' })
    expect(asked).toHaveLength(2)
    expect(asked[0].asked).toBe('change it and run the tests')
    expect(asked[0].did).toContain('echo working')
    expect(asked[0].did).toContain('Changed it.')
    expect(seen.some((step) => JSON.stringify(step.prompt).includes('the tests were not run'))).toBe(true)
    const note = store.listBlocks(session.id).find((b) => b.tool === 'completion')
    expect(note?.title).toContain('the tests were not run')
  })

  test('carries on at most twice for one message', async () => {
    const asked = judging(() => ({ done: false, missing: 'still missing' }))
    const session = newSession({ autoApprove: true })
    useModel(scriptedModel([work, { text: 'a' }, { text: 'b' }, { text: 'c' }, { text: 'd' }]))
    await runTurn({ sessionId: session.id, userText: 'do it' })
    // Two checks, two carry-ons; a third check would have nothing it could change.
    expect(asked).toHaveLength(2)
    expect(store.listBlocks(session.id).filter((b) => b.tool === 'completion')).toHaveLength(2)
  })

  test('a plain answer, with no work done, is not checked', async () => {
    const asked = judging(() => ({ done: false, missing: 'x' }))
    const session = newSession({ autoApprove: true })
    useModel(scriptedModel([{ text: 'The port is 4317.' }]))
    await runTurn({ sessionId: session.id, userText: 'which port?' })
    expect(asked).toHaveLength(0)
  })

  // Found live: in plan mode the check called the plan unfinished, and the agent fought the read-only gate twice.
  test('a turn in plan mode is not checked: a written plan is the whole job', async () => {
    const asked = judging(() => ({ done: false, missing: 'the change was not made' }))
    const session = newSession({ autoApprove: true, planMode: true })
    useModel(scriptedModel([work, { text: '1. Add average to util.js. 2. Test it.' }]))
    await runTurn({ sessionId: session.id, userText: 'add average to util.js' })
    expect(asked).toHaveLength(0)
    expect(store.listBlocks(session.id).filter((b) => b.tool === 'completion')).toHaveLength(0)
  })

  test('is off when the config says so', async () => {
    const original = loadConfig()
    saveConfig({ ...original, completionCheck: false })
    try {
      const asked = judging(() => ({ done: false, missing: 'x' }))
      const session = newSession({ autoApprove: true })
      useModel(scriptedModel([work, { text: 'done' }]))
      await runTurn({ sessionId: session.id, userText: 'do it' })
      expect(asked).toHaveLength(0)
    } finally {
      saveConfig(original)
    }
  })
})
