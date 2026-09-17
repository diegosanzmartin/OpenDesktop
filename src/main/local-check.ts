/**
 * Proves the local model works on this machine, for real.
 *
 * The smoke test covers the rules — the checksum, the unsafe archive, the
 * provider it declares — against a stand-in release it serves itself, because
 * a test suite that downloads two gigabytes is a test suite nobody runs. This
 * is the other half: the pinned build, the pinned weights, the sidecar, and a
 * completion that came out of it. It is slow and it uses the network on
 * purpose.
 *
 * Run with: pnpm local:check
 */
import { existsSync } from 'node:fs'
import { generateText } from 'ai'
import { formatBytes, localSpec, LOCAL_PROVIDER_ID } from '@shared/local-model'
import { loadConfig, saveConfig } from './config'
import {
  disposeLocalModel,
  installLocalModel,
  localStatus,
  serverBinary,
  startLocalModel,
  stopLocalModel
} from './local-model'
import { resolveModel } from './providers'
import { bus } from './bus'

const failures: string[] = []
let checks = 0

function check(label: string, condition: boolean, detail?: unknown): void {
  checks++
  if (condition) console.log(`  ok   ${label}`)
  else {
    failures.push(label)
    console.log(`  FAIL ${label}${detail === undefined ? '' : ` — ${JSON.stringify(detail)}`}`)
  }
}

async function main(): Promise<void> {
  const spec = localSpec()
  console.log(`\nlocal model: ${spec.name} on ${process.platform}/${process.arch}`)

  let lastShown = 0
  bus.subscribe((event) => {
    if (event.type !== 'local.status' || !event.status.progress) return
    const { received, total, label } = event.status.progress
    if (received - lastShown < 50_000_000 && received !== total) return
    lastShown = received
    console.log(
      `       ${label}: ${formatBytes(received)} / ${formatBytes(total)} (${Math.round((received / total) * 100)}%)`
    )
  })

  const started = Date.now()
  const installed = await installLocalModel(spec.id)
  check(
    'installing leaves the runtime and the weights on disk',
    installed.runtime.installed && installed.model.installed,
    installed.message
  )
  check('and the server binary is where it says it is', existsSync(serverBinary()))
  console.log(
    `       ${formatBytes(installed.diskBytes)} on disk after ${Math.round((Date.now() - started) / 1000)}s`
  )

  const config = loadConfig(true)
  check(
    'the provider declared itself, with no help',
    config.provider[LOCAL_PROVIDER_ID]?.options.baseURL === 'local://llama',
    config.provider[LOCAL_PROVIDER_ID]
  )
  check(
    'and the model with it',
    Boolean(config.provider[LOCAL_PROVIDER_ID]?.models[spec.id]),
    Object.keys(config.provider[LOCAL_PROVIDER_ID]?.models ?? {})
  )

  const up = Date.now()
  const running = await startLocalModel(spec.id)
  check('the sidecar comes up and answers its health check', running.stage === 'running', running.message)
  check('on a port of its own', Boolean(running.port), running.port)
  console.log(`       ready in ${Math.round((Date.now() - up) / 1000)}s on 127.0.0.1:${running.port}`)

  // The point of all of it: a completion, through the same resolver every turn
  // uses, with nothing configured by hand.
  const resolved = await resolveModel(loadConfig(true), `${LOCAL_PROVIDER_ID}/${spec.id}`)
  const asked = Date.now()
  // Long enough for the rate to mean something: two tokens measures the time
  // to the first one and nothing else.
  const answer = await generateText({
    model: resolved.model,
    prompt: 'In one paragraph, explain what a KV cache is in a transformer.',
    maxOutputTokens: 256
  })
  const elapsed = (Date.now() - asked) / 1000
  check('and it answers a prompt', answer.text.trim().length > 0, answer.text.slice(0, 120))
  check(
    'having counted the tokens, so a turn can be metered',
    (answer.usage.outputTokens ?? 0) > 0,
    answer.usage
  )
  console.log(
    `       "${answer.text.trim().slice(0, 60)}" — ${answer.usage.outputTokens ?? 0} tokens in ${elapsed.toFixed(1)}s` +
      ` (${(((answer.usage.outputTokens ?? 0) / elapsed) || 0).toFixed(1)} tok/s)`
  )

  const stopped = stopLocalModel('the check is done')
  check('stopping it leaves it installed rather than gone', stopped.stage === 'ready' && stopped.model.installed)
  check('and nothing is listening any more', stopped.port === undefined)

  disposeLocalModel()
  // Leave the config as it was found, models and all: this check installs, it
  // does not reconfigure somebody's app.
  saveConfig(loadConfig())

  console.log(`\n${checks - failures.length}/${checks} checks passed`)
  if (failures.length > 0) {
    console.log(`\nfailed:\n${failures.map((f) => `  - ${f}`).join('\n')}`)
    process.exit(1)
  }
  console.log(`\nstatus: ${JSON.stringify(localStatus().stage)}`)
  process.exit(0)
}

void main().catch((err: Error) => {
  console.error(err)
  process.exit(1)
})
