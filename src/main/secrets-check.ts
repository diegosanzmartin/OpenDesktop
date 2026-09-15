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
import { deleteSecret, loadSecrets, secretHint, secretStatus, setSecret } from './secrets'

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
  check('no decryption errors', !reloaded.error, reloaded.error)

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
