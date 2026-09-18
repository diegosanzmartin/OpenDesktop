import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, GitCommitVertical, History, RotateCw, UserRound } from 'lucide-react'
import type { ChangedFile } from '@shared/types'
import { onlyFile, type BlameLine, type Commit, type CommitDetail } from '@shared/history'
import { timeAgo } from '../lib/format'
import { useStore } from '../state/store'
import { DiffBody } from './DiffBody'

const STATUS_COLOR: Record<string, string> = {
  M: 'text-warn',
  A: 'text-ok',
  D: 'text-bad',
  R: 'text-info',
  U: 'text-violet'
}


/** A commit as one line: what it said, who, when. */
function CommitLine({
  commit,
  onPick,
  active
}: {
  commit: Commit
  onPick?: () => void
  active?: boolean
}): ReactNode {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!onPick}
      title={`${commit.hash}\n${commit.author}`}
      className={clsx(
        'flex w-full items-baseline gap-2 rounded px-1.5 py-[3px] text-left',
        onPick && 'hover:bg-ink-850',
        active && 'bg-ink-800'
      )}
    >
      {/* Two parents is a merge, which is worth seeing in a list that is
          otherwise a straight line. */}
      <GitCommitVertical
        className={clsx('h-3 w-3 shrink-0', commit.parents.length > 1 ? 'text-info' : 'text-ink-600')}
      />
      <span className="text-ink-600 shrink-0 font-mono text-[10.5px]">{commit.short}</span>
      <span className={clsx('min-w-0 flex-1 truncate text-[11.5px]', active ? 'text-ink-100' : 'text-ink-300')}>
        {commit.subject}
      </span>
      <span className="text-ink-700 shrink-0 text-[10.5px]">{timeAgo(commit.at)}</span>
    </button>
  )
}

function FileRow({
  file,
  commit
}: {
  file: ChangedFile
  /** Set when this row belongs to a commit rather than to the working tree. */
  commit?: string
}): ReactNode {
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeSessionId))
  const [open, setOpen] = useState(false)
  const [diff, setDiff] = useState<string | null>(null)
  /*
   * Two questions a diff cannot answer, one click each: what else has ever
   * happened to this file, and who put each line there. Both are loaded on
   * demand — blame on a large file is the expensive one and nobody wants it
   * by default.
   */
  const [aside, setAside] = useState<'none' | 'history' | 'blame'>('none')
  const [log, setLog] = useState<Commit[] | null>(null)
  const [blame, setBlame] = useState<BlameLine[] | null>(null)

  const toggle = async (): Promise<void> => {
    const next = !open
    setOpen(next)
    if (next && diff === null && session) {
      setDiff(
        commit
          ? onlyFile(
              (await window.opendesktop.history.commit(session.environmentId, session.cwd, commit))
                .diff,
              file.path
            )
          : await window.opendesktop.git.diff(
              session.environmentId,
              session.cwd,
              file.path,
              file.status === 'U'
            )
      )
    }
  }

  const showHistory = async (): Promise<void> => {
    setAside(aside === 'history' ? 'none' : 'history')
    if (log === null && session) {
      setLog(
        await window.opendesktop.history.log(session.environmentId, session.cwd, {
          path: file.path,
          limit: 20
        })
      )
    }
  }

  const showBlame = async (): Promise<void> => {
    setAside(aside === 'blame' ? 'none' : 'blame')
    if (blame === null && session) {
      setBlame(await window.opendesktop.history.blame(session.environmentId, session.cwd, file.path))
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
        <div className="border-ink-800 border-y">
          <div className="bg-ink-900 flex items-center gap-1 px-3 py-1">
            <button
              type="button"
              onClick={() => void showHistory()}
              className={clsx(
                'rounded px-1.5 py-[2px] text-[11px]',
                aside === 'history' ? 'bg-ink-800 text-ink-200' : 'text-ink-600 hover:text-ink-300'
              )}
            >
              <History className="mr-1 inline h-3 w-3" />
              history
            </button>
            {file.status !== 'U' ? (
              <button
                type="button"
                onClick={() => void showBlame()}
                className={clsx(
                  'rounded px-1.5 py-[2px] text-[11px]',
                  aside === 'blame' ? 'bg-ink-800 text-ink-200' : 'text-ink-600 hover:text-ink-300'
                )}
              >
                <UserRound className="mr-1 inline h-3 w-3" />
                who wrote it
              </button>
            ) : null}
          </div>

          {aside === 'history' ? (
            <div className="bg-ink-950 max-h-56 overflow-auto px-3 py-1.5">
              {log === null ? (
                <div className="text-ink-600 text-[11px]">Loading…</div>
              ) : log.length === 0 ? (
                <div className="text-ink-600 text-[11px]">No commits touch this file yet.</div>
              ) : (
                log.map((entry) => <CommitLine key={entry.hash} commit={entry} />)
              )}
            </div>
          ) : aside === 'blame' ? (
            <div className="bg-ink-950 max-h-56 overflow-auto py-1 font-mono text-[10.5px]">
              {blame === null ? (
                <div className="text-ink-600 px-3 text-[11px]">Loading…</div>
              ) : blame.length === 0 ? (
                <div className="text-ink-600 px-3 text-[11px]">Nothing committed yet.</div>
              ) : (
                blame.map((line) => (
                  <div key={line.line} className="flex gap-2 px-3 leading-[1.5]">
                    <span className="text-ink-600 w-[64px] shrink-0 truncate" title={`${line.author} · ${line.short}`}>
                      {line.author.split(' ')[0]}
                    </span>
                    <span className="text-ink-700 w-9 shrink-0 text-right">{line.line}</span>
                    <span className="text-ink-300 whitespace-pre-wrap break-all">{line.text}</span>
                  </div>
                ))
              )}
            </div>
          ) : null}

          <div className="bg-ink-950 max-h-96 overflow-auto">
            {diff === null ? (
              <div className="text-ink-600 px-3 py-2 text-[11px]">Loading…</div>
            ) : (
              <DiffBody text={diff} />
            )}
          </div>
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

  /*
   * Two halves of the same question. The working tree answers "what is
   * different from the last commit", which is only useful while you are the
   * one making the difference; the history answers "what happened before now",
   * which is how you find out what the agent did three turns ago. In a
   * conversation's own folder the history *is* the conversation — one commit
   * per turn, its subject the thing that was asked.
   */
  const [tab, setTab] = useState<'working' | 'history'>('working')
  const [log, setLog] = useState<Commit[] | null>(null)
  const [picked, setPicked] = useState<CommitDetail | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void refresh()
    setTab('working')
    setLog(null)
    setPicked(null)
  }, [session?.id, session?.cwd, refresh])

  const loadLog = async (): Promise<void> => {
    if (!session) return
    setBusy(true)
    setLog(await window.opendesktop.history.log(session.environmentId, session.cwd, { limit: 80 }))
    setBusy(false)
  }

  const pick = async (hash: string): Promise<void> => {
    if (!session) return
    if (picked?.commit?.hash === hash) return setPicked(null)
    setBusy(true)
    setPicked(await window.opendesktop.history.commit(session.environmentId, session.cwd, hash))
    setBusy(false)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-1.5 px-3 py-2">
        <span className="text-ink-200 shrink-0 text-[12px]">{changes?.branch ?? 'no branch'}</span>
        <button
          type="button"
          onClick={() => setTab('working')}
          className={clsx(
            'rounded px-1.5 py-[2px] text-[11.5px]',
            tab === 'working' ? 'bg-ink-800 text-ink-200' : 'text-ink-600 hover:text-ink-300'
          )}
        >
          working tree
          {changes && changes.files.length > 0 ? (
            <span className="ml-1.5 font-mono text-[10.5px]">
              <span className="text-ok">+{changes.added}</span>{' '}
              <span className="text-bad">-{changes.removed}</span>
            </span>
          ) : null}
        </button>
        <button
          type="button"
          onClick={() => {
            setTab('history')
            if (log === null) void loadLog()
          }}
          className={clsx(
            'rounded px-1.5 py-[2px] text-[11.5px]',
            tab === 'history' ? 'bg-ink-800 text-ink-200' : 'text-ink-600 hover:text-ink-300'
          )}
        >
          history
        </button>
        <button
          type="button"
          title="Refresh"
          onClick={() => (tab === 'history' ? void loadLog() : void refresh())}
          className="text-ink-600 hover:text-ink-200 ml-auto shrink-0 rounded p-1"
        >
          <RotateCw className={clsx('h-3.5 w-3.5', (loading || busy) && 'animate-spin')} />
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {!changes || !changes.isRepo ? (
          <div className="text-ink-600 flex h-full items-center justify-center px-6 text-center text-[12px]">
            {session
              ? 'No history here yet — the first turn starts one.'
              : 'No session.'}
          </div>
        ) : tab === 'working' ? (
          changes.files.length === 0 ? (
            <div className="text-ink-600 flex h-full items-center justify-center text-[12px]">
              No changes to show
            </div>
          ) : (
            changes.files.map((file) => <FileRow key={file.path} file={file} />)
          )
        ) : (
          <>
            <div className="border-ink-800 border-b px-1.5 py-1">
              {log === null ? (
                <div className="text-ink-600 px-1.5 py-1 text-[11.5px]">Loading…</div>
              ) : log.length === 0 ? (
                <div className="text-ink-600 px-1.5 py-1 text-[11.5px]">
                  Nothing committed yet.
                </div>
              ) : (
                log.map((entry) => (
                  <CommitLine
                    key={entry.hash}
                    commit={entry}
                    active={picked?.commit?.hash === entry.hash}
                    onPick={() => void pick(entry.hash)}
                  />
                ))
              )}
            </div>

            {picked?.commit ? (
              <div>
                <div className="px-3 py-2">
                  <div className="text-ink-100 text-[12.5px]">{picked.commit.subject}</div>
                  <div className="text-ink-600 mt-0.5 font-mono text-[10.5px]">
                    {picked.commit.short} · {picked.commit.author} ·{' '}
                    {new Date(picked.commit.at).toLocaleString('en-GB')}
                    {picked.commit.parents.length > 1 ? ' · merge' : ''}
                  </div>
                </div>
                {picked.files.length === 0 ? (
                  <div className="text-ink-600 px-3 pb-2 text-[11.5px]">
                    No files changed in this commit.
                  </div>
                ) : (
                  picked.files.map((file) => (
                    <FileRow key={file.path} file={file} commit={picked.commit?.hash} />
                  ))
                )}
              </div>
            ) : null}
          </>
        )}
      </div>
    </div>
  )
}
