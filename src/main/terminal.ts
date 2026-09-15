import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { nanoid } from 'nanoid'
import type { ClientChannel } from 'ssh2'
import type { EnvironmentKind } from '@shared/types'
import { bus } from './bus'
import { getRuntime } from './runtime'
import { SshRuntime } from './runtime/ssh'

/**
 * Interactive shells for the terminal pane.
 *
 * Locally the PTY comes from a small Python helper rather than node-pty: a
 * native module would have to be rebuilt for Electron's ABI and is the usual
 * reason a packaged app fails to start. (`script` looks like the obvious
 * alternative, but it calls tcgetattr on its own stdin, which under Electron is
 * a pipe, and refuses to run.) Remote sessions get a genuine PTY from ssh2's
 * shell channel.
 *
 * The helper proxies stdin/stdout and takes "<cols> <rows>" lines on fd 3 so
 * the shell learns about resizes, which is what makes full-screen programs and
 * line editing behave.
 */
const PTY_HELPER = `
import os, sys, pty, fcntl, termios, struct, select, signal

cols, rows, shell = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3]
pid, fd = pty.fork()
if pid == 0:
    os.execvp(shell, [shell, '-i'])

def setsize(c, r):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', r, c, 0, 0))

NEWLINE = bytes([10])
setsize(cols, rows)
buf = b''
while True:
    try:
        rlist, _, _ = select.select([0, fd, 3], [], [])
    except (InterruptedError, OSError):
        break
    if fd in rlist:
        try:
            data = os.read(fd, 65536)
        except OSError:
            break
        if not data:
            break
        os.write(1, data)
    if 0 in rlist:
        data = os.read(0, 65536)
        if not data:
            break
        os.write(fd, data)
    if 3 in rlist:
        buf += os.read(3, 1024)
        while NEWLINE in buf:
            line, buf = buf.split(NEWLINE, 1)
            try:
                c, r = line.decode().split()
                setsize(int(c), int(r))
                os.kill(pid, signal.SIGWINCH)
            except Exception:
                pass
try:
    os.close(fd)
except OSError:
    pass
`

function pythonBinary(): string | null {
  for (const candidate of ['/usr/bin/python3', '/opt/homebrew/bin/python3', 'python3']) {
    if (candidate.startsWith('/') && !existsSync(candidate)) continue
    return candidate
  }
  return null
}

interface Session {
  id: string
  environmentId: string
  cwd: string
  kind: EnvironmentKind
  child?: ChildProcess
  /** fd 3 on the helper, used to push window sizes. */
  control?: NodeJS.WritableStream
  channel?: ClientChannel
  /** Replayed when a pane remounts, so switching tabs does not lose scrollback. */
  buffer: string
}

const sessions = new Map<string, Session>()
const BUFFER_CAP = 200_000

function push(session: Session, chunk: string): void {
  session.buffer = (session.buffer + chunk).slice(-BUFFER_CAP)
  bus.emit({ type: 'terminal.data', terminalId: session.id, chunk })
}

function close(session: Session, code: number | null): void {
  sessions.delete(session.id)
  bus.emit({ type: 'terminal.exit', terminalId: session.id, code: code ?? 0 })
}

export async function createTerminal(input: {
  environmentId: string
  cwd: string
  cols?: number
  rows?: number
}): Promise<{ id: string; buffer: string }> {
  const runtime = getRuntime(input.environmentId)
  await runtime.connect()

  const session: Session = {
    id: nanoid(10),
    environmentId: input.environmentId,
    cwd: input.cwd,
    kind: runtime.kind,
    buffer: ''
  }

  if (runtime instanceof SshRuntime) {
    const channel = await runtime.openShell({ cols: input.cols ?? 80, rows: input.rows ?? 24 })
    session.channel = channel
    channel.on('data', (data: Buffer) => push(session, data.toString('utf8')))
    channel.stderr.on('data', (data: Buffer) => push(session, data.toString('utf8')))
    channel.on('close', () => close(session, 0))
    channel.write(`cd ${JSON.stringify(input.cwd)} 2>/dev/null; clear\n`)
  } else {
    const shell = process.env.SHELL || '/bin/zsh'
    const python = pythonBinary()
    const cols = input.cols ?? 80
    const rows = input.rows ?? 24

    const child = python
      ? spawn(python, ['-c', PTY_HELPER, String(cols), String(rows), shell], {
          cwd: input.cwd,
          // The fourth stream is the resize channel the helper reads as fd 3.
          stdio: ['pipe', 'pipe', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'xterm-256color' }
        })
      : spawn(shell, ['-i'], {
          cwd: input.cwd,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: { ...process.env, TERM: 'dumb', COLUMNS: String(cols), LINES: String(rows) }
        })

    session.child = child
    session.control = (child.stdio[3] as NodeJS.WritableStream) ?? undefined
    if (!python) {
      push(
        session,
        '\r\n\x1b[38;5;179m[no python3 found, so this shell has no pty: prompts and ' +
          'full-screen programs will not render]\x1b[0m\r\n'
      )
    }
    child.stdout?.on('data', (data: Buffer) => push(session, data.toString('utf8')))
    child.stderr?.on('data', (data: Buffer) => push(session, data.toString('utf8')))
    child.on('close', (code) => close(session, code))
    child.on('error', (err) => {
      push(session, `\r\n[could not start a shell: ${err.message}]\r\n`)
      close(session, 1)
    })
  }

  sessions.set(session.id, session)
  return { id: session.id, buffer: session.buffer }
}

export function writeTerminal(id: string, data: string): void {
  const session = sessions.get(id)
  if (!session) return
  if (session.channel) session.channel.write(data)
  else session.child?.stdin?.write(data)
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = sessions.get(id)
  if (!session) return
  if (session.channel) {
    session.channel.setWindow(rows, cols, 0, 0)
    return
  }
  session.control?.write(`${cols} ${rows}\n`)
}

export function killTerminal(id: string): void {
  const session = sessions.get(id)
  if (!session) return
  session.channel?.close()
  session.child?.kill()
  sessions.delete(id)
}

export function terminalBuffer(id: string): string {
  return sessions.get(id)?.buffer ?? ''
}

export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id)
}
