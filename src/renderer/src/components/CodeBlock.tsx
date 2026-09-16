import clsx from 'clsx'
import { useState, type ReactNode } from 'react'
import { Check, Copy, Play, SquareTerminal } from 'lucide-react'
import { highlight, isShell, type TokenKind } from '@shared/highlight'
import { useStore } from '../state/store'

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
  const [copied, setCopied] = useState(false)

  const spans = highlight(code, lang)
  const runnable = isShell(code, lang)

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
            <Action title="Run this in the terminal" onClick={() => sendToTerminal(code, true)}>
              <Play className="h-3.5 w-3.5" />
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
    </div>
  )
}
