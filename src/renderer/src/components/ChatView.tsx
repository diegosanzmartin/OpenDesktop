import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Check, Copy, FileText, GitBranch, RotateCcw } from 'lucide-react'
import type { Attachment, Block, Message, Session } from '@shared/types'
import { isManager } from '@shared/types'
import { useStore } from '../state/store'
import { timeAgo, tokens } from '../lib/format'
import { activityOf, duration, tokenRate } from '@shared/progress'
import { formatCost } from '@shared/cost'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { Mentions } from './Markdown'
import { EditedFiles, MessageParts } from './Transcript'
import { Markdown } from './Markdown'
import { usePreviewOpener } from './BlockCard'

const EMPTY_MESSAGES: Message[] = []

/** What was attached to a sent message; images keep a thumbnail. */
function SentAttachment({ attachment }: { attachment: Attachment }): ReactNode {
  const [preview, setPreview] = useState<string | null>(null)
  const openInBrowser = usePreviewOpener()

  useEffect(() => {
    if (attachment.kind !== 'image') return
    void window.opendesktop.files.previewUrl('local', attachment.path).then(setPreview)
  }, [attachment.kind, attachment.path])

  if (attachment.kind === 'image' && preview) {
    return (
      <button type="button" onClick={() => void openInBrowser('local', attachment.path)}>
        <img
          src={preview}
          alt={attachment.name}
          title={attachment.name}
          className="border-ink-700 max-h-44 rounded-lg border object-cover"
        />
      </button>
    )
  }

  return (
    <button
      type="button"
      onClick={() => void openInBrowser('local', attachment.path)}
      title={attachment.name}
      className="border-ink-700 bg-ink-850 hover:border-ink-600 flex items-center gap-1.5 rounded-lg border px-2 py-1"
    >
      <FileText className="text-ink-500 h-3.5 w-3.5" />
      <span className="max-w-[200px] truncate text-[11.5px]">{attachment.name}</span>
      <span className="text-ink-600 text-[10.5px]">{Math.max(1, Math.round(attachment.size / 1024))} KB</span>
    </button>
  )
}

/**
 * What can be done with a message, once it has been said.
 *
 * Shown on hover, under the message, because these are second thoughts rather
 * than part of reading: copy it, take it back, or keep this answer and try a
 * different question beside it.
 *
 * Rewind is the one with teeth. It removes this turn and everything after it
 * from both transcripts and puts what was typed back in the box, so the window
 * reads as though it never happened — which is only coherent when nothing is
 * in flight, so it is disabled while the model is working and says why.
 */
function MessageActions({
  session,
  message,
  align
}: {
  session: Session
  message: Message
  align: 'left' | 'right'
}): ReactNode {
  const rewindTo = useStore((s) => s.rewindTo)
  const forkFrom = useStore((s) => s.forkFrom)
  const [copied, setCopied] = useState(false)

  const busy = session.status === 'running' || session.status === 'awaiting-approval'
  const text = message.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')

  const action =
    'text-ink-600 hover:text-ink-200 disabled:hover:text-ink-700 rounded p-1 transition-colors disabled:cursor-default disabled:text-ink-700'

  return (
    <div
      className={clsx(
        'flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100',
        align === 'right' ? 'justify-end' : 'justify-start'
      )}
    >
      <span className="text-ink-600 mr-1 text-[11.5px]">{timeAgo(message.createdAt)}</span>
      <button
        type="button"
        title="Copy"
        className={action}
        onClick={() => {
          void navigator.clipboard.writeText(text).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })
        }}
      >
        {copied ? <Check className="text-ok h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
      <button
        type="button"
        disabled={busy}
        title={
          busy
            ? 'Rewind is unavailable while the model is working — stop it first'
            : 'Rewind to here: removes this turn and everything after it, and puts the message back in the box'
        }
        className={action}
        onClick={() => void rewindTo(session.id, message.id)}
      >
        <RotateCcw className="h-3.5 w-3.5" />
      </button>
      <button
        type="button"
        title="Fork from here: a copy of the conversation up to this point, leaving this one alone"
        className={action}
        onClick={() => void forkFrom(session.id, message.id)}
      >
        <GitBranch className="h-3.5 w-3.5" />
      </button>
    </div>
  )
}

function MessageRow({ message, session }: { message: Message; session: Session }): ReactNode {
  const blocks = useStore((s) => s.blocks)
  const config = useStore((s) => s.config)
  const agent =
    message.agentId && !isManager(message.agentId) ? config?.agent[message.agentId] : undefined

  if (message.role === 'user') {
    const text = message.parts.map((p) => p.text ?? '').join('')
    return (
      <div className="group flex flex-col items-end gap-1.5">
        {message.attachments && message.attachments.length > 0 ? (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {message.attachments.map((attachment) => (
              <SentAttachment key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}
        {text ? (
          <div className="bg-ink-800 text-ink-100 max-w-[80%] rounded-2xl px-3.5 py-2 text-[14px] leading-[1.6] whitespace-pre-wrap">
            {/* Not markdown — what the user typed, shown as typed — but an
                agent they named should read as the agent, here too. */}
            <Mentions text={text} />
          </div>
        ) : null}
        <MessageActions session={session} message={message} align="right" />
      </div>
    )
  }

  if (message.role === 'system') return <Notice message={message} />

  const allBlocks = message.parts
    .filter((p) => p.type === 'block' && p.blockId)
    .map((p) => blocks[p.blockId!])
    .filter(Boolean)

  return (
    <div className="group">
      <MessageParts message={message} />

      <EditedFiles blocks={allBlocks} />

      <StatusLine message={message} blocks={allBlocks} agentColor={agent?.color} agentName={agent?.name} />

      <MessageActions session={session} message={message} align="left" />
    </div>
  )
}

/**
 * Something the app did to the conversation, said out loud.
 *
 * Compaction is the case that matters: the model's memory of the early part of
 * a session gets replaced by a summary, and a session that silently forgets
 * what it decided is worse than one that says so. The summary is there to read
 * if you want to check what was kept.
 */
function Notice({ message }: { message: Message }): ReactNode {
  const [open, setOpen] = useState(false)
  const text = message.parts.map((part) => part.text ?? '').join('')
  const [headline, ...rest] = text.split('\n\n')
  const body = rest.join('\n\n')

  return (
    <div className="my-2">
      <div className="flex items-center gap-2">
        <span className="bg-ink-800 h-px flex-1" />
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="text-ink-600 hover:text-ink-400 shrink-0 text-[11.5px]"
          title={body ? 'Show what was kept' : undefined}
        >
          {headline}
          {body ? (open ? ' ▲' : ' ▾') : null}
        </button>
        <span className="bg-ink-800 h-px flex-1" />
      </div>
      {open && body ? (
        <div className="border-ink-800 text-ink-400 mt-2 rounded-lg border px-3 py-2 text-[12.5px]">
          <Markdown text={body} />
        </div>
      ) : null}
    </div>
  )
}

/**
 * The line under an assistant turn. While it runs it ticks: elapsed, the tokens
 * reported so far, the rate, and what it is doing. When it ends it settles into
 * the totals.
 */
function StatusLine({
  message,
  blocks,
  agentColor,
  agentName
}: {
  message: Message
  blocks: Block[]
  agentColor?: string
  agentName?: string
}): ReactNode {
  const done = Boolean(message.completedAt)
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    if (done) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [done])

  const seconds = Math.max(
    0,
    Math.round(((message.completedAt ?? now) - message.createdAt) / 1000)
  )
  const output = message.usage?.output ?? 0
  const total = (message.usage?.input ?? 0) + output
  // Only once there is enough of both for the number to mean anything.
  const rate = done ? null : tokenRate(output, seconds)

  return (
    <div className="text-ink-600 mt-2 flex flex-wrap items-center gap-x-2 text-[11.5px]">
      <span
        className={clsx('text-[13px]', !done && 'animate-pulse')}
        style={{ color: agentColor ?? 'var(--color-brand)' }}
      >
        ✳
      </span>
      <span>{duration(seconds)}</span>
      {total > 0 ? <span>· {tokens(total)} tokens</span> : null}
      {/* Absent when the model has no price declared: nothing, not "$0.00". */}
      {message.usage?.cost !== undefined ? <span>· {formatCost(message.usage.cost)}</span> : null}
      {rate !== null ? <span>· {rate} tok/s</span> : null}
      {/* The manager ran it, as it runs almost everything, so there is nothing
          worth saying: the line ends on the numbers. A named agent is the case
          where whose answer this is genuinely tells you something. */}
      {done ? (agentName ? <span>· {agentName}</span> : null) : (
        <span>· {activityOf(message, blocks)}</span>
      )}
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
            messages.map((message) => (
              <MessageRow key={message.id} message={message} session={session} />
            ))
          )}
          {approvals.map((request, index) => (
            <ApprovalCard key={request.id} request={request} active={index === 0} />
          ))}
        </div>
      </div>
      <Composer session={session} />
    </div>
  )
}
