import type { EnvironmentConfig } from '@shared/types'
import { resolvedConfig } from '../config'
import { bus } from '../bus'
import { LocalRuntime } from './local'
import { SshRuntime } from './ssh'
import { RuntimeError, type Runtime } from './types'

export * from './types'
export { shellQuote } from './ssh'

const runtimes = new Map<string, Runtime>()

function build(env: EnvironmentConfig): Runtime {
  if (env.kind === 'ssh') {
    return new SshRuntime(env, (connected, message) =>
      bus.emit({ type: 'environment.status', environmentId: env.id, connected, message })
    )
  }
  return new LocalRuntime(env.id, env.name)
}

export function getRuntime(environmentId: string): Runtime {
  const existing = runtimes.get(environmentId)
  if (existing) return existing
  const env = resolvedConfig().environment[environmentId]
  if (!env) throw new RuntimeError(`unknown environment "${environmentId}"`)
  const runtime = build(env)
  runtimes.set(environmentId, runtime)
  return runtime
}

export async function testEnvironment(environmentId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const runtime = getRuntime(environmentId)
    await runtime.connect()
    const res = await runtime.exec('uname -a && printf "%s" "$PWD"', {
      cwd: (await runtime.homeDir()) || '/',
      timeoutMs: 15_000
    })
    return { ok: res.exitCode === 0, message: res.stdout.trim() || res.stderr.trim() }
  } catch (err) {
    return { ok: false, message: (err as Error).message }
  }
}

/** Drops cached runtimes so the next call picks up edited config. */
export async function resetRuntimes(): Promise<void> {
  await Promise.all([...runtimes.values()].map((r) => r.dispose().catch(() => undefined)))
  runtimes.clear()
}

export async function disposeRuntimes(): Promise<void> {
  await resetRuntimes()
}
