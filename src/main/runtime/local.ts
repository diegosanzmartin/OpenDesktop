import { spawn } from 'node:child_process'
import { readdir, readFile, stat, writeFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve as pathResolve } from 'node:path'
import type { EnvironmentKind, FileEntry } from '@shared/types'
import type { ExecOptions, ExecResult, Runtime } from './types'
import { toolEnvironment } from '../tool-env'

const MAX_OUTPUT = 200_000

export class LocalRuntime implements Runtime {
  readonly kind: EnvironmentKind = 'local'
  constructor(
    readonly id: string,
    readonly label: string
  ) {}

  async connect(): Promise<void> {}
  async dispose(): Promise<void> {}

  resolve(cwd: string, path: string): string {
    if (path.startsWith('~')) return join(homedir(), path.slice(1))
    return isAbsolute(path) ? path : pathResolve(cwd, path)
  }

  async homeDir(): Promise<string> {
    return homedir()
  }

  exec(command: string, options: ExecOptions): Promise<ExecResult> {
    const limit = options.maxBytes ?? MAX_OUTPUT
    return new Promise((resolveExec, rejectExec) => {
      const shell = process.env.SHELL || '/bin/bash'
      const child = spawn(shell, ['-l', '-c', command], {
        cwd: options.cwd,
        env: { ...toolEnvironment(), TERM: 'dumb', NO_COLOR: '1', GIT_PAGER: 'cat', PAGER: 'cat' }
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

  async readFile(path: string): Promise<string> {
    return readFile(path, 'utf8')
  }

  async readFileBuffer(path: string): Promise<Buffer> {
    return readFile(path)
  }

  async writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    await writeFile(path, content, 'utf8')
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path)
      return true
    } catch {
      return false
    }
  }

  async isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory()
    } catch {
      return false
    }
  }

  async stat(path: string): Promise<{ size: number; modifiedAt: number } | null> {
    try {
      const s = await stat(path)
      return { size: s.size, modifiedAt: s.mtimeMs }
    } catch {
      return null
    }
  }

  async list(path: string): Promise<FileEntry[]> {
    const entries = await readdir(path, { withFileTypes: true })
    const out: FileEntry[] = []
    for (const e of entries) {
      const full = join(path, e.name)
      let size = 0
      let modifiedAt = 0
      try {
        const s = await stat(full)
        size = s.size
        modifiedAt = s.mtimeMs
      } catch {
        /* dangling symlink */
      }
      out.push({ name: e.name, path: full, directory: e.isDirectory(), size, modifiedAt })
    }
    return out.sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name))
  }
}
