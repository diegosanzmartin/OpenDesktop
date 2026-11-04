import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { runTurn } from '../src/main/agent/runner'
import { loadConfig, normalizeConfig, saveConfig } from '../src/main/config'
import * as store from '../src/main/store'
import { verifyCommandFor } from '../src/main/verify'
import { boot, newSession, scriptedModel, useModel, type Captured } from './helpers'

beforeAll(boot)

const prompt = (step: Captured): string => JSON.stringify(step.prompt)

async function turnWith(verify: string | undefined, calls: { tool: string; input: Record<string, unknown> }[]) {
  const original = loadConfig()
  const session = newSession({ autoApprove: true })
  writeFileSync(join(session.cwd, 'a.txt'), 'hello')
  saveConfig({ ...original, ...(verify ? { verify: { [session.cwd]: verify } } : {}) })
  const seen: Captured[] = []
  try {
    useModel(scriptedModel([{ calls }, { text: 'done' }], seen))
    await runTurn({ sessionId: session.id, userText: 'change it' })
  } finally {
    saveConfig(original)
  }
  return { session, seen, blocks: store.listBlocks(session.id) }
}

describe('verifying after an edit', () => {
  // Aider, OpenCode and Claude Code feed lint/test failures straight back to the agent.
  test('a failing check after an edit is read by the next step and shown in the transcript', async () => {
    const { seen, blocks } = await turnWith('echo "a.txt:1 type error" && exit 2', [
      { tool: 'edit', input: { path: 'a.txt', old_string: 'hello', new_string: 'bye' } }
    ])
    expect(prompt(seen[1])).toContain('a.txt:1 type error')
    expect(prompt(seen[1])).toMatch(/<verify>/)
    const check = blocks.find((b) => b.tool === 'verify')
    expect(check?.status).toBe('error')
    expect(check?.output).toContain('a.txt:1 type error')
  })

  test('a passing check is shown and adds nothing for the model to read', async () => {
    const { seen, blocks } = await turnWith('echo fine', [
      { tool: 'write', input: { path: 'b.txt', content: 'b' } }
    ])
    expect(prompt(seen[1])).not.toMatch(/<verify>/)
    expect(blocks.find((b) => b.tool === 'verify')?.status).toBe('success')
  })

  test('an edit made with a shell command counts too (models often edit with sed -i)', async () => {
    const { blocks } = await turnWith('echo checked', [
      { tool: 'bash', input: { command: "sed -i '' 's/hello/bye/' a.txt", description: 'edit' } }
    ])
    expect(blocks.some((b) => b.tool === 'verify')).toBe(true)
  })

  test('a read-only command is not an edit', async () => {
    const { blocks } = await turnWith('echo should-not-run', [
      { tool: 'bash', input: { command: 'grep -n hello a.txt 2>/dev/null | head', description: 'look' } }
    ])
    expect(blocks.some((b) => b.tool === 'verify')).toBe(false)
  })

  test('a step without edits runs no check', async () => {
    const { blocks } = await turnWith('echo should-not-run', [{ tool: 'read', input: { path: 'a.txt' } }])
    expect(blocks.some((b) => b.tool === 'verify')).toBe(false)
  })

  test('the check is the one for the deepest folder that holds the session', () => {
    const config = normalizeConfig({ verify: { '/work': 'make check', '/work/shop': 'pnpm typecheck', '/other': 'x' } })
    expect(verifyCommandFor(config, '/work/shop/api')).toBe('pnpm typecheck')
    expect(verifyCommandFor(config, '/work/blog')).toBe('make check')
    expect(verifyCommandFor(config, '/workshop')).toBeNull()
    expect(normalizeConfig({ verify: { '/a': '  ', '/b': 3 } }).verify).toEqual({})
  })
})
