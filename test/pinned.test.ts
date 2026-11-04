import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { runTurn } from '../src/main/agent/runner'
import { DATA_DIR, loadConfig, normalizeConfig, saveConfig } from '../src/main/config'
import { boot, newSession, scriptedModel, useModel, type Captured } from './helpers'

beforeAll(boot)

const lastMessage = (step: Captured): string => JSON.stringify(step.prompt.at(-1))

describe('pinned instructions', () => {
  // Goose re-injects these each turn; DeepSeek forgot rules that only lived in the system prompt.
  test('ride at the end of every step, and are not written into the conversation', async () => {
    const original = loadConfig()
    saveConfig({ ...original, pinned: 'Answer in Spanish. Never retry a refused call another way.' })
    try {
      const session = newSession()
      const seen: Captured[] = []
      useModel(
        scriptedModel(
          [{ calls: [{ tool: 'bash', input: { command: 'echo hi', description: 'x' } }] }, { text: 'hecho' }],
          seen
        )
      )
      await runTurn({ sessionId: session.id, userText: 'say hi' })
      expect(seen.length).toBeGreaterThanOrEqual(2)
      expect(lastMessage(seen[0])).toContain('Answer in Spanish')
      // Once in the turn's view, however many steps: the SDK carries it into each later step.
      for (const step of seen) expect((JSON.stringify(step.prompt).match(/Answer in Spanish/g) ?? []).length).toBe(1)
      const history = readFileSync(join(DATA_DIR, 'history', `${session.id}.json`), 'utf8')
      expect(history).not.toContain('Answer in Spanish')
    } finally {
      saveConfig(original)
    }
  })

  test('are absent when there are none', async () => {
    const session = newSession()
    const seen: Captured[] = []
    useModel(scriptedModel([{ text: 'ok' }], seen))
    await runTurn({ sessionId: session.id, userText: 'hello' })
    expect(JSON.stringify(seen[0].prompt)).not.toContain('<pinned>')
  })

  test('are kept as text, trimmed, and dropped when blank', () => {
    expect(normalizeConfig({ pinned: '  Be brief.  ' }).pinned).toBe('Be brief.')
    expect(normalizeConfig({ pinned: '   ' }).pinned).toBeUndefined()
    expect(normalizeConfig({ pinned: 42 }).pinned).toBeUndefined()
  })
})

describe('notes added between steps', () => {
  // The SDK keeps them for the steps after, so a note re-sent on every step piled up copies.
  test('the budget note is said once, not once more per step', async () => {
    const original = loadConfig()
    saveConfig({ ...original, maxTurnTokens: 10_000 })
    try {
      const session = newSession({ autoApprove: true })
      const seen: Captured[] = []
      const call = (n: number) => ({ calls: [{ tool: 'bash', input: { command: `echo ${n}`, description: 'x' } }] })
      useModel(scriptedModel([call(1), call(2), call(3), call(4), { text: 'done' }], seen, () => ({ input: 2_000, output: 10 })))
      await runTurn({ sessionId: session.id, userText: 'go' })
      const last = JSON.stringify(seen.at(-1)?.prompt)
      expect((last.match(/<budget>/g) ?? []).length).toBe(1)
    } finally {
      saveConfig(original)
    }
  })
})
