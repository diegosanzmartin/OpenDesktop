import type { EnvironmentKind, FileEntry } from '@shared/types'

export interface ExecOptions {
  cwd: string
  timeoutMs?: number
  signal?: AbortSignal
  /** Called with stdout/stderr chunks as they arrive, for live block output. */
  onChunk?: (chunk: string) => void
  maxBytes?: number
}

export interface ExecResult {
  stdout: string
  stderr: string
  exitCode: number
  truncated: boolean
}

export interface Runtime {
  readonly id: string
  readonly kind: EnvironmentKind
  readonly label: string
  connect(): Promise<void>
  exec(command: string, options: ExecOptions): Promise<ExecResult>
  readFile(path: string): Promise<string>
  readFileBuffer(path: string): Promise<Buffer>
  writeFile(path: string, content: string): Promise<void>
  exists(path: string): Promise<boolean>
  isDirectory(path: string): Promise<boolean>
  list(path: string): Promise<FileEntry[]>
  /** Size and mtime of one file, or null when it is not there. */
  stat(path: string): Promise<{ size: number; modifiedAt: number } | null>
  homeDir(): Promise<string>
  resolve(cwd: string, path: string): string
  dispose(): Promise<void>
}

export class RuntimeError extends Error {}
