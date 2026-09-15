import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileText } from 'lucide-react'
import type { Attachment, Message, Session } from '@shared/types'
import { AUTO_AGENT } from '@shared/types'
import { useStore } from '../state/store'
import { tokens } from '../lib/format'
import { ApprovalCard } from './ApprovalCard'
import { Composer } from './Composer'
import { EditedFiles, MessageParts } from './Transcript'
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

function MessageRow({ message }: { message: Message }): ReactNode {
  const blocks = useStore((s) => s.blocks)
  const config = useStore((s) => s.config)
  const agent =
    message.agentId && message.agentId !== AUTO_AGENT ? config?.agent[message.agentId] : undefined

  if (message.role === 'user') {
    const text = message.parts.map((p) => p.text ?? '').join('')
    return (
      <div className="flex flex-col items-end gap-1.5">
        {message.attachments && message.attachments.length > 0 ? (
          <div className="flex max-w-[80%] flex-wrap justify-end gap-1.5">
            {message.attachments.map((attachment) => (
              <SentAttachment key={attachment.id} attachment={attachment} />
            ))}
          </div>
        ) : null}
        {text ? (
          <div className="bg-ink-800 text-ink-100 max-w-[80%] rounded-2xl px-3.5 py-2 text-[14px] leading-[1.6] whitespace-pre-wrap">
            {text}
          </div>
        ) : null}
      </div>
    )
  }

  const allBlocks = message.parts
    .filter((p) => p.type === 'block' && p.blockId)
    .map((p) => blocks[p.blockId!])
    .filter(Boolean)

  const elapsed = message.completedAt ? Math.round((message.completedAt - message.createdAt) / 1000) : null
  const totalTokens = (message.usage?.input ?? 0) + (message.usage?.output ?? 0)

  return (
    <div>
      <MessageParts message={message} />

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
            <span>· {agent?.name ?? 'Auto'}</span>
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
