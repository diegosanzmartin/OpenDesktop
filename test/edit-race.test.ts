import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeAll, describe, expect, test } from 'vitest'
import { runTurn } from '../src/main/agent/runner'
import { listPending, resolveApproval } from '../src/main/approvals'
import * as store from '../src/main/store'
import { boot, newSession, scriptedModel, useModel } from './helpers'

beforeAll(boot)

const edit = (path: string, old_string: string, new_string: string) => ({
  tool: 'edit',
  input: { path, old_string, new_string }
})

describe('two edits to one file', () => {
  // Found live: two edits to test.js in one step both said "success" and the first was lost.
  test('made in the same step, both land', async () => {
    const session = newSession({ autoApprove: true })
    const file = join(session.cwd, 'test.js')
    writeFileSync(file, "const { a } = require('./util')\nassert(a())\nconsole.log('ok')\n")
    useModel(
      scriptedModel([
        {
          calls: [
            edit('test.js', "const { a } = require('./util')", "const { a, b } = require('./util')"),
            edit('test.js', "console.log('ok')", "assert(b())\nconsole.log('ok')")
          ]
        },
        { text: 'done' }
      ])
    )
    await runTurn({ sessionId: session.id, userText: 'add b' })
    const after = readFileSync(file, 'utf8')
    expect(after).toContain("const { a, b } = require('./util')")
    expect(after).toContain('assert(b())')
  })

  test('approved one after the other, the second does not undo the first', async () => {
    const session = newSession({ autoApprove: false })
    const file = join(session.cwd, 'notes.md')
    writeFileSync(file, 'one\ntwo\n')
    useModel(
      scriptedModel([
        { calls: [edit('notes.md', 'one', 'ONE'), edit('notes.md', 'two', 'TWO')] },
        { text: 'done' }
      ])
    )
    const turn = runTurn({ sessionId: session.id, userText: 'shout' })
    for (let approved = 0; approved < 2; ) {
      const waiting = listPending().filter((p) => p.sessionId === session.id)
      if (waiting.length > 0) {
        resolveApproval(waiting[0].id, 'once')
        approved++
      }
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    await turn
    expect(readFileSync(file, 'utf8')).toBe('ONE\nTWO\n')
    expect(store.getSession(session.id)?.status).toBe('idle')
  })
})
