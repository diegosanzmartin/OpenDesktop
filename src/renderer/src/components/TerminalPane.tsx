import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { useStore } from '../state/store'
import { terminalPayload } from '@shared/highlight'

const THEME = {
  background: '#1a1918',
  foreground: '#cfccc6',
  cursor: '#d97757',
  cursorAccent: '#1a1918',
  selectionBackground: 'rgba(217,119,87,0.28)',
  black: '#1a1918',
  red: '#cc6b5e',
  green: '#7fa88b',
  yellow: '#d3a84c',
  blue: '#6a9bcc',
  magenta: '#b08cc4',
  cyan: '#6fa8a0',
  white: '#cfccc6',
  brightBlack: '#6b6862',
  brightRed: '#e08b6d',
  brightGreen: '#93bd9f',
  brightYellow: '#e4bd61',
  brightBlue: '#82b0dd',
  brightMagenta: '#c6a3d8',
  brightWhite: '#ecebe8'
}

/**
 * A real shell in the dock. The PTY lives in the main process; this only ships
 * keystrokes up and paints bytes coming down.
 */
export function TerminalPane(): ReactNode {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const host = useRef<HTMLDivElement>(null)
  const term = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  /**
   * A command sent from a code block. The pane is mounted the moment the dock
   * opens, which is the same moment the command arrives, so the first one
   * always gets here before the PTY exists — it is held and flushed once the
   * terminal is up. The nonce is what stops a re-render replaying it.
   */
  const inject = useStore((s) => s.terminalInject)
  const consume = useStore((s) => s.consumeTerminalInject)
  const pending = useRef<{ text: string; run: boolean; nonce: number } | null>(null)
  // The shell echoes the paste markers literally until it has started its line
  // editor, so nothing is written before its first byte of output.
  const ready = useRef(false)

  const flush = (): void => {
    const next = pending.current
    if (!next || !idRef.current || !ready.current) return
    pending.current = null
    void window.opendesktop.terminal.write(idRef.current, terminalPayload(next.text, next.run))
    term.current?.focus()
    consume()
  }

  useEffect(() => {
    if (!inject) return
    pending.current = inject
    flush()
  }, [inject])

  const environmentId = session?.environmentId
  const cwd = session?.cwd

  useEffect(() => {
    if (!host.current || !environmentId || !cwd) return
    let disposed = false
    // A different host or folder is a different shell, which has not started.
    ready.current = false

    const terminal = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 12,
      lineHeight: 1.35,
      cursorBlink: true,
      allowProposedApi: true,
      theme: THEME,
      scrollback: 10_000
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(host.current)
    fitAddon.fit()

    term.current = terminal
    fit.current = fitAddon

    void window.opendesktop.terminal
      .create({
        environmentId,
        cwd,
        cols: terminal.cols,
        rows: terminal.rows
      })
      .then(({ id, buffer }) => {
        if (disposed) {
          void window.opendesktop.terminal.kill(id)
          return
        }
        idRef.current = id
        if (buffer) {
          terminal.write(buffer)
          // A terminal that is being reattached is already up and running.
          ready.current = true
        }
        terminal.onData((data) => void window.opendesktop.terminal.write(id, data))
        flush()
      })
      .catch((err: Error) => setError(err.message))

    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (idRef.current) {
          void window.opendesktop.terminal.resize(idRef.current, terminal.cols, terminal.rows)
        }
      } catch {
        /* the pane can be measured at zero while hidden */
      }
    })
    observer.observe(host.current)

    return () => {
      disposed = true
      observer.disconnect()
      if (idRef.current) void window.opendesktop.terminal.kill(idRef.current)
      idRef.current = null
      terminal.dispose()
      term.current = null
    }
  }, [environmentId, cwd])

  // Output arrives on the shared event bus, like everything else from main.
  useEffect(() => {
    return window.opendesktop.onEvent((event) => {
      if (event.type === 'terminal.data' && event.terminalId === idRef.current) {
        term.current?.write(event.chunk)
        // The shell has spoken, so it is listening.
        if (!ready.current) {
          ready.current = true
          flush()
        }
      }
      if (event.type === 'terminal.exit' && event.terminalId === idRef.current) {
        term.current?.write(`\r\n\x1b[38;5;242m[exited with code ${event.code}]\x1b[0m\r\n`)
        idRef.current = null
      }
    })
  }, [])

  if (!session) {
    return <div className="text-ink-600 flex h-full items-center justify-center text-[12px]">No session.</div>
  }

  return (
    <div className="relative min-h-0 flex-1">
      <div ref={host} className="h-full w-full" />
      {error ? (
        <div className="bg-ink-900 text-bad absolute inset-0 flex items-center justify-center px-6 text-center text-[12px]">
          {error}
        </div>
      ) : null}
    </div>
  )
}
