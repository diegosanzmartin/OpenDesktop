/**
 * Verifies the API key path end to end under a real Electron runtime: stored
 * encrypted, absent in plaintext on disk, resolved through the config
 * placeholder, and removable. safeStorage needs the Keychain, so this cannot
 * run inside the plain-node smoke test.
 *
 * Run with: pnpm secrets:check
 */
import { app } from 'electron'
import { readFileSync } from 'node:fs'
import { expandPlaceholders, normalizeConfig } from './config'
import {
  deleteSecret,
  loadSecrets,
  pinKeychainIdentity,
  secretHint,
  secretStatus,
  setSecret
} from './secrets'
import { listSshAliases } from './runtime/ssh'

const NAME = '__opendesktop_selfcheck'
const VALUE = 'sk-helm-SELFCHECK-9f2a7c41'

const failures: string[] = []
let checks = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  checks++
  if (condition) {
    console.log(`  ok   ${label}`)
  } else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

async function main(): Promise<void> {
  console.log('\nsecrets')
  pinKeychainIdentity()
  const first = loadSecrets()
  check('the keychain is available', first.available, first.error)
  if (!first.available) return

  // Never clobber a real key if the name somehow collides.
  const preexisting = secretStatus().names.includes(NAME)
  check('the self-check name is free', !preexisting)
  if (preexisting) return

  setSecret(NAME, VALUE)

  const onDisk = readFileSync(secretStatus().path, 'utf8')
  check('the value is not on disk in plaintext', !onDisk.includes(VALUE))
  check('the name is on disk', onDisk.includes(NAME))
  check('the stored blob is not readable as the value', !onDisk.includes(VALUE.slice(8)))

  // A fresh load is what a restart does.
  const reloaded = loadSecrets()
  check('it survives a reload', reloaded.names.includes(NAME), reloaded.names)
  check('the entry this check wrote decrypts', !reloaded.failed.includes(NAME), reloaded.failed)
  if (reloaded.failed.length > 0) {
    console.log(`  (pre-existing entries this build cannot read: ${reloaded.failed.join(', ')})`)
  }

  check(
    'the {secret:...} placeholder resolves',
    expandPlaceholders(`{secret:${NAME}}`) === VALUE
  )
  check(
    'an unknown secret resolves to empty, not to the literal',
    expandPlaceholders('{secret:nope}') === ''
  )
  check('the hint masks all but the last four', secretHint(NAME) === `••••${VALUE.slice(-4)}`, secretHint(NAME))

  const config = normalizeConfig({
    model: 'p/m',
    provider: {
      p: {
        npm: '@ai-sdk/openai-compatible',
        name: 'P',
        options: { baseURL: 'https://x', apiKey: `{secret:${NAME}}` },
        models: { m: { name: 'M' } }
      }
    }
  })
  check(
    'the config keeps the placeholder, not the key',
    config.provider.p.options.apiKey === `{secret:${NAME}}`
  )
  check(
    'expansion produces the real key at call time',
    expandPlaceholders(String(config.provider.p.options.apiKey)) === VALUE
  )

  console.log('\nssh credentials')
  const aliases = listSshAliases()
  console.log(`  (~/.ssh/config: ${aliases.length} host${aliases.length === 1 ? '' : 's'}${aliases.length ? ` — ${aliases.slice(0, 5).map((a) => a.alias).join(', ')}` : ''})`)
  check('alias entries carry a usable alias', aliases.every((a) => Boolean(a.alias)))
  check('wildcard Host blocks are skipped', aliases.every((a) => !a.alias.includes('*')))

  // The environment form stores passwords under this name shape.
  const envSecret = `env.${NAME}-box.password`
  setSecret(envSecret, 'hunter2-not-a-real-password')
  loadSecrets()
  const sshConfig = normalizeConfig({
    model: 'p/m',
    environment: {
      'remote-box': {
        name: 'Remote box',
        kind: 'ssh',
        cwd: '/srv/app',
        ssh: { host: 'build.example.com', username: 'deploy', password: `{secret:${envSecret}}` }
      }
    }
  })
  check(
    'the saved config stores only the reference',
    sshConfig.environment['remote-box'].ssh?.password === `{secret:${envSecret}}`
  )
  check(
    'the ssh password resolves at connect time',
    expandPlaceholders(String(sshConfig.environment['remote-box'].ssh?.password)) ===
      'hunter2-not-a-real-password'
  )
  check('the ssh block keeps host and user', sshConfig.environment['remote-box'].ssh?.host === 'build.example.com')
  check('kind survives normalization', sshConfig.environment['remote-box'].kind === 'ssh')
  deleteSecret(envSecret)
  check('the ssh secret is removable', !secretStatus().names.includes(envSecret))

  deleteSecret(NAME)
  check('removal clears it', !secretStatus().names.includes(NAME))
  check(
    'removal clears it on disk too',
    !readFileSync(secretStatus().path, 'utf8').includes(NAME)
  )

  console.log(`\n${checks - failures.length}/${checks} checks passed`)
}

app.whenReady().then(main).then(
  () => app.exit(failures.length > 0 ? 1 : 0),
  (err) => {
    console.error(err)
    app.exit(1)
  }
)
