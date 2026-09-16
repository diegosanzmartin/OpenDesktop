import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, posix } from 'node:path'
import { Client, type ClientChannel, type SFTPWrapper } from 'ssh2'
import type { EnvironmentConfig, EnvironmentKind, FileEntry } from '@shared/types'
import { expandPlaceholders } from '../config'
import { RuntimeError, type ExecOptions, type ExecResult, type Runtime } from './types'

const MAX_OUTPUT = 200_000

interface SshHostSettings {
  host: string
  port: number
  username: string
  identityFile?: string
}

/** Minimal ~/.ssh/config reader: enough to resolve HostName/User/Port/IdentityFile for an alias. */
export function readSshConfigAlias(alias: string): Partial<SshHostSettings> {
  const path = join(homedir(), '.ssh', 'config')
  if (!existsSync(path)) return {}
  const lines = readFileSync(path, 'utf8').split('\n')
  const out: Partial<SshHostSettings> = {}
  let inBlock = false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [rawKey, ...rest] = trimmed.split(/\s+/)
    const key = rawKey.toLowerCase()
    const value = rest.join(' ')
    if (key === 'host') {
      inBlock = rest.some((pattern) => pattern === alias)
      continue
    }
    if (!inBlock) continue
    if (key === 'hostname') out.host = value
    else if (key === 'user') out.username = value
    else if (key === 'port') out.port = Number(value)
    else if (key === 'identityfile') out.identityFile = value.replace(/^~/, homedir())
  }
  return out
}

export interface SshAlias {
  alias: string
  host?: string
  username?: string
  port?: number
  identityFile?: string
}

/**
 * Every Host block in ~/.ssh/config, so the settings form can offer what the
 * user already has configured instead of asking them to retype it.
 */
export function listSshAliases(): SshAlias[] {
  const path = join(homedir(), '.ssh', 'config')
  if (!existsSync(path)) return []
  const out: SshAlias[] = []
  let current: SshAlias | null = null

  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const [rawKey, ...rest] = trimmed.split(/\s+/)
    const key = rawKey.toLowerCase()
    const value = rest.join(' ')

    if (key === 'host') {
      for (const pattern of rest) {
        // Wildcard blocks set defaults; they are not connectable on their own.
        if (pattern.includes('*') || pattern.includes('?')) continue
        current = { alias: pattern }
        out.push(current)
      }
      continue
    }
    if (!current) continue
    if (key === 'hostname') current.host = value
    else if (key === 'user') current.username = value
    else if (key === 'port') current.port = Number(value) || undefined
    else if (key === 'identityfile') current.identityFile = value.replace(/^~/, homedir())
  }
  return out
}

export class SshRuntime implements Runtime {
  readonly kind: EnvironmentKind = 'ssh'
  readonly id: string
  readonly label: string

  private client: Client | null = null
  private sftpClient: SFTPWrapper | null = null
  private connecting: Promise<void> | null = null
  private home: string | null = null

  constructor(
    protected readonly env: EnvironmentConfig,
    protected readonly onStatus?: (connected: boolean, message?: string) => void
  ) {
    this.id = env.id
    this.label = env.name
  }

  /** Runs before every connect, for subclasses that must set something up. */
  protected async prepare(): Promise<void> {}

  protected settings(): SshHostSettings & {
    privateKey?: Buffer
    passphrase?: string
    password?: string
  } {
    const ssh = this.env.ssh
    if (!ssh) throw new RuntimeError(`environment "${this.env.id}" has no ssh block`)
    const fromAlias = ssh.alias ? readSshConfigAlias(ssh.alias) : {}
    const host = expandPlaceholders(ssh.host || fromAlias.host || ssh.alias || '')
    if (!host) throw new RuntimeError(`environment "${this.env.id}" has no ssh host`)
    const username = expandPlaceholders(ssh.username || fromAlias.username || process.env.USER || '')
    const port = ssh.port ?? fromAlias.port ?? 22

    let privateKey: Buffer | undefined
    const keyPath = ssh.privateKey ? expandPlaceholders(ssh.privateKey) : fromAlias.identityFile
    const candidates = keyPath
      ? [keyPath.replace(/^~/, homedir())]
      : [join(homedir(), '.ssh', 'id_ed25519'), join(homedir(), '.ssh', 'id_rsa')]
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        privateKey = readFileSync(candidate)
        break
      }
    }

    return {
      host,
      port,
      username,
      privateKey,
      passphrase: ssh.passphrase ? expandPlaceholders(ssh.passphrase) : undefined,
      password: ssh.password ? expandPlaceholders(ssh.password) : undefined
    }
  }

  connect(): Promise<void> {
    if (this.client) return Promise.resolve()
    if (this.connecting) return this.connecting

    this.connecting = (async () => {
      await this.prepare()
      return this.openConnection()
    })()

    return this.connecting
  }

  private openConnection(): Promise<void> {
    return new Promise<void>((resolveConnect, rejectConnect) => {
      const cfg = this.settings()
      const client = new Client()

      const fail = (err: Error): void => {
        this.client = null
        this.sftpClient = null
        this.connecting = null
        this.onStatus?.(false, err.message)
        rejectConnect(new RuntimeError(`ssh ${cfg.username}@${cfg.host}: ${err.message}`))
      }

      client
        .on('ready', () => {
          this.client = client
          this.connecting = null
          this.onStatus?.(true)
          resolveConnect()
        })
        .on('error', fail)
        .on('end', () => {
          this.client = null
          this.sftpClient = null
          this.onStatus?.(false, 'connection closed')
        })
        .on('close', () => {
          this.client = null
          this.sftpClient = null
        })
        .connect({
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          privateKey: cfg.privateKey,
          passphrase: cfg.passphrase,
          password: cfg.password,
          keepaliveInterval: this.env.ssh?.keepaliveInterval ?? 20_000,
          readyTimeout: 20_000,
          agent: process.env.SSH_AUTH_SOCK
        })
    })
  }

  private async sftp(): Promise<SFTPWrapper> {
    await this.connect()
    if (this.sftpClient) return this.sftpClient
    const client = this.client
    if (!client) throw new RuntimeError('ssh client not connected')
    return new Promise((resolveSftp, rejectSftp) => {
      client.sftp((err, sftp) => {
        if (err) return rejectSftp(err)
        this.sftpClient = sftp
        resolveSftp(sftp)
      })
    })
  }

  resolve(cwd: string, path: string): string {
    if (path.startsWith('~')) return posix.join(this.home ?? '.', path.slice(1))
    return path.startsWith('/') ? posix.normalize(path) : posix.normalize(posix.join(cwd, path))
  }

  async homeDir(): Promise<string> {
    if (this.home) return this.home
    const res = await this.exec('printf %s "$HOME"', { cwd: '/' })
    this.home = res.stdout.trim() || '/root'
    return this.home
  }

  async exec(command: string, options: ExecOptions): Promise<ExecResult> {
    await this.connect()
    const client = this.client
    if (!client) throw new RuntimeError('ssh client not connected')
    const limit = options.maxBytes ?? MAX_OUTPUT

    // cd into the working directory in the same shell invocation so state is explicit
    // and never depends on a persistent session.
    const wrapped = `cd ${shellQuote(options.cwd)} 2>/dev/null || cd /; ${command}`

    return new Promise((resolveExec, rejectExec) => {
      client.exec(
        wrapped,
        { env: { TERM: 'dumb', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' } },
        (err, stream: ClientChannel) => {
          if (err) return rejectExec(err)

          let stdout = ''
          let stderr = ''
          let truncated = false
          let exitCode = 0
          let settled = false

          const timer = options.timeoutMs
            ? setTimeout(() => {
                stream.close()
                stderr += `\n[timed out after ${options.timeoutMs}ms]`
              }, options.timeoutMs)
            : null

          const onAbort = (): void => stream.close()
          options.signal?.addEventListener('abort', onAbort, { once: true })

          stream.on('data', (data: Buffer) => {
            const text = data.toString('utf8')
            if (stdout.length < limit) stdout += text
            else truncated = true
            options.onChunk?.(text)
          })
          stream.stderr.on('data', (data: Buffer) => {
            const text = data.toString('utf8')
            if (stderr.length < limit) stderr += text
            else truncated = true
            options.onChunk?.(text)
          })
          stream.on('exit', (code: number | null) => {
            exitCode = code ?? 0
          })
          stream.on('close', () => {
            if (settled) return
            settled = true
            if (timer) clearTimeout(timer)
            options.signal?.removeEventListener('abort', onAbort)
            resolveExec({ stdout, stderr, exitCode, truncated })
          })
        }
      )
    })
  }

  /** A real PTY on the remote host, for the terminal pane. */
  async openShell(size: { cols: number; rows: number }): Promise<ClientChannel> {
    await this.connect()
    const client = this.client
    if (!client) throw new RuntimeError('ssh client not connected')
    return new Promise((resolveShell, rejectShell) => {
      client.shell({ term: 'xterm-256color', cols: size.cols, rows: size.rows }, (err, stream) => {
        if (err) return rejectShell(err)
        resolveShell(stream)
      })
    })
  }

  async readFile(path: string): Promise<string> {
    return (await this.readFileBuffer(path)).toString('utf8')
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    const sftp = await this.sftp()
    return new Promise((resolveRead, rejectRead) => {
      const chunks: Buffer[] = []
      const stream = sftp.createReadStream(path)
      stream.on('data', (c: Buffer) => chunks.push(c))
      stream.on('error', rejectRead)
      stream.on('end', () => resolveRead(Buffer.concat(chunks)))
    })
  }

  async writeFile(path: string, content: string): Promise<void> {
    const dir = posix.dirname(path)
    await this.exec(`mkdir -p ${shellQuote(dir)}`, { cwd: '/' })
    const sftp = await this.sftp()
    return new Promise((resolveWrite, rejectWrite) => {
      const stream = sftp.createWriteStream(path)
      stream.on('error', rejectWrite)
      stream.on('close', () => resolveWrite())
      stream.end(Buffer.from(content, 'utf8'))
    })
  }

  async exists(path: string): Promise<boolean> {
    const res = await this.exec(`test -e ${shellQuote(path)} && echo yes || echo no`, { cwd: '/' })
    return res.stdout.trim() === 'yes'
  }

  async isDirectory(path: string): Promise<boolean> {
    const res = await this.exec(`test -d ${shellQuote(path)} && echo yes || echo no`, { cwd: '/' })
    return res.stdout.trim() === 'yes'
  }

  async stat(path: string): Promise<{ size: number; modifiedAt: number } | null> {
    const sftp = await this.sftp()
    return new Promise((resolveStat) => {
      sftp.stat(path, (err, attrs) => {
        if (err || !attrs) return resolveStat(null)
        resolveStat({ size: attrs.size, modifiedAt: attrs.mtime * 1000 })
      })
    })
  }

  async list(path: string): Promise<FileEntry[]> {
    const sftp = await this.sftp()
    return new Promise((resolveList, rejectList) => {
      sftp.readdir(path, (err, entries) => {
        if (err) return rejectList(err)
        const out: FileEntry[] = entries.map((e) => ({
          name: e.filename,
          path: posix.join(path, e.filename),
          directory: (e.attrs.mode & 0o170000) === 0o040000,
          size: e.attrs.size,
          modifiedAt: e.attrs.mtime * 1000
        }))
        resolveList(
          out.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
        )
      })
    })
  }

  async dispose(): Promise<void> {
    this.client?.end()
    this.client = null
    this.sftpClient = null
  }
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

export { readFile as readLocalFile }
