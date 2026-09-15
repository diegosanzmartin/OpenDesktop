import clsx from 'clsx'
import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { ArrowUp, File, Folder, RotateCw } from 'lucide-react'
import type { FileEntry } from '@shared/types'
import { useStore } from '../state/store'
import { usePreviewOpener } from './BlockCard'
import { Button, Empty } from './ui'

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

export function FilesPane(): ReactNode {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const [path, setPath] = useState(session?.cwd ?? '')
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const openInBrowser = usePreviewOpener()

  const load = useCallback(
    async (target: string) => {
      if (!session) return
      setLoading(true)
      setError(null)
      try {
        const result = await window.opendesktop.files.list(session.environmentId, target)
        setPath(result.path)
        setEntries(result.entries)
      } catch (err) {
        setError((err as Error).message)
      } finally {
        setLoading(false)
      }
    },
    [session]
  )

  useEffect(() => {
    if (session) void load(session.cwd)
  }, [session?.id, session?.cwd, session?.environmentId, load])

  if (!session) return <Empty>No session selected.</Empty>

  const parent = path.replace(/\/+$/, '').split('/').slice(0, -1).join('/') || '/'

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-ink-800 bg-ink-900 flex items-center gap-1.5 border-b px-3 py-2">
        <Button size="sm" onClick={() => void load(parent)} title="Parent directory">
          <ArrowUp className="h-3.5 w-3.5" />
        </Button>
        <Button size="sm" onClick={() => void load(path)} title="Reload">
          <RotateCw className={clsx('h-3.5 w-3.5', loading && 'animate-spin')} />
        </Button>
        <input
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void load(path)
          }}
          className="border-ink-700 bg-ink-850 text-ink-200 focus:border-ink-600 min-w-0 flex-1 rounded border px-2 py-1 font-mono text-[11px] outline-none"
        />
        <span className="text-ink-600 shrink-0 text-[10px]">{session.environmentId}</span>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {error ? (
          <div className="text-bad px-3 py-3 font-mono text-[11px]">{error}</div>
        ) : entries.length === 0 ? (
          <Empty>Empty directory.</Empty>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              className="hover:bg-ink-850 group flex items-center gap-2 px-3 py-1"
              onDoubleClick={() => {
                if (entry.directory) void load(entry.path)
                else void openInBrowser(session.environmentId, entry.path)
              }}
            >
              {entry.directory ? (
                <Folder className="text-info h-3.5 w-3.5 shrink-0" />
              ) : (
                <File className="text-ink-500 h-3.5 w-3.5 shrink-0" />
              )}
              <button
                type="button"
                onClick={() =>
                  entry.directory
                    ? void load(entry.path)
                    : void openInBrowser(session.environmentId, entry.path)
                }
                className="text-ink-200 hover:text-brand min-w-0 flex-1 truncate text-left font-mono text-[11.5px]"
              >
                {entry.name}
                {entry.directory ? '/' : ''}
              </button>
              <span className="text-ink-600 shrink-0 text-[10px]">
                {entry.directory ? '' : size(entry.size)}
              </span>
              <span className="text-ink-700 w-20 shrink-0 text-right text-[10px]">
                {entry.modifiedAt
                  ? new Date(entry.modifiedAt).toLocaleDateString('en-GB', {
                      day: 'numeric',
                      month: 'short'
                    })
                  : ''}
              </span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
