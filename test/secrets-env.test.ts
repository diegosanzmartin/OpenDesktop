import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, test } from 'vitest'
import { forgetSecrets, rememberSecret } from '@shared/errors'
import { getRuntime } from '../src/main/runtime'
import { boot, tempDir } from './helpers'

const SECRET = 'sk-test-0123456789abcdef'
const shell = process.env.SHELL

beforeAll(() => {
  boot()
  rememberSecret(SECRET)
  process.env.FAKE_PROVIDER_KEY = SECRET
  // zsh where there is one (macOS), bash otherwise: a Linux runner has no zsh.
  const zsh = existsSync('/bin/zsh')
  process.env.SHELL = zsh ? '/bin/zsh' : '/bin/bash'
  // The login shell re-reads this, which is how a key stripped from the app's env came back.
  writeFileSync(join(process.env.HOME!, zsh ? '.zprofile' : '.bash_profile'), `export FAKE_PROVIDER_KEY='${SECRET}'\n`)
})

afterAll(() => {
  forgetSecrets()
  delete process.env.FAKE_PROVIDER_KEY
  process.env.SHELL = shell
})

test('a key the app knows is secret is not visible to commands, even after the login profile sets it again', async () => {
  const result = await getRuntime('local').exec('printf "[%s]" "$FAKE_PROVIDER_KEY"', { cwd: tempDir() })
  expect(result.stdout).toBe('[]')
})

test('other variables from the profile still arrive', async () => {
  writeFileSync(join(process.env.HOME!, '.zprofile'), `export FAKE_PROVIDER_KEY='${SECRET}'\nexport FROM_PROFILE=yes\n`)
  const result = await getRuntime('local').exec('printf "%s" "$FROM_PROFILE"', { cwd: tempDir() })
  expect(result.stdout).toBe('yes')
})
