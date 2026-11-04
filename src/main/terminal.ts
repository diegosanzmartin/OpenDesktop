import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { nanoid } from "nanoid";
import type { ClientChannel } from "ssh2";
import type { EnvironmentKind } from "@shared/types";
import { bus } from "./bus";
import { defaultShell } from "./shell-env";
import { getRuntime } from "./runtime";
import { SshRuntime } from "./runtime/ssh";

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
`;

function pythonBinary(): string | null {
  for (const candidate of [
    "/usr/bin/python3",
    "/opt/homebrew/bin/python3",
    "python3",
  ]) {
    if (candidate.startsWith("/") && !existsSync(candidate)) continue;
    return candidate;
  }
  return null;
}

interface Session {
  id: string;
  /**
   * Who asked for this shell, and the one thing that survives being remounted.
   *
   * The pane can move — it starts beside the chat and the panel can call it
   * down to the bottom — and remounting it must not open a second shell under
   * the same conversation, or replay a `clear` over scrollback that is still
   * wanted. A scope that asks again gets the shell it already has.
   */
  scope: string;
  environmentId: string;
  cwd: string;
  kind: EnvironmentKind;
  child?: ChildProcess;
  /** fd 3 on the helper, used to push window sizes. */
  control?: NodeJS.WritableStream;
  channel?: ClientChannel;
  /** Replayed when a pane remounts, so switching tabs does not lose scrollback. */
  buffer: string;
}

const sessions = new Map<string, Session>();
/** Scope to the id of the shell that scope is running, while it is running. */
const byScope = new Map<string, string>();
const BUFFER_CAP = 200_000;

function push(session: Session, chunk: string): void {
  session.buffer = (session.buffer + chunk).slice(-BUFFER_CAP);
  bus.emit({ type: "terminal.data", terminalId: session.id, chunk });
}

function close(session: Session, code: number | null): void {
  sessions.delete(session.id);
  if (byScope.get(session.scope) === session.id) byScope.delete(session.scope);
  bus.emit({ type: "terminal.exit", terminalId: session.id, code: code ?? 0 });
}

export async function createTerminal(input: {
  environmentId: string;
  cwd: string;
  cols?: number;
  rows?: number;
  /** Defaults to this folder: one shell per conversation per folder. */
  scope?: string;
}): Promise<{ id: string; buffer: string }> {
  const scope = input.scope || `${input.environmentId}:${input.cwd}`;

  // The same scope asking again is the same shell, handed back with whatever
  // it has printed since. This is what makes the pane survive being moved.
  const existingId = byScope.get(scope);
  const existing = existingId ? sessions.get(existingId) : undefined;
  if (existing) return { id: existing.id, buffer: existing.buffer };

  const runtime = getRuntime(input.environmentId);
  await runtime.connect();

  const session: Session = {
    id: nanoid(10),
    scope,
    environmentId: input.environmentId,
    cwd: input.cwd,
    kind: runtime.kind,
    buffer: "",
  };

  if (runtime instanceof SshRuntime) {
    const channel = await runtime.openShell({
      cols: input.cols ?? 80,
      rows: input.rows ?? 24,
    });
    session.channel = channel;
    channel.on("data", (data: Buffer) => push(session, data.toString("utf8")));
    channel.stderr.on("data", (data: Buffer) =>
      push(session, data.toString("utf8")),
    );
    channel.on("close", () => close(session, 0));
    channel.write(`cd ${JSON.stringify(input.cwd)} 2>/dev/null; clear\n`);
  } else {
    const shell = defaultShell();
    const python = pythonBinary();
    const cols = input.cols ?? 80;
    const rows = input.rows ?? 24;

    const child = python
      ? spawn(python, ["-c", PTY_HELPER, String(cols), String(rows), shell], {
          cwd: input.cwd,
          // The fourth stream is the resize channel the helper reads as fd 3.
          stdio: ["pipe", "pipe", "pipe", "pipe"],
          env: { ...process.env, TERM: "xterm-256color" },
        })
      : spawn(shell, ["-i"], {
          cwd: input.cwd,
          stdio: ["pipe", "pipe", "pipe"],
          env: {
            ...process.env,
            TERM: "dumb",
            COLUMNS: String(cols),
            LINES: String(rows),
          },
        });

    session.child = child;
    session.control = (child.stdio[3] as NodeJS.WritableStream) ?? undefined;
    if (!python) {
      push(
        session,
        "\r\n\x1b[38;5;179m[no python3 found, so this shell has no pty: prompts and " +
          "full-screen programs will not render]\x1b[0m\r\n",
      );
    }
    child.stdout?.on("data", (data: Buffer) =>
      push(session, data.toString("utf8")),
    );
    child.stderr?.on("data", (data: Buffer) =>
      push(session, data.toString("utf8")),
    );
    child.on("close", (code) => close(session, code));
    child.on("error", (err) => {
      push(session, `\r\n[could not start a shell: ${err.message}]\r\n`);
      close(session, 1);
    });
  }

  sessions.set(session.id, session);
  // Registered only once the shell exists: a scope that pointed at an id
  // nothing can answer for would hand back a dead terminal on the next mount.
  byScope.set(scope, session.id);
  return { id: session.id, buffer: session.buffer };
}

export function writeTerminal(id: string, data: string): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.channel) session.channel.write(data);
  else session.child?.stdin?.write(data);
}

export function resizeTerminal(id: string, cols: number, rows: number): void {
  const session = sessions.get(id);
  if (!session) return;
  if (session.channel) {
    session.channel.setWindow(rows, cols, 0, 0);
    return;
  }
  session.control?.write(`${cols} ${rows}\n`);
}

export function killTerminal(id: string): void {
  const session = sessions.get(id);
  if (!session) return;
  session.channel?.close();
  session.child?.kill();
  sessions.delete(id);
  if (byScope.get(session.scope) === id) byScope.delete(session.scope);
}

export function terminalBuffer(id: string): string {
  return sessions.get(id)?.buffer ?? "";
}

export function killAllTerminals(): void {
  for (const id of [...sessions.keys()]) killTerminal(id);
}
