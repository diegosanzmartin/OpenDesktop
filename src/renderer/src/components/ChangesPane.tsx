import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, RotateCw } from 'lucide-react'
import type { ChangedFile } from '@shared/types'
import { useStore } from '../state/store'
import { DiffBody } from './DiffBody'

const STATUS_COLOR: Record<string, string> = {
  M: 'text-warn',
  A: 'text-ok',
  D: 'text-bad',
  R: 'text-info',
  U: 'text-violet'
}

function FileRow({ file }: { file: ChangedFile }): ReactNode {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)

  const toggle = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (next && diff === null && session) {
      setDiff(
        await window.opendesktop.git.diff(
          session.environmentId,
          session.cwd,
          file.path,
          file.status === 'U'
        )
      )
    }
  }

  const name = file.path.split('/').pop() ?? file.path
  const dir = file.path.slice(0, file.path.length - name.length)

  return (
    <div>
      <button
        type="button"
        onClick={() => void toggle()}
        className="hover:bg-ink-850 flex w-full items-center gap-2 px-3 py-[5px] text-left"
      >
        {open ? (
          <ChevronDown className="text-ink-600 h-3 w-3 shrink-0" />
        ) : (
          <ChevronRight className="text-ink-600 h-3 w-3 shrink-0" />
        )}
        <span className={clsx('w-3 shrink-0 font-mono text-[10px]', STATUS_COLOR[file.status] ?? 'text-ink-500')}>
          {file.status}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[11.5px]">
          {dir ? <span className="text-ink-600">{dir}</span> : null}
          <span className="text-ink-200">{name}</span>
        </span>
        {file.added > 0 ? <span className="text-ok shrink-0 font-mono text-[10.5px]">+{file.added}</span> : null}
        {file.removed > 0 ? (
          <span className="text-bad shrink-0 font-mono text-[10.5px]">-{file.removed}</span>
        ) : null}
      </button>
      {open ? (
        <div className="border-ink-800 bg-ink-950 max-h-96 overflow-auto border-y">
          {diff === null ? (
            <div className="text-ink-600 px-3 py-2 text-[11px]">Loading…</div>
          ) : (
            <DiffBody text={diff} />
          )}
        </div>
      ) : null}
    </div>
  )
}

export function ChangesPane(): ReactNode {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const changes = useStore((s) => s.changes)
  const loading = useStore((s) => s.changesLoading)
  const refresh = useStore((s) => s.refreshChanges)

  useEffect(() => {
    void refresh()
  }, [session?.id, session?.cwd, refresh])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="text-ink-200 text-[12px]">{changes?.branch ?? 'no branch'}</span>
        <span className="text-ink-600 text-[12px]">→</span>
        <span className="text-ink-400 text-[12px]">working tree</span>
        {changes && changes.files.length > 0 ? (
          <span className="ml-1 flex items-center gap-1.5 font-mono text-[10.5px]">
            <span className="text-ok">+{changes.added}</span>
            <span className="text-bad">-{changes.removed}</span>
          </span>
        ) : null}
        <button
          type="button"
          title="Refresh"
          onClick={() => void refresh()}
          className="text-ink-600 hover:text-ink-200 ml-auto rounded p-1"
        >
          <RotateCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!changes || !changes.isRepo ? (
          <div className="text-ink-600 flex h-full items-center justify-center px-6 text-center text-[12px]">
            {session ? `${session.cwd} is not a git repository.` : 'No session.'}
          </div>
        ) : changes.files.length === 0 ? (
          <div className="text-ink-600 flex h-full items-center justify-center text-[12px]">
            No changes to show
          </div>
        ) : (
          changes.files.map((file) => <FileRow key={file.path} file={file} />)
        )}
      </div>
    </div>
  )
}
