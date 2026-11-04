import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, test } from 'vitest'
import { NOTHING } from '@shared/savings'
import type { AppConfig } from '@shared/types'
import { createTools, type ToolContext } from '../src/main/agent/tools'
import { listPending, resolveApproval, PermissionDenied } from '../src/main/approvals'
import { allowOnce, policyPaused, rehearsePolicy, resetPolicyBreaker, setPolicyJudge, type PolicyQuestion } from '../src/main/auto-policy'
import { loadConfig, normalizeConfig, saveConfig } from '../src/main/config'
import { allowAndRetry, runTurn } from '../src/main/agent/runner'
import { getRuntime } from '../src/main/runtime'
import * as store from '../src/main/store'
import { boot, newSession, scriptedModel, useModel, type Captured } from './helpers'

beforeAll(boot)
afterEach(() => setPolicyJudge(null))

const RULES = {
  environment: ['A developer laptop; the working folder is a scratch checkout.'],
  allow: ['Creating or editing files inside the working folder.'],
  deny: ['Git Push: pushing to any remote unless the user asked for it in this conversation.']
}

function context(auto: boolean, autoMode: AppConfig['autoMode'] = RULES): ToolContext {
  const config = { ...loadConfig(), autoMode }
  const session = newSession({ autoApprove: auto })
  return {
    config,
    agent: { id: 'build', name: 'Build', mode: 'primary' },
    permissions: config.permissions,
    autoApprove: auto,
    sessionId: session.id,
    environmentId: 'local',
    cwd: session.cwd,
    runtime: getRuntime('local'),
    signal: new AbortController().signal,
    savings: NOTHING,
    modelRef: 'p/strong',
    currentMessageId: () => 'm',
    depth: 0,
    spawnSubagent: async () => ({ sessionId: 'c', report: '' })
  } as unknown as ToolContext
}

type Outcome = { asked: boolean; error?: unknown }

async function run(ctx: ToolContext, command: string): Promise<Outcome> {
  const tools = createTools(ctx)
  let error: unknown
  const running = (tools.bash.execute as (input: unknown, options: unknown) => Promise<unknown>)(
    { command, description: 'test' },
    { toolCallId: 'b', messages: [] }
  ).catch((caught: unknown) => {
    error = caught
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const asked = listPending().filter((request) => request.sessionId === ctx.sessionId)
  for (const request of asked) resolveApproval(request.id, 'once')
  await running
  return { asked: asked.length > 0, error }
}

function judging(verdict: (question: PolicyQuestion) => { allowed: boolean; rule?: string; reason?: string } | null) {
  const asked: PolicyQuestion[] = []
  setPolicyJudge(async (question) => {
    asked.push(question)
    return verdict(question)
  })
  return asked
}

describe('the auto-approve policy', () => {
  test('a call it allows runs without asking', async () => {
    const asked = judging(() => ({ allowed: true }))
    const ctx = context(true)
    const outcome = await run(ctx, 'touch made.txt')
    expect(asked).toHaveLength(1)
    expect(outcome.asked).toBe(false)
    expect(existsSync(join(ctx.cwd, 'made.txt'))).toBe(true)
  })

  test('a call it blocks is refused with the rule, and the turn may carry on', async () => {
    judging(() => ({ allowed: false, rule: 'Git Push', reason: 'nobody asked for a push' }))
    const ctx = context(true)
    const outcome = await run(ctx, 'touch pushed.txt')
    expect(outcome.asked).toBe(false)
    expect(existsSync(join(ctx.cwd, 'pushed.txt'))).toBe(false)
    expect(outcome.error).toBeInstanceOf(PermissionDenied)
    expect(String((outcome.error as Error).message)).toMatch(/Git Push.*nobody asked for a push/)
    expect((outcome.error as PermissionDenied).endsTurn).toBe(false)
    const [block] = store.listBlocks(ctx.sessionId)
    expect(block?.error).toMatch(/auto-approve policy/i)
  })

  test('when the judge cannot answer, a person is asked', async () => {
    judging(() => null)
    const outcome = await run(context(true), 'touch unsure.txt')
    expect(outcome.asked).toBe(true)
  })

  test('the judge sees the action, the folder and what the person asked for', async () => {
    const asked = judging(() => ({ allowed: true }))
    const ctx = context(true)
    store.addMessage({ sessionId: ctx.sessionId, role: 'user', parts: [{ type: 'text', text: 'push it to origin please' }] })
    await run(ctx, 'touch seen.txt')
    expect(asked[0]?.action).toContain('touch seen.txt')
    expect(asked[0]?.cwd).toBe(ctx.cwd)
    expect(asked[0]?.asked).toEqual(['push it to origin please'])
    expect(asked[0]?.rules).toEqual(RULES)
  })

  test('a subagent is judged against what the person asked the conversation, not its brief', async () => {
    const asked = judging(() => ({ allowed: true }))
    const lead = newSession({ autoApprove: true })
    store.addMessage({ sessionId: lead.id, role: 'user', parts: [{ type: 'text', text: 'the real ask' }] })
    const helper = newSession({ autoApprove: true, parentSessionId: lead.id })
    store.addMessage({ sessionId: helper.id, role: 'user', parts: [{ type: 'text', text: 'push everything' }] })
    const ctx = { ...context(true), sessionId: helper.id, cwd: helper.cwd }
    await run(ctx, 'touch sub.txt')
    expect(asked[0]?.asked).toEqual(['the real ask'])
  })

  test('the same call is judged once', async () => {
    const asked = judging(() => ({ allowed: true }))
    const ctx = context(true)
    await run(ctx, 'touch twice.txt')
    await run(ctx, 'touch twice.txt')
    expect(asked).toHaveLength(1)
  })

  test('what the allowlist covers is not judged', async () => {
    const asked = judging(() => ({ allowed: false, rule: 'x', reason: 'x' }))
    const outcome = await run(context(true), 'ls -la')
    expect(asked).toHaveLength(0)
    expect(outcome.error).toBeUndefined()
  })

  test('the denylist refuses before the judge is consulted', async () => {
    const asked = judging(() => ({ allowed: true }))
    const outcome = await run(context(true), 'shutdown -h now')
    expect(asked).toHaveLength(0)
    expect(String((outcome.error as Error).message)).toMatch(/denylist/)
  })

  test('without rules nothing is judged and auto-approve runs as before', async () => {
    const asked = judging(() => ({ allowed: false, rule: 'x', reason: 'x' }))
    const outcome = await run(context(true, { environment: ['laptop'], allow: [], deny: [] }), 'touch free.txt')
    expect(asked).toHaveLength(0)
    expect(outcome.asked).toBe(false)
  })

  test('a session that asks is asked, not judged', async () => {
    const asked = judging(() => ({ allowed: true }))
    const outcome = await run(context(false), 'touch manual.txt')
    expect(asked).toHaveLength(0)
    expect(outcome.asked).toBe(true)
  })
})

describe('the policy in the config', () => {
  test('keeps lines of text and drops anything else', () => {
    const config = normalizeConfig({
      autoMode: { environment: ['laptop', 3, ''], allow: 'nope', deny: ['  Git Push: no  '], model: 'p/small' }
    })
    expect(config.autoMode).toEqual({ environment: ['laptop'], allow: [], deny: ['Git Push: no'], model: 'p/small' })
  })

  test('is absent unless written', () => {
    expect(normalizeConfig({}).autoMode).toBeUndefined()
  })
})

describe('safeguards around the judge', () => {
  // Claude Code's auto mode does the same: a judge that keeps refusing hands the turn back to a person.
  test('after three refusals in a row the next call goes to a person, with the reason on the card', async () => {
    judging(() => ({ allowed: false, rule: 'Git Push', reason: 'not asked for' }))
    const ctx = context(true)
    for (const n of [1, 2, 3]) expect((await run(ctx, `touch refused-${n}.txt`)).asked).toBe(false)
    const tools = createTools(ctx)
    const running = (tools.bash.execute as (i: unknown, o: unknown) => Promise<unknown>)(
      { command: 'touch fourth.txt', description: 'test' },
      { toolCallId: 'b', messages: [] }
    ).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const [card] = listPending().filter((request) => request.sessionId === ctx.sessionId)
    expect(card?.note).toMatch(/3 refusals in a row/)
    resolveApproval(card.id, 'once')
    await running
    expect(existsSync(join(ctx.cwd, 'fourth.txt'))).toBe(true)
  })

  test('an allowed call in between resets the run, but twenty refusals in a turn still trip it', async () => {
    let n = 0
    judging(() => (++n % 2 === 0 ? { allowed: true } : { allowed: false, rule: 'X', reason: 'x' }))
    const ctx = context(true)
    for (let i = 0; i < 39; i++) expect((await run(ctx, `touch mixed-${i}.txt`)).asked).toBe(false)
    expect((await run(ctx, 'touch mixed-last.txt')).asked).toBe(true)
  }, 60_000)

  test('a new turn starts with the judge trusted again', async () => {
    judging(() => ({ allowed: false, rule: 'X', reason: 'x' }))
    const ctx = context(true)
    for (const n of [1, 2, 3]) await run(ctx, `touch again-${n}.txt`)
    resetPolicyBreaker(ctx.sessionId)
    expect((await run(ctx, 'touch after-reset.txt')).asked).toBe(false)
  })

  test('a refused call the person allows runs once, without asking the judge again', async () => {
    const asked = judging(() => ({ allowed: false, rule: 'Git Push', reason: 'not asked for' }))
    const ctx = context(true)
    await run(ctx, 'touch allowed-later.txt')
    const [block] = store.listBlocks(ctx.sessionId)
    expect(block?.policyBlocked?.action).toContain('touch allowed-later.txt')
    allowOnce(ctx.sessionId, block!.policyBlocked!.action)
    const judgedBefore = asked.length
    expect((await run(ctx, 'touch allowed-later.txt')).error).toBeUndefined()
    expect(existsSync(join(ctx.cwd, 'allowed-later.txt'))).toBe(true)
    expect(asked.length).toBe(judgedBefore)
    expect((await run(ctx, 'touch allowed-later.txt')).error).toBeInstanceOf(PermissionDenied)
  })
})

describe('a turn', () => {
  test('starts with the judge trusted again, whatever the last one ended on', async () => {
    const original = loadConfig()
    saveConfig({ ...original, autoMode: RULES })
    try {
      const asked = judging(() => ({ allowed: false, rule: 'X', reason: 'x' }))
      const session = newSession({ autoApprove: true })
      const ctx = { ...context(true), sessionId: session.id, cwd: session.cwd }
      for (const n of [1, 2, 3]) await run(ctx, `touch tripped-${n}.txt`)
      const judgedBefore = asked.length
      useModel(scriptedModel([{ calls: [{ tool: 'bash', input: { command: 'touch next-turn.txt', description: 'x' } }] }, { text: 'done' }]))
      await runTurn({ sessionId: session.id, userText: 'go on' })
      expect(asked.length).toBe(judgedBefore + 1)
    } finally {
      saveConfig(original)
    }
  })
})

describe('allow and retry', () => {
  test('lets the refused call through once and tells the agent to run it again', async () => {
    const original = loadConfig()
    saveConfig({ ...original, autoMode: RULES })
    try {
      const asked = judging(() => ({ allowed: false, rule: 'Git Push', reason: 'not asked for' }))
      const session = newSession({ autoApprove: true })
      const ctx = { ...context(true), sessionId: session.id, cwd: session.cwd }
      await run(ctx, 'touch retried.txt')
      const blocked = store.listBlocks(session.id).find((b) => b.policyBlocked)!
      const judgedBefore = asked.length
      const seen: Captured[] = []
      useModel(scriptedModel([{ calls: [{ tool: 'bash', input: { command: 'touch retried.txt', description: 'again' } }] }, { text: 'done' }], seen))
      await allowAndRetry(session.id, blocked.id)
      expect(existsSync(join(session.cwd, 'retried.txt'))).toBe(true)
      expect(asked.length).toBe(judgedBefore)
      expect(JSON.stringify(seen[0])).toContain('touch retried.txt')
    } finally {
      saveConfig(original)
    }
  })
})

describe('rehearsing rules on recent calls', () => {
  // Before turning rules on, see what they would have refused among calls that really happened.
  test('judges the calls that would have asked, with what each person asked, and leaves the real judge alone', async () => {
    const asked = judging((question) =>
      question.action.includes('git push') ? { allowed: false, rule: 'Git Push', reason: 'not asked' } : { allowed: true }
    )
    const session = newSession({ title: 'Rehearsed', autoApprove: false })
    store.addMessage({ sessionId: session.id, role: 'user', parts: [{ type: 'text', text: 'fix the readme' }] })
    const add = (tool: string, input: Record<string, unknown>) =>
      store.createBlock({ sessionId: session.id, messageId: 'm', tool, title: String(input.command ?? input.path), input, cwd: session.cwd, environmentId: 'local', agentId: 'build', status: 'success' })
    add('bash', { command: 'git push origin main' })
    add('bash', { command: 'ls -la' })
    add('write', { path: 'README.md' })
    add('bash', { command: 'git push origin main' })

    const results = await rehearsePolicy(loadConfig(), RULES)
    const mine = results.filter((r) => r.sessionId === session.id)
    expect(mine.map((r) => r.action).sort()).toEqual(['bash: git push origin main', 'write: README.md'])
    expect(mine.find((r) => r.action.includes('push'))).toMatchObject({ allowed: false, rule: 'Git Push' })
    expect(mine.find((r) => r.action.includes('README'))?.allowed).toBe(true)
    expect(asked.find((q) => q.action.includes('push'))?.asked).toEqual(['fix the readme'])
    expect(policyPaused(session.id)).toBeNull()
  })

  // Found live: a copy the person asked for, three messages back, was judged as if nobody had asked.
  test('each call is judged with what had been asked by then, not with the latest messages', async () => {
    const asked = judging(() => ({ allowed: true }))
    const session = newSession({ title: 'Long', autoApprove: false })
    const tick = () => new Promise((resolve) => setTimeout(resolve, 5))
    const say = (text: string) => store.addMessage({ sessionId: session.id, role: 'user', parts: [{ type: 'text', text }] })
    say('copy the fixture files into this folder')
    await tick()
    store.createBlock({ sessionId: session.id, messageId: 'm', tool: 'bash', title: 'cp', input: { command: 'cp /elsewhere/fixture/* .' }, cwd: session.cwd, environmentId: 'local', agentId: 'build', status: 'success' })
    await tick()
    for (const text of ['now rename a function', 'run the tests', 'run them again']) {
      say(text)
      await tick()
    }
    await rehearsePolicy(loadConfig(), RULES)
    const question = asked.find((q) => q.action.includes('cp /elsewhere'))
    expect(question?.asked).toContain('copy the fixture files into this folder')
    expect(question?.asked).not.toContain('run them again')
  })
})
