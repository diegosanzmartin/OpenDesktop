import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ChevronRight, TriangleAlert } from 'lucide-react'
import type { Block, Message, MessagePart, Session } from '@shared/types'
import { useStore } from '../state/store'
import { tokens } from '../lib/format'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { EditedFiles, ToolGroup } from './ToolGroup'
import { Markdown } from './Markdown'

const EMPTY_MESSAGES: Message[] = []

function Reasoning({ text }: { text: string }): ReactNode {
  const [open, setOpen] = useState(false)
  return (
    <div className="my-1">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="group flex items-center gap-1.5 py-[3px] text-left"
      >
        <span className="text-ink-500 group-hover:text-ink-300 text-[13.5px] italic">Thought for a moment</span>
        <ChevronRight
          className={clsx(
            'text-ink-600 h-3.5 w-3.5 transition-transform',
            open && 'rotate-90'
          )}
        />
      </button>
      {open ? (
        <div className="border-ink-800 text-ink-400 mt-1 border-l pl-3 text-[13px] leading-[1.65] whitespace-pre-wrap italic">
          {text}
        </div>
      ) : null}
    </div>
  )
}

/** Consecutive tool calls collapse into one summary line. */
type Chunk = { kind: 'parts'; parts: MessagePart[] } | { kind: 'tools'; blocks: Block[] }

function chunkParts(parts: MessagePart[], blocks: Record<string, Block>): Chunk[] {
  const out: Chunk[] = []
  for (const part of parts) {
    if (part.type === 'block') {
      const block = part.blockId ? blocks[part.blockId] : undefined
      if (!block) continue
      const last = out[out.length - 1]
      if (last && last.kind === 'tools') last.blocks.push(block)
      else out.push({ kind: 'tools', blocks: [block] })
    } else {
      const last = out[out.length - 1]
      if (last && last.kind === 'parts') last.parts.push(part)
      else out.push({ kind: 'parts', parts: [part] })
    }
  }
  return out
}

function MessageRow({ message }: { message: Message }): ReactNode {
  const blocks = useStore((s) => s.blocks)
  const config = useStore((s) => s.config)
  const agent = message.agentId ? config?.agent[message.agentId] : undefined

  if (message.role === 'user') {
    const text = message.parts.map((p) => p.text ?? '').join('')
    return (
      <div className="flex justify-end">
        <div className="bg-ink-800 text-ink-100 max-w-[80%] rounded-2xl px-3.5 py-2 text-[14px] leading-[1.6] whitespace-pre-wrap">
          {text}
        </div>
      </div>
    )
  }

  const chunks = chunkParts(message.parts, blocks)
  const allBlocks = message.parts
    .filter((p) => p.type === 'block' && p.blockId)
    .map((p) => blocks[p.blockId!])
    .filter(Boolean)

  const elapsed = message.completedAt ? Math.round((message.completedAt - message.createdAt) / 1000) : null
  const totalTokens = (message.usage?.input ?? 0) + (message.usage?.output ?? 0)

  return (
    <div>
      {chunks.map((chunk, index) =>
        chunk.kind === 'tools' ? (
          <ToolGroup key={index} blocks={chunk.blocks} />
        ) : (
          <div key={index} className="space-y-2 py-1">
            {chunk.parts.map((part, partIndex) => {
              if (part.type === 'reasoning') {
                return part.text?.trim() ? <Reasoning key={partIndex} text={part.text} /> : null
              }
              if (part.type === 'error') {
                return (
                  <div
                    key={partIndex}
                    className="border-bad/40 bg-bad/10 text-bad flex items-start gap-2 rounded-lg border px-3 py-2 text-[13px]"
                  >
                    <TriangleAlert className="mt-[3px] h-3.5 w-3.5 shrink-0" />
                    <span className="whitespace-pre-wrap">{part.text}</span>
                  </div>
                )
              }
              return part.text?.trim() ? <Markdown key={partIndex} text={part.text} /> : null
            })}
          </div>
        )
      )}

      <EditedFiles blocks={allBlocks} />

      <div className="text-ink-600 mt-2 flex items-center gap-2 text-[11.5px]">
        <span
          className={clsx('text-[13px]', !message.completedAt && 'animate-pulse')}
          style={{ color: agent?.color ?? 'var(--color-brand)' }}
        >
          ✳
        </span>
        {message.completedAt ? (
          <>
            {elapsed !== null ? (
              <span>
                {elapsed >= 60 ? `${Math.floor(elapsed / 60)}m ${elapsed % 60}s` : `${elapsed}s`}
              </span>
            ) : null}
            {totalTokens > 0 ? <span>· {tokens(totalTokens)} tokens</span> : null}
            {agent ? <span>· {agent.name}</span> : null}
          </>
        ) : (
          <span>Working…</span>
        )}
      </div>
    </div>
  )
}

export function ChatView({ session }: { session: Session }): ReactNode {
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
        className="min-h-0 flex-1 overflow-y-auto px-6 py-5"
      >
        <div className="mx-auto max-w-[760px] space-y-6">
          {messages.length === 0 ? (
            <div className="text-ink-500 py-20 text-center">
              <div className="text-ink-300 mb-1.5 text-[16px]">Ready when you are.</div>
              <div className="text-[13px]">
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
