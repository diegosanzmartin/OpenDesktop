import clsx from 'clsx'
import { useEffect, type ReactNode } from 'react'
import type { ApprovalRequest } from '@shared/types'
import { approvalDetail, approvalQuestion } from '@shared/approvals'
import { useStore } from '../state/store'

type Answer = 'once' | 'always' | 'reject'

/** A keycap, as in the reference: the shortcut is part of the button. */
function Key({ children }: { children: ReactNode }): ReactNode {
  return (
    <span className="bg-ink-700/70 text-ink-300 inline-flex h-[18px] min-w-[18px] items-center justify-center rounded px-1 font-sans text-[10.5px] leading-none">
      {children}
    </span>
  )
}

function Choice({
  label,
  keys,
  variant,
  onClick
}: {
  label: string
  keys: ReactNode
  variant: 'deny' | 'ghost' | 'primary'
  onClick: () => void
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] transition-colors',
        variant === 'primary'
          ? 'bg-ink-100 text-ink-950 hover:bg-white'
          : variant === 'deny'
            ? 'bg-ink-800 text-ink-200 hover:bg-ink-700'
            : 'bg-ink-800 text-ink-200 hover:bg-ink-700'
      )}
    >
      <span>{label}</span>
      <span className={clsx('flex items-center gap-1', variant === 'primary' && 'opacity-70')}>
        {keys}
      </span>
    </button>
  )
}

/**
 * The request for permission, as a decision rather than a form: the act in
 * plain words, exactly what will run, and three ways out — each with the key
 * that takes it, so a person who is watching never has to reach for the mouse.
 */
export function ApprovalCard({
  request,
  active = true
}: {
  request: ApprovalRequest
  active?: boolean
}): ReactNode {
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)

  const session = sessions.find((candidate) => candidate.id === request.sessionId)
  const agentName = (session && config?.agent[session.agentId]?.name) || 'the agent'

  const answer = (value: Answer): void => {
    void window.opendesktop.approvals.resolve(request.id, value)
  }

  // Only the request at the front of the queue listens, so a second one
  // stacked behind it cannot be resolved by a keystroke aimed at the first.
  useEffect(() => {
    if (!active) return
    const onKey = (event: KeyboardEvent): void => {
      const target = event.target as HTMLElement | null
      // Never steal a key from someone typing.
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

      if (event.key === 'Escape' || event.key === '1') {
        event.preventDefault()
        answer('reject')
      } else if (event.key === '2') {
        event.preventDefault()
        answer('always')
      } else if (event.key === '3') {
        event.preventDefault()
        answer('once')
      } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault()
        answer(event.shiftKey ? 'always' : 'once')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const isDiff = request.tool === 'edit' || request.tool === 'write'
  const body = request.preview ?? request.detail

  return (
    <div className="border-ink-700 bg-ink-900 overflow-hidden rounded-xl border">
      <div className="px-4 pt-3.5">
        <div className="text-ink-100 text-[14.5px] font-semibold leading-[1.4]">
          {approvalQuestion(request, agentName)}
        </div>
        <div className="text-ink-400 mt-1.5 text-[13px] leading-[1.5]">
          {approvalDetail(request)}
        </div>
      </div>

      <div className="px-4 pt-3">
        <div className="bg-ink-850 max-h-64 overflow-auto rounded-lg">
          {isDiff ? (
            <pre className="py-2 font-mono text-[11.5px] leading-[1.5]">
              {body.split('\n').map((line, index) => (
                <div
                  key={index}
                  className={clsx(
                    'px-3',
                    line.startsWith('+') && 'bg-ok/10 text-ok',
                    line.startsWith('-') && 'bg-bad/10 text-bad',
                    !line.startsWith('+') && !line.startsWith('-') && 'text-ink-400'
                  )}
                >
                  {line || ' '}
                </div>
              ))}
            </pre>
          ) : (
            <pre className="text-ink-300 px-3 py-2.5 font-mono text-[12px] leading-[1.6] whitespace-pre-wrap break-all">
              {body}
            </pre>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Choice
          label="Deny"
          variant="deny"
          onClick={() => answer('reject')}
          keys={
            <>
              <Key>1</Key>
              <Key>Esc</Key>
            </>
          }
        />
        <div className="ml-auto flex items-center gap-2">
          <Choice
            label="Always allow"
            variant="ghost"
            onClick={() => answer('always')}
            keys={
              <>
                <Key>2</Key>
                <Key>⇧</Key>
                <Key>⌘</Key>
                <Key>↵</Key>
              </>
            }
          />
          <Choice
            label="Allow once"
            variant="primary"
            onClick={() => answer('once')}
            keys={
              <>
                <Key>3</Key>
                <Key>⌘</Key>
                <Key>↵</Key>
              </>
            }
          />
        </div>
      </div>

      <div className="border-ink-800 text-ink-600 border-t px-4 py-2 font-mono text-[10.5px]">
        {request.environmentId} · {request.cwd}
      </div>
    </div>
  )
}
