import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { transcriptMarkdown } from '@shared/export'
import type { Block, Message, Session } from '@shared/types'
import { exportSession } from '../src/main/export'
import * as store from '../src/main/store'
import { boot, newSession, tempDir } from './helpers'

beforeAll(boot)

const session = {
  id: 's',
  title: 'Move the server to 8080',
  cwd: '/work/shop',
  model: 'litellm/DeepSeek-V4.1-Flash',
  createdAt: Date.UTC(2026, 10, 4, 10, 0)
} as Session

const message = (over: Partial<Message>): Message =>
  ({ id: 'm', sessionId: 's', role: 'assistant', parts: [], createdAt: 0, ...over }) as Message
const block = (over: Partial<Block>): Block =>
  ({ id: 'b', sessionId: 's', messageId: 'm2', tool: 'bash', title: '', status: 'success', input: {}, output: '', cwd: '/work/shop', environmentId: 'local', agentId: 'manager', createdAt: 0, ...over }) as Block

describe('a conversation as Markdown', () => {
  const messages = [
    message({ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'Move the server to 8080.' }] }),
    message({
      id: 'm2',
      parts: [
        { type: 'reasoning', text: 'private thoughts' },
        { type: 'text', text: 'Changing the port.' },
        { type: 'block', blockId: 'b1' },
        { type: 'block', blockId: 'b2' },
        { type: 'block', blockId: 'b3' },
        { type: 'error', text: 'Stopped a loop.' }
      ]
    })
  ]
  const blocks = [
    block({ id: 'b1', tool: 'bash', title: 'grep -n PORT server.js', input: { command: 'grep -n PORT server.js' }, output: Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n') }),
    block({ id: 'b2', tool: 'edit', title: 'server.js', input: { path: 'server.js' }, output: '-const PORT = 4317\n+const PORT = 8080' }),
    block({ id: 'b3', tool: 'bash', title: 'git push', status: 'error', input: { command: 'git push' }, error: 'Blocked by the auto-approve policy — Git Push: not asked for' })
  ]
  const md = transcriptMarkdown(session, messages, blocks)

  test('has a heading with what it is, where and with what', () => {
    expect(md.split('\n')[0]).toBe('# Move the server to 8080')
    expect(md).toContain('/work/shop')
    expect(md).toContain('DeepSeek-V4.1-Flash')
  })

  test('keeps who said what, in order, and leaves the reasoning out', () => {
    expect(md.indexOf('## You')).toBeLessThan(md.indexOf('## Agent'))
    expect(md).toContain('Move the server to 8080.')
    expect(md).toContain('Changing the port.')
    expect(md).not.toContain('private thoughts')
  })

  test('shows commands with their output, cut when long, and edits as a diff', () => {
    expect(md).toContain('```sh\ngrep -n PORT server.js\n```')
    expect(md).toContain('line 0')
    expect(md).not.toContain('line 79')
    expect(md).toMatch(/more lines/)
    expect(md).toContain('```diff\n-const PORT = 4317\n+const PORT = 8080\n```')
  })

  test('says what failed', () => {
    expect(md).toContain('Blocked by the auto-approve policy')
    expect(md).toContain('Stopped a loop.')
  })

  // Found live: an edit plan mode refused was exported as "Edited util.js".
  test('an edit or write that did not happen is not called one', () => {
    const refused = transcriptMarkdown(
      session,
      [message({ id: 'm2', parts: [{ type: 'block', blockId: 'r1' }, { type: 'block', blockId: 'r2' }] })],
      [
        block({ id: 'r1', tool: 'edit', input: { path: 'util.js' }, status: 'error', error: 'Not run: plan mode' }),
        block({ id: 'r2', tool: 'write', input: { path: 'notes.md' }, status: 'error', error: 'Not run: plan mode' })
      ]
    )
    expect(refused).not.toMatch(/\*\*Edited\*\*|\*\*Wrote\*\*/)
    expect(refused).toContain("**Couldn't edit** `util.js`")
    expect(refused).toContain("**Couldn't write** `notes.md`")
  })
})

describe('exporting a session', () => {
  test('writes the Markdown of a stored conversation to a file', () => {
    const stored = newSession({ title: 'Exported' })
    store.addMessage({ sessionId: stored.id, role: 'user', parts: [{ type: 'text', text: 'hello there' }] })
    const path = join(tempDir(), 'out.md')
    exportSession(stored.id, path)
    const written = readFileSync(path, 'utf8')
    expect(written.startsWith('# Exported')).toBe(true)
    expect(written).toContain('hello there')
  })
})
