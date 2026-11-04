import { beforeAll, describe, expect, test } from 'vitest'
import { decide, deniedSegment, hasOpaqueShellSyntax, listPending, requestApproval, resolveApproval, splitCommand } from '../src/main/approvals'
import { defaultConfig } from '../src/main/config'
import * as store from '../src/main/store'
import { boot, newSession } from './helpers'

beforeAll(boot)

const base = defaultConfig().permissions
const permissions = { ...base, allowlist: ['echo *', 'ls *', 'git status*'], denylist: [...base.denylist, 'rm -rf ~*'] }

// Each of these ran `touch` in bash while the splitter read it as one `echo`.
describe('where the shell splits a line, the splitter splits it too', () => {
  test.each([
    ["echo $'\\'' ; touch pwn ; echo ''", 'ANSI-C quoting hides the closing quote'],
    ["echo a # '\ntouch pwn2\n# '", 'a quote inside a comment'],
    ['echo \\ #; touch pwn3', 'an escaped space before #: not a comment'],
    ["echo 'never closed ; touch pwn4", 'a quote left open'],
    ['echo pwned >&1x.sh', '>& followed by a word writes that file']
  ])('%s still asks (%s)', (command) => {
    expect(decide(permissions, 'bash', command).preapproved).toBe(false)
  })

  test('a comment ends at its newline, and what follows is its own command', () => {
    expect(splitCommand("echo a # it's\ntouch x")).toEqual(["echo a # it's", 'touch x'])
  })

  test('$-quoted text is data, as single quotes are', () => {
    expect(splitCommand("echo $'a;b' && ls")).toEqual(["echo $'a;b'", 'ls'])
    expect(decide(permissions, 'bash', "echo $'a;b\\n'").preapproved).toBe(true)
  })

  test('a # inside a word is not a comment', () => {
    expect(splitCommand('echo a#b; ls')).toEqual(['echo a#b', 'ls'])
    expect(splitCommand('echo ${#x}; ls')).toEqual(['echo ${#x}', 'ls'])
  })

  test('stream redirections are still harmless', () => {
    expect(hasOpaqueShellSyntax('ls 2>&1')).toBe(false)
    expect(hasOpaqueShellSyntax('ls 2>&1 | wc -l')).toBe(false)
  })

  test('the denylist sees the command a comment or $-quote would have hidden', () => {
    expect(deniedSegment(permissions, "echo a # '\nrm -rf ~\n# '")).not.toBeNull()
    expect(deniedSegment(permissions, "echo $'\\'' ; rm -rf ~ ; echo ''")).not.toBeNull()
  })

  test('the denylist sees through wrapper flags that take a value', () => {
    expect(deniedSegment(permissions, 'sudo -u root rm -rf ~')).not.toBeNull()
    expect(deniedSegment(permissions, 'nice -n 10 rm -rf ~')).not.toBeNull()
    expect(deniedSegment(permissions, 'timeout -s KILL 5 rm -rf ~')).not.toBeNull()
  })
})

describe('only the switch releases a waiting card', () => {
  function ask(sessionId: string, note?: string) {
    return requestApproval({
      sessionId,
      blockId: 'b',
      tool: 'bash',
      title: 't',
      detail: 'd',
      ...(note ? { note } : {}),
      environmentId: 'local',
      cwd: '/'
    })
  }
  const waiting = (sessionId: string) => listPending().filter((request) => request.sessionId === sessionId)

  test('typing a draft or a status change answers nothing', async () => {
    const session = newSession({ autoApprove: true })
    const plain = ask(session.id)
    const noted = ask(session.id, 'The rules could not be checked; this one is yours to decide.')
    store.updateSession(session.id, { draft: 'half a sentence' } as Parameters<typeof store.updateSession>[1])
    store.updateSession(session.id, { title: 'renamed' })
    expect(waiting(session.id)).toHaveLength(2)
    for (const request of waiting(session.id)) resolveApproval(request.id, 'reject')
    await Promise.all([plain, noted])
  })

  test('turning it on releases the plain card, never one the judge handed back', async () => {
    const session = newSession({ autoApprove: false })
    store.updateSession(session.id, { title: 'seen' })
    const plain = ask(session.id)
    const noted = ask(session.id, 'Auto-approve stopped judging after 3 refusals in a row; this one is yours to decide.')
    store.updateSession(session.id, { autoApprove: true })
    await expect(plain).resolves.toEqual({ answer: 'once' })
    expect(waiting(session.id).map((request) => request.note)).toEqual([expect.stringContaining('yours to decide')])
    resolveApproval(waiting(session.id)[0].id, 'reject')
    await noted
  })
})
