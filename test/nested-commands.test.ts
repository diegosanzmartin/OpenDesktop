import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { NOTHING } from '@shared/savings'
import { createTools, type ToolContext } from '../src/main/agent/tools'
import { approveWaiting, autoApproving, listPending, resolveApproval } from '../src/main/approvals'
import { loadConfig } from '../src/main/config'
import { getRuntime } from '../src/main/runtime'
import * as store from '../src/main/store'
import { boot, newSession } from './helpers'

beforeAll(boot)

type Outcome = { asked: boolean; refused: boolean }

function context(auto: boolean, over: Partial<Parameters<typeof store.createSession>[0]> = {}): ToolContext {
  const config = loadConfig()
  const session = newSession({ autoApprove: auto, ...over })
  writeFileSync(join(session.cwd, 'f.txt'), 'a;b')
  return {
    config,
    agent: { id: 'build', name: 'Build', mode: 'primary' },
    permissions: { ...config.permissions, denylist: [...config.permissions.denylist, 'touch forbidden*'] },
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

function waitingFor(sessionId: string) {
  return listPending().filter((request) => request.sessionId === sessionId)
}

function bash(ctx: ToolContext, command: string): Promise<unknown> {
  const tools = createTools(ctx)
  return (tools.bash.execute as (input: unknown, options: unknown) => Promise<unknown>)(
    { command, description: 'test' },
    { toolCallId: 'b', messages: [] }
  )
}

async function run(ctx: ToolContext, command: string): Promise<Outcome> {
  let refused = false
  const running = bash(ctx, command).catch((error: Error) => {
    refused = /Refused by this machine/.test(error.message)
  })
  await new Promise((resolve) => setTimeout(resolve, 60))
  const asked = waitingFor(ctx.sessionId)
  for (const request of asked) resolveApproval(request.id, 'once')
  await running
  return { asked: asked.length > 0, refused }
}

const outside = mkdtempSync(join(tmpdir(), 'od-outside-'))
const source = join(outside, 'src.txt')
writeFileSync(source, 'x')

describe('auto-approve is read when a call would ask, not when the turn started', () => {
  test('switching it on mid-turn stops the next call from asking', async () => {
    const ctx = context(false)
    store.updateSession(ctx.sessionId, { autoApprove: true })
    expect((await run(ctx, 'touch b.txt')).asked).toBe(false)
  })

  test('switching it off mid-turn makes the next call ask', async () => {
    const ctx = context(true)
    store.updateSession(ctx.sessionId, { autoApprove: false })
    expect((await run(ctx, 'touch b.txt')).asked).toBe(true)
  })

  test('switching it on lets the card already waiting through', async () => {
    const ctx = context(false)
    const running = bash(ctx, 'touch a.txt')
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(waitingFor(ctx.sessionId)).toHaveLength(1)
    store.updateSession(ctx.sessionId, { autoApprove: true })
    approveWaiting(ctx.config, ctx.sessionId)
    await running
    expect(existsSync(join(ctx.cwd, 'a.txt'))).toBe(true)
  })

  test('a subagent follows the switch of the conversation it works for', () => {
    const config = loadConfig()
    const lead = newSession({ autoApprove: false })
    const helper = newSession({ autoApprove: false, parentSessionId: lead.id })
    store.updateSession(lead.id, { autoApprove: true })
    expect(autoApproving(config, helper.id)).toBe(true)
  })

  test('a sandboxed conversation keeps asking whatever the switch says', () => {
    const config = loadConfig()
    const boxed = { ...config, environment: { ...config.environment, box: { kind: 'container' } } } as unknown as typeof config
    const session = newSession({ autoApprove: true, environmentId: 'box' })
    expect(autoApproving(boxed, session.id)).toBe(false)
  })
})

/*
 * The denylist is a tripwire, not a sandbox: `base64 -d | sh` or `python -c`
 * still get past it. What it must catch is the same command one wrapper deep.
 */
const NESTED = [
  'bash -c "touch forbidden.txt"',
  "sh -c 'touch forbidden.txt'",
  'zsh -lc "touch forbidden.txt"',
  'echo $(touch forbidden.txt)',
  'echo "$(touch forbidden.txt)"',
  'echo `touch forbidden.txt`',
  '( touch forbidden.txt )',
  '{ touch forbidden.txt; }',
  'env touch forbidden.txt',
  'env -i FOO=1 touch forbidden.txt',
  'command touch forbidden.txt',
  'nohup touch forbidden.txt',
  'time touch forbidden.txt',
  'timeout 5 touch forbidden.txt',
  'FOO=1 touch forbidden.txt',
  '\\touch forbidden.txt',
  '/usr/bin/touch forbidden.txt',
  'find . -maxdepth 0 -exec touch forbidden.txt \\;',
  'eval "touch forbidden.txt"',
  'if true; then touch forbidden.txt; fi',
  'true && bash -c "true && sh -c \'touch forbidden.txt\'"',
  'bash <<EOF\ntouch forbidden.txt\nEOF',
  'touch forbidden.txt 2>/dev/null'
]

describe('the denylist reaches a command nested inside another', () => {
  for (const auto of [true, false]) {
    test.each(NESTED)(`${auto ? 'auto-approving' : 'asking'}: %s`, async (command) => {
      const ctx = context(auto)
      const outcome = await run(ctx, command)
      expect(existsSync(join(ctx.cwd, 'forbidden.txt'))).toBe(false)
      expect(outcome).toEqual({ asked: false, refused: true })
    })
  }
})

// Read-only lines the default allowlist is meant to cover, in the shapes models write them.
const QUIET = [
  'ls',
  'git status && ls | grep x',
  'git log --oneline -3 | cat',
  'cd sub 2>/dev/null; ls -la',
  'cd .. && cd - && git status --short',
  'grep "a;b" f.txt',
  "grep -rn '=>' .",
  'grep -c "a|b" f.txt',
  'ls nothing 2>/dev/null',
  'ls 2>&1 | head -3',
  'find . -name "*.ts" 2>/dev/null | head',
  'cat f.txt &>/dev/null',
  'echo "a > b"'
]

describe('a read-only line does not ask', () => {
  test.each(QUIET)('%s', async (command) => {
    expect((await run(context(false), command)).asked).toBe(false)
  })
})

// Lines that run or write more than the text shows: allowlisted words, still a question.
const STILL_ASKS = [
  'echo $(touch x.txt)',
  'echo "$(touch x.txt)"',
  'echo `touch x.txt`',
  'cat f.txt > copy.txt',
  'echo hi 2>/dev/null > out.txt',
  "cat f.txt | sh -c 'cat'",
  'echo f.txt | xargs cat',
  'find . -exec cat {} \\;',
  'ls & touch x.txt',
  `cd ${outside} && touch x.txt`
]

describe('a line that does more than it shows still asks', () => {
  test.each(STILL_ASKS)('%s', async (command) => {
    expect((await run(context(false), command)).asked).toBe(true)
  })
})

describe('writing outside the folder', () => {
  test('a copy from outside into the folder is not a write outside, once granted', async () => {
    const ctx = context(false)
    expect((await run(ctx, `cp ${source} .`)).asked).toBe(true)
    const again = bash(ctx, `cp ${source} copy.txt`)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const [card] = waitingFor(ctx.sessionId)
    expect(card?.outside).toBeUndefined()
    resolveApproval(card.id, 'always')
    await again
    expect((await run(ctx, `cp ${source} other.txt`)).asked).toBe(false)
  })

  test('a redirect quoted inside an argument is not a write', async () => {
    const ctx = context(false)
    const running = bash(ctx, `touch "x > ${join(outside, 'y')}"`)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const [card] = waitingFor(ctx.sessionId)
    expect(card?.outside).toBeUndefined()
    resolveApproval(card.id, 'once')
    await running
  })

  test('a copy into a folder outside still names it', async () => {
    const ctx = context(false)
    const running = bash(ctx, `cp f.txt ${outside}/`)
    await new Promise((resolve) => setTimeout(resolve, 60))
    const [card] = waitingFor(ctx.sessionId)
    expect(card?.outside).toEqual([`${outside}/`])
    resolveApproval(card.id, 'reject')
    await running.catch(() => undefined)
  })
})

describe('auto-approve asks nothing it should not', () => {
  test.each([...QUIET, ...STILL_ASKS, `cp ${source} .`, `cat ${source} > ${join(outside, 'out.txt')}`])(
    '%s',
    async (command) => {
      expect((await run(context(true), command)).asked).toBe(false)
    }
  )
})
