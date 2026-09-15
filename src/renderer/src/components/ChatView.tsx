import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Brain, ChevronDown, ChevronRight, TriangleAlert } from 'lucide-react'
import type { Message, Session } from '@shared/types'
import { useStore } from '../state/store'
import { clockTime, tokens } from '../lib/format'
import { BlockCard } from './BlockCard'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'

const EMPTY_MESSAGES: Message[] = []

function Markdownish({ text }: { text: string }): ReactNode {
  // Deliberately minimal: fenced code, inline code, bold and bullets cover
  // everything a coding agent actually emits, without pulling in a parser.
  const segments = useMemo(() => text.split(/```/), [text])
  return (
    <div className="space-y-2">
      {segments.map((segment, index) =>
        index % 2 === 1 ? (
          <pre
            key={index}
            className="bg-ink-900 border-ink-700 text-ink-200 overflow-x-auto rounded-md border px-3 py-2 font-mono text-[11.5px] leading-[1.55]"
          >
            {segment.replace(/^[a-zA-Z0-9+-]*\n/, '')}
          </pre>
        ) : (
          <div key={index} className="whitespace-pre-wrap text-[13px] leading-[1.6]">
            {segment.split('\n').map((line, lineIndex) => (
              <div key={lineIndex} className={clsx(/^\s*[-*]\s/.test(line) && 'pl-3')}>
                {renderInline(line)}
              </div>
            ))}
          </div>
        )
      )}
    </div>
  )
}

function renderInline(line: string): ReactNode {
  const parts = line.split(/(`[^`]+`|\*\*[^*]+\*\*)/g)
  return parts.map((part, index) => {
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code key={index} className="bg-ink-800 text-brand rounded px-1 py-[1px] font-mono text-[11.5px]">
          {part.slice(1, -1)}
        </code>
      )
    }
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return (
        <strong key={index} className="text-ink-100 font-semibold">
          {part.slice(2, -2)}
        </strong>
      )
    }
    return <span key={index}>{part}</span>
  })
}

function Reasoning({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="border-ink-700 bg-ink-850/60 overflow-hidden rounded-md border">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="hover:bg-ink-800 flex w-full items-center gap-2 px-2.5 py-1.5 text-left"
      >
        {open ? (
          <ChevronDown className="text-ink-500 h-3 w-3" />
        ) : (
          <ChevronRight className="text-ink-500 h-3 w-3" />
        )}
        <Brain className="text-violet h-3.5 w-3.5" />
        <span className="text-ink-400 text-[11px]">Thinking</span>
        <span className="text-ink-600 ml-auto text-[10px]">{text.length} chars</span>
      </button>
      {open ? (
        <div className="border-ink-700 text-ink-400 border-t px-3 py-2 text-[11.5px] leading-[1.6] whitespace-pre-wrap italic">
          {text}
        </div>
      ) : null}
    </div>
  )
}

function MessageRow({ message }: { message: Message }): ReactNode {
  const blocks = useStore((s) => s.blocks)
  const config = useStore((s) => s.config)
  const agent = message.agentId ? config?.agent[message.agentId] : undefined

  if (message.role === 'user') {
    const text = message.parts.map((p) => p.text ?? '').join('')
    return (
      <div className="flex justify-end">
        <div className="bg-ink-800 border-ink-700 max-w-[78%] rounded-lg border px-3 py-2">
          <div className="text-ink-100 text-[13px] leading-[1.6] whitespace-pre-wrap">{text}</div>
          <div className="text-ink-600 mt-1 text-right text-[10px]">{clockTime(message.createdAt)}</div>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        <span
          className="h-1.5 w-1.5 rounded-full"
          style={{ background: agent?.color ?? 'var(--color-brand)' }}
        />
        <span className="text-ink-400 text-[11px] font-semibold">{agent?.name ?? 'Assistant'}</span>
        <span className="text-ink-600 font-mono text-[10px]">{message.model}</span>
        {message.usage ? (
          <span className="text-ink-600 text-[10px]">
            {tokens(message.usage.input)} in · {tokens(message.usage.output)} out
          </span>
        ) : null}
        <span className="text-ink-600 ml-auto text-[10px]">{clockTime(message.createdAt)}</span>
      </div>

      <div className="space-y-2 pl-3.5">
        {message.parts.map((part, index) => {
          if (part.type === 'block') {
            const block = part.blockId ? blocks[part.blockId] : undefined
            return block ? <BlockCard key={`${part.blockId}-${index}`} block={block} /> : null
          }
          if (part.type === 'reasoning') {
            return part.text?.trim() ? <Reasoning key={index} text={part.text} /> : null
          }
          if (part.type === 'error') {
            return (
              <div
                key={index}
                className="border-bad/40 bg-bad/10 text-bad flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]"
              >
                <TriangleAlert className="mt-[2px] h-3.5 w-3.5 shrink-0" />
                <span className="whitespace-pre-wrap">{part.text}</span>
              </div>
            )
          }
          return part.text?.trim() ? (
            <div key={index} className="text-ink-100">
              <Markdownish text={part.text} />
            </div>
          ) : null
        })}
      </div>
    </div>
  )
}

export function ChatView({ session }: { session: Session }): ReactNode {
  // Selectors must return stable references: zustand compares by identity, so
  // building an array inside the selector re-renders forever.
  const allMessages = useStore((s) => s.messages)
  const allApprovals = useStore((s) => s.approvals)
  const messages = allMessages[session.id] ?? EMPTY_MESSAGES
  const approvals = useMemo(
    () => allApprovals.filter((a) => a.sessionId === session.id),
    [allApprovals, session.id]
  )
  const scroller = useRef<HTMLDivElement>(null)
  const pinned = useRef(true)

  useEffect(() => {
    const el = scroller.current
    if (el && pinned.current) el.scrollTop = el.scrollHeight
  }, [messages, approvals])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget
          pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
        className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
      >
        <div className="mx-auto max-w-3xl space-y-5">
          {messages.length === 0 ? (
            <div className="text-ink-500 py-16 text-center">
              <div className="text-ink-300 mb-1 text-[15px]">Ready when you are.</div>
              <div className="text-[12px]">
                Commands run in <span className="font-mono">{session.cwd}</span> on{' '}
                <span className="font-mono">{session.environmentId}</span>.
              </div>
            </div>
          ) : (
            messages.map((message) => <MessageRow key={message.id} message={message} />)
          )}
          {approvals.map((request) => (
            <ApprovalCard key={request.id} request={request} />
          ))}
        </div>
      </div>
      <Composer session={session} />
    </div>
  )
}
