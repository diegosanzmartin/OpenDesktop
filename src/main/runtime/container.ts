import { spawn } from 'node:child_process'
import { posix } from 'node:path'
import type { EnvironmentKind, FileEntry } from '@shared/types'
import { SANDBOX_USER, SANDBOX_WORKDIR, containerName } from '@shared/sandbox'
import type { ExecOptions, ExecResult, Runtime } from './types'
import { RuntimeError } from './types'
import { ensureContainer } from '../sandbox'

const MAX_OUTPUT = 200_000

/**
 * A runtime that speaks to one session's throwaway Docker container.
 *
 * Every operation is a `docker exec` into the container named after the session,
 * and every one of them runs as the unprivileged `pentester` user — never root,
 * which belongs to the app alone (it owns the firewall). The container is
 * brought up lazily on the first call, the same way the SSH runtime connects
 * lazily, so a sandbox session that is never used never starts a container.
 *
 * Because containers are per session but a runtime is cached per environment,
 * this one carries the session id it was built for; `getRuntime` keys the cache
 * by environment *and* session for the container kind.
 */
export class ContainerRuntime implements Runtime {
  readonly kind: EnvironmentKind = 'container'

  constructor(
    readonly id: string,
    readonly label: string,
    private readonly sessionId: string | null,
    private readonly onStatus?: (connected: boolean, message?: string) => void
  ) {}

  private requireSession(): string {
    if (!this.sessionId) {
      throw new RuntimeError(
        'A sandbox runs one container per conversation. Open a session on this environment to use it.'
      )
    }
    return this.sessionId
  }

  async connect(): Promise<void> {
    const session = this.requireSession()
    try {
      await ensureContainer(session)
      this.onStatus?.(true)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      this.onStatus?.(false, message)
      throw new RuntimeError(message)
    }
  }

  async dispose(): Promise<void> {
    // The container is torn down when the session is deleted, not when the
    // cached runtime is dropped — dropping the runtime happens on any config
    // edit, and that must not kill a running pentest.
  }

  resolve(cwd: string, path: string): string {
    if (path.startsWith('/')) return posix.normalize(path)
    return posix.normalize(posix.join(cwd || SANDBOX_WORKDIR, path))
  }

  async homeDir(): Promise<string> {
    return SANDBOX_WORKDIR
  }

  /** The `docker exec` argv for a command run as the agent (unprivileged). */
  private argv(command: string, cwd: string): string[] {
    return [
      'exec',
      '--user',
      SANDBOX_USER,
      '-w',
      cwd || SANDBOX_WORKDIR,
      containerName(this.requireSession()),
      'sh',
      '-c',
      command
    ]
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    await this.connect()
    const limit = options.maxBytes ?? MAX_OUTPUT
    return new Promise((resolveExec, rejectExec) => {
      const child = spawn('docker', this.argv(command, options.cwd), {
        env: { ...process.env, TERM: 'dumb', NO_COLOR: '1' }
      })

      let stdout = ''
      let stderr = ''
      let truncated = false
      let settled = false

      const timer = options.timeoutMs
        ? setTimeout(() => {
            child.kill('SIGKILL')
            stderr += `\n[timed out after ${options.timeoutMs}ms]`
          }, options.timeoutMs)
        : null

      const onAbort = (): void => {
        child.kill('SIGKILL')
      }
      options.signal?.addEventListener('abort', onAbort, { once: true })

      const push = (target: 'out' | 'err', data: Buffer): void => {
        const text = data.toString('utf8')
        if (target === 'out') {
          if (stdout.length < limit) stdout += text
          else truncated = true
        } else if (stderr.length < limit) stderr += text
        else truncated = true
        options.onChunk?.(text)
      }

      child.stdout.on('data', (d: Buffer) => push('out', d))
      child.stderr.on('data', (d: Buffer) => push('err', d))

      const finish = (exitCode: number): void => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolveExec({ stdout, stderr, exitCode, truncated })
      }

      child.on('close', (code) => finish(code ?? 0))
      child.on('error', (err) => {
        if (settled) return
        settled = true
        if (timer) clearTimeout(timer)
        rejectExec(err)
      })
    })
  }

  /** Runs a short command in the container and returns its stdout, trimmed. */
  private async run(command: string, cwd = SANDBOX_WORKDIR): Promise<ExecResult> {
    return this.exec(command, { cwd, timeoutMs: 30_000 })
  }

  async readFile(path: string): Promise<string> {
    const res = await this.run(`cat ${quote(path)}`)
    if (res.exitCode !== 0) throw new RuntimeError(res.stderr.trim() || `cannot read ${path}`)
    return res.stdout
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    // base64 so a binary file survives the text pipe. The container has
    // coreutils, so `base64` is there.
    const res = await this.exec(`base64 ${quote(path)}`, {
      cwd: SANDBOX_WORKDIR,
      timeoutMs: 30_000,
      maxBytes: 40_000_000
    })
    if (res.exitCode !== 0) throw new RuntimeError(res.stderr.trim() || `cannot read ${path}`)
    return Buffer.from(res.stdout.replace(/\s+/g, ''), 'base64')
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir = posix.dirname(path)
    await this.run(`mkdir -p ${quote(dir)}`)
    await this.connect()
    await new Promise<void>((resolveWrite, rejectWrite) => {
      const child = spawn('docker', [
        'exec',
        '--user',
        SANDBOX_USER,
        '-i',
        containerName(this.requireSession()),
        'sh',
        '-c',
        `cat > ${quote(path)}`
      ])
      let stderr = ''
      child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')))
      child.on('close', (code) =>
        code === 0 ? resolveWrite() : rejectWrite(new RuntimeError(stderr.trim() || `cannot write ${path}`))
      )
      child.on('error', rejectWrite)
      child.stdin.end(content)
    })
  }

  async exists(path: string): Promise<boolean> {
    return (await this.run(`test -e ${quote(path)}`)).exitCode === 0
  }

  async isDirectory(path: string): Promise<boolean> {
    return (await this.run(`test -d ${quote(path)}`)).exitCode === 0
  }

  async stat(path: string): Promise<{ size: number; modifiedAt: number } | null> {
    const res = await this.run(`stat -c '%s %Y' ${quote(path)}`)
    if (res.exitCode !== 0) return null
    const [size, mtime] = res.stdout.trim().split(/\s+/)
    return { size: Number(size) || 0, modifiedAt: (Number(mtime) || 0) * 1000 }
  }

  async list(path: string): Promise<FileEntry[]> {
    // GNU find (Debian) with a printf, one line per entry: type, size, mtime, name.
    const res = await this.run(
      `find ${quote(path)} -mindepth 1 -maxdepth 1 -printf '%y\\t%s\\t%T@\\t%f\\n' 2>/dev/null`
    )
    const out: FileEntry[] = []
    for (const line of res.stdout.split('\n')) {
      if (!line) continue
      const [type, size, mtime, ...rest] = line.split('\t')
      const name = rest.join('\t')
      if (!name) continue
      out.push({
        name,
        path: posix.join(path, name),
        directory: type === 'd',
        size: Number(size) || 0,
        modifiedAt: Math.round((Number(mtime) || 0) * 1000)
      })
    }
    return out.sort(
      (a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name)
    )
  }
}

/** Single-quote a path for `sh -c`, closing and reopening around any quote. */
function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}
