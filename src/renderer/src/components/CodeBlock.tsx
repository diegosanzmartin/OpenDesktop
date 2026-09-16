import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { Check, Copy, Loader2, Play, SquareTerminal, X } from 'lucide-react'
import { highlight, isShell, type TokenKind } from '@shared/highlight'
import { stripAnsi } from '../lib/format'
import { useStore } from '../state/store'

interface Result {
  stdout: string
  stderr: string
  exitCode: number
}

const COLOUR: Record<TokenKind, string> = {
  plain: 'text-ink-200',
  keyword: 'text-violet',
  string: 'text-ok',
  comment: 'text-ink-600 italic',
  number: 'text-warn',
  call: 'text-info'
}

function Action({
  title,
  onClick,
  children
}: {
  title: string
  onClick: () => void
  children: ReactNode
}): ReactNode {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      className="text-ink-500 hover:bg-ink-700 hover:text-ink-100 rounded p-1 transition-colors"
    >
      {children}
    </button>
  )
}

/**
 * A fenced block from the model's answer.
 *
 * Anything it prints that is meant to be run should be one keystroke from
 * running — copying a command out by hand is where a transcript stops being
 * useful. Run sends it to the terminal and presses return; the terminal button
 * pastes it without running, for when you want to change a flag first.
 */
export function CodeBlock({ code, lang }: { code: string; lang?: string }): ReactNode {
  const sendToTerminal = useStore((s) => s.sendToTerminal)
  const sessionId = useStore((s) => s.activeSessionId)
  const [copied, setCopied] = useState(false)
  const [running, setRunning] = useState(false)
  const [result, setResult] = useState<Result | null>(null)

  const spans = highlight(code, lang)
  const runnable = isShell(code, lang)

  const run = async (): Promise<void> => {
    if (!sessionId || running) return
    setRunning(true)
    setResult(null)
    try {
      setResult(await window.opendesktop.shell.run(sessionId, code))
    } catch (err) {
      setResult({ stdout: '', stderr: (err as Error).message, exitCode: 1 })
    } finally {
      setRunning(false)
    }
  }

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      /* a denied clipboard is not worth interrupting the transcript for */
    }
  }

  return (
    <div className="group/code relative my-2.5">
      <pre className="bg-ink-850 border-ink-800 overflow-x-auto rounded-lg border px-3 py-2.5 font-mono text-[12px] leading-[1.6]">
        {spans.map((span, index) => (
          <span key={index} className={COLOUR[span.kind]}>
            {span.text}
          </span>
        ))}
      </pre>

      <div
        // Always there, dimmed. Revealing them on hover would hide the whole
        // point of adding them: you cannot reach for a button you do not know
        // exists.
        className={clsx(
          'absolute right-1.5 top-1.5 flex items-center gap-0.5 rounded-md',
          'bg-ink-850/90 opacity-60 backdrop-blur-sm transition-opacity',
          'group-hover/code:opacity-100 focus-within:opacity-100'
        )}
      >
        {runnable ? (
          <>
            <Action title="Run it and show the output here" onClick={() => void run()}>
              {running ? (
                <Loader2 className="text-info h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="h-3.5 w-3.5" />
              )}
            </Action>
            <Action
              title="Put it in the terminal without running it"
              onClick={() => sendToTerminal(code, false)}
            >
              <SquareTerminal className="h-3.5 w-3.5" />
            </Action>
          </>
        ) : null}
        <Action title="Copy" onClick={() => void copy()}>
          {copied ? <Check className="text-ok h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </Action>
      </div>

      {running || result ? <Output running={running} result={result} onClear={() => setResult(null)} /> : null}
    </div>
  )
}

/**
 * What the command printed, under the command that printed it.
 *
 * Kept in the transcript rather than sent to the terminal pane, because the
 * reason to run a block from here is to see whether the thing the model just
 * told you actually holds — and that answer belongs next to the claim.
 */
function Output({
  running,
  result,
  onClear
}: {
  running: boolean
  result: Result | null
  onClear: () => void
}): ReactNode {
  const text = result ? stripAnsi([result.stdout, result.stderr].filter(Boolean).join('\n')) : ''
  const failed = (result?.exitCode ?? 0) !== 0

  return (
    <div
      className={clsx(
        'border-ink-800 bg-ink-900 mt-1 overflow-hidden rounded-lg border',
        failed && 'border-bad/40'
      )}
    >
      <div className="flex items-start gap-2 px-3 py-2">
        <pre
          className={clsx(
            'min-w-0 flex-1 overflow-x-auto font-mono text-[12px] leading-[1.6] whitespace-pre-wrap',
            failed ? 'text-bad' : 'text-ink-300'
          )}
        >
          {running ? 'running…' : text || '(no output)'}
        </pre>
        {running ? null : (
          <button
            type="button"
            title="Clear"
            onClick={onClear}
            className="text-ink-600 hover:text-ink-200 shrink-0 rounded p-0.5"
          >
            <X className="h-3 w-3" />
          </button>
        )}
      </div>
      {failed ? (
        <div className="border-ink-800 text-ink-500 border-t px-3 py-1 text-[10.5px]">
          exited with code {result?.exitCode}
        </div>
      ) : null}
    </div>
  )
}
