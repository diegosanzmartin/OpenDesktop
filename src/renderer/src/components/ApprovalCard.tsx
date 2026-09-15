import clsx from 'clsx'
import type { ReactNode } from 'react'
import { ShieldQuestion } from 'lucide-react'
import type { ApprovalRequest } from '@shared/types'
import { TOOL_LABEL } from '../lib/format'
import { Button } from './ui'

export function ApprovalCard({ request }: { request: ApprovalRequest }): ReactNode {
  const answer = (value: 'once' | 'always' | 'reject'): void => {
    void window.opendesktop.approvals.resolve(request.id, value)
  }

  const isDiff = request.tool === 'edit' || request.tool === 'write'

  return (
    <div className="border-warn/50 bg-warn/5 overflow-hidden rounded-lg border">
      <div className="flex items-center gap-2 px-3 py-2">
        <ShieldQuestion className="text-warn h-4 w-4 shrink-0" />
        <span className="text-ink-100 text-[12px] font-semibold">
          Allow {TOOL_LABEL[request.tool]?.toLowerCase() ?? request.tool}?
        </span>
        <span className="text-ink-500 ml-auto font-mono text-[10px]">
          {request.environmentId} · {request.cwd}
        </span>
      </div>

      {request.preview ? (
        <div className="border-ink-700 bg-ink-900 max-h-64 overflow-auto border-y">
          {isDiff ? (
            <pre className="font-mono text-[11px] leading-[1.5]">
              {request.preview.split('\n').map((line, index) => (
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
            <pre className="text-ink-200 px-3 py-2 font-mono text-[11.5px] whitespace-pre-wrap break-all">
              {request.tool === 'bash' ? <span className="text-brand">$ </span> : null}
              {request.preview}
            </pre>
          )}
        </div>
      ) : (
        <div className="border-ink-700 text-ink-300 border-y px-3 py-2 font-mono text-[11.5px]">
          {request.detail}
        </div>
      )}

      <div className="flex items-center gap-2 px-3 py-2">
        <Button variant="primary" onClick={() => answer('once')}>
          Allow once
        </Button>
        <Button variant="outline" onClick={() => answer('always')}>
          Allow for this session
        </Button>
        <Button variant="danger" onClick={() => answer('reject')}>
          Reject
        </Button>
        <span className="text-ink-600 ml-auto text-[10px]">
          Set permissions per agent in Settings to stop being asked.
        </span>
      </div>
    </div>
  )
}
