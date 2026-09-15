import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { EnvironmentConfig } from '@shared/types'
import { SshRuntime } from './ssh'
import { RuntimeError } from './types'

const DEFAULT_KEY = join(homedir(), '.ssh', 'google_compute_engine')

/**
 * A Cloud Workstation, reached the way the gcloud CLI does it: open a local TCP
 * tunnel to port 22 on the workstation, then speak ordinary SSH through it.
 *
 * Going through a tunnel rather than `gcloud workstations ssh --command` per
 * call means the whole SSH runtime applies unchanged — one connection for every
 * tool, SFTP for file reads and writes, and a real PTY for the terminal —
 * instead of paying gcloud's start-up cost on every command.
 */
export class GcpWorkstationRuntime extends SshRuntime {
  private tunnel: ChildProcess | null = null
  private localPort = 0
  private starting: Promise<void> | null = null

  private get settingsBlock(): NonNullable<EnvironmentConfig['workstation']> {
    const workstation = this.env.workstation
    if (!workstation) throw new RuntimeError(`environment "${this.env.id}" has no workstation block`)
    return workstation
  }

  /** `gcloud` is not on the PATH a GUI app inherits, so look where it lands. */
  private gcloudBinary(): string {
    for (const candidate of [
      '/usr/local/bin/gcloud',
      '/opt/homebrew/bin/gcloud',
      join(homedir(), 'google-cloud-sdk/bin/gcloud')
    ]) {
      if (existsSync(candidate)) return candidate
    }
    return 'gcloud'
  }

  protected async prepare(): Promise<void> {
    if (this.tunnel && this.localPort) return
    if (this.starting) return this.starting
    this.starting = this.startTunnel().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private startTunnel(): Promise<void> {
    const w = this.settingsBlock
    const args = [
      'workstations',
      'start-tcp-tunnel',
      `--project=${w.project}`,
      `--region=${w.region}`,
      `--cluster=${w.cluster}`,
      `--config=${w.config}`,
      ...(w.startWorkstation ? ['--start-workstation'] : []),
      w.workstation,
      '22',
      '--local-host-port=localhost:0'
    ]

    return new Promise<void>((resolveTunnel, rejectTunnel) => {
      const child = spawn(this.gcloudBinary(), args, {
        env: { ...process.env, CLOUDSDK_CORE_DISABLE_PROMPTS: '1' }
      })
      this.tunnel = child

      let output = ''
      let settled = false

      const fail = (message: string): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        child.kill()
        this.tunnel = null
        this.onStatus?.(false, message)
        rejectTunnel(new RuntimeError(message))
      }

      const timer = setTimeout(
        () => fail(`the gcloud tunnel did not come up in 90s.\n${output.trim()}`),
        90_000
      )

      const onData = (data: Buffer): void => {
        output += data.toString('utf8')
        // gcloud prints: Listening on port [60102].
        const match = /Listening on port \[(\d+)\]/.exec(output)
        if (match && !settled) {
          settled = true
          clearTimeout(timer)
          this.localPort = Number(match[1])
          resolveTunnel()
        }
      }

      child.stdout?.on('data', onData)
      child.stderr?.on('data', onData)
      child.on('error', (err) =>
        fail(
          `could not run gcloud: ${err.message}. Install the Google Cloud SDK, or make sure it is on the PATH of the shell that starts OpenDesktop.`
        )
      )
      child.on('close', (code) => {
        this.tunnel = null
        this.localPort = 0
        if (!settled) fail(`gcloud exited with code ${code ?? 0}.\n${output.trim()}`)
      })
    })
  }

  protected settings(): {
    host: string
    port: number
    username: string
    privateKey?: Buffer
    passphrase?: string
    password?: string
  } {
    const w = this.settingsBlock
    if (!this.localPort) throw new RuntimeError('the workstation tunnel is not open yet')

    const keyPath = (w.privateKey ?? DEFAULT_KEY).replace(/^~/, homedir())
    if (!existsSync(keyPath)) {
      throw new RuntimeError(
        `no workstation key at ${keyPath}. Run "gcloud workstations ssh" once in a terminal; it creates the key on first use.`
      )
    }

    return {
      host: '127.0.0.1',
      port: this.localPort,
      username: w.user || 'user',
      privateKey: readFileSync(keyPath)
    }
  }

  async dispose(): Promise<void> {
    await super.dispose()
    this.tunnel?.kill()
    this.tunnel = null
    this.localPort = 0
  }
}
