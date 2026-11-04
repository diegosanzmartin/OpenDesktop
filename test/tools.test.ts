import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { NOTHING } from '@shared/savings'
import { createTools, type ToolContext } from '../src/main/agent/tools'
import { cancelSessionApprovals, grantForSession, listPending, resolveApproval } from '../src/main/approvals'
import { bus } from '../src/main/bus'
import * as store from '../src/main/store'
import { loadConfig } from '../src/main/config'
import { getRuntime, type Runtime } from '../src/main/runtime'
import { boot, newSession, tempDir } from './helpers'

beforeAll(boot)

function context(runtime: Runtime): ToolContext {
  const config = loadConfig()
  return {
    config,
    agent: { id: 'build', name: 'Build', mode: 'primary' },
    permissions: config.permissions,
    sessionId: 's',
    environmentId: 'e',
    cwd: tempDir(),
    runtime,
    signal: new AbortController().signal,
    savings: NOTHING,
    modelRef: 'p/strong',
    currentMessageId: () => 'm',
    depth: 0,
    spawnSubagent: async () => ({ sessionId: 'c', report: '' })
  } as unknown as ToolContext
}

describe('reading outside the working directory', () => {
  async function read(path: string, ctx: ToolContext): Promise<'asked' | 'read'> {
    const tools = createTools(ctx)
    const running = (tools.read.execute as (input: unknown, options: unknown) => Promise<unknown>)(
      { path },
      { toolCallId: 'r', messages: [] }
    )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const asked = listPending().find((request) => request.sessionId === ctx.sessionId)
    if (asked) {
      resolveApproval(asked.id, 'once')
      await running
      return 'asked'
    }
    await running
    return 'read'
  }

  function sessionContext(autoApprove = false): ToolContext {
    // The stored session is what the decision reads, so the switch has to be
    // on the thing being tested and not only on the context beside it.
    const session = newSession({ autoApprove })
    return { ...context(getRuntime('local')), sessionId: session.id, cwd: session.cwd, autoApprove }
  }

  test('a file inside the folder is read without asking', async () => {
    const ctx = sessionContext()
    writeFileSync(join(ctx.cwd, 'inside.txt'), 'ok')
    expect(await read('inside.txt', ctx)).toBe('read')
  })

  test('a file outside the folder asks first: it is how ~/.ssh ends up in a prompt', async () => {
    const ctx = sessionContext()
    const elsewhere = join(tempDir('od-outside-'), 'secret.txt')
    writeFileSync(elsewhere, 'secret')
    expect(await read(elsewhere, ctx)).toBe('asked')
  })

  test('a session that auto-approves is not interrupted for it', async () => {
    const ctx = sessionContext(true)
    const elsewhere = join(tempDir('od-outside-'), 'notes.txt')
    writeFileSync(elsewhere, 'n')
    expect(await read(elsewhere, ctx)).toBe('read')
  })
})

describe('tool set', () => {
  test('a local session has fetch', () => {
    expect(Object.keys(createTools(context(getRuntime('local'))))).toContain('fetch')
  })

  test('a sandbox session has no fetch: it would run on the host, outside the container firewall', () => {
    const container = { ...getRuntime('local'), kind: 'container' } as Runtime
    expect(Object.keys(createTools(context(container)))).not.toContain('fetch')
  })
})

describe('bash writing outside the working directory', () => {
  async function bash(command: string, ctx: ToolContext): Promise<'asked' | 'ran'> {
    const tools = createTools(ctx)
    const running = (tools.bash.execute as (input: unknown, options: unknown) => Promise<unknown>)(
      { command, description: 'test' },
      { toolCallId: 'b', messages: [] }
    ).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 50))
    const asked = listPending().find((request) => request.sessionId === ctx.sessionId)
    if (asked) {
      resolveApproval(asked.id, 'reject')
      await running
      return 'asked'
    }
    await running
    return 'ran'
  }

  test('an "always" for a program does not cover sending its output out of the folder', async () => {
    const session = newSession({ autoApprove: false })
    const ctx = { ...context(getRuntime('local')), sessionId: session.id, cwd: session.cwd }
    grantForSession(session.id, 'bash:touch')
    expect(await bash('touch inside.txt', ctx)).toBe('ran')
    const outside = join(tempDir('od-outside-'), 'x.txt')
    expect(await bash(`touch ${outside}`, ctx)).toBe('asked')
  })
})

describe('stopping while a card waits', () => {
  // Reported as two "done" notifications on Stop: the refused card set the session running again.
  test('leaves the session idle, without passing through running again', async () => {
    const session = newSession({ autoApprove: false })
    const controller = new AbortController()
    const ctx = {
      ...context(getRuntime('local')),
      sessionId: session.id,
      cwd: session.cwd,
      autoApprove: false,
      signal: controller.signal
    } as ToolContext
    const statuses: string[] = []
    const off = bus.subscribe((event) => {
      if (event.type === 'session.updated' && event.session.id === session.id) statuses.push(event.session.status)
    })
    const running = (createTools(ctx).bash.execute as (input: unknown, options: unknown) => Promise<unknown>)(
      { command: 'touch stopped.txt', description: 'test' },
      { toolCallId: 'b', messages: [] }
    ).catch(() => undefined)
    await new Promise((resolve) => setTimeout(resolve, 60))
    statuses.length = 0
    cancelSessionApprovals(session.id)
    controller.abort()
    store.setSessionStatus(session.id, 'idle')
    await running
    off()
    expect(statuses).not.toContain('running')
    expect(store.getSession(session.id)?.status).toBe('idle')
  })
})
