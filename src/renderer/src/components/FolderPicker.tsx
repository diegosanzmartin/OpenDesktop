import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Clock, Folder, FolderOpen, Home, RefreshCw, Search, X } from 'lucide-react'
import { fuzzyFilter, highlightRuns, type Match } from '@shared/fuzzy'
import {
  filterRecent,
  folderLabel,
  parentOf,
  recentFor
} from '@shared/recent'
import { useStore, type FolderPickerMode } from '../state/store'

/**
 * Choosing a working directory on a machine that is not this one.
 *
 * The native picker cannot see an SSH host or a workstation, so clicking the
 * folder on a remote session used to do nothing at all. This is the
 * replacement, and it is the picker for every session — one behaviour to learn
 * — with `Browse…` handing over to the OS dialog when the target happens to be
 * this machine.
 *
 * Three ways to use it, because three different things are being done:
 *
 * - **Browse**, when the shape of the tree is the point: step through it, or
 *   type a path and go. What a file dialog has always been. ⌘O.
 * - **Search**, when the name is known and the path is not. Every directory
 *   under the home folder, fetched once and filtered as you type, fzf-style.
 *   The faster way to a folder six levels down. ⌘⇧O.
 * - **Recent**, when the folder is one you were already in — which is most of
 *   the time, because work clusters around a handful of trees. A short list,
 *   searchable, with an × on each row to forget it. ⌘R.
 */

/** A path, split for the breadcrumb, with the absolute path of each part. */
function crumbs(path: string): { name: string; path: string }[] {
  const parts = path.split('/').filter(Boolean)
  return parts.map((name, index) => ({ name, path: `/${parts.slice(0, index + 1).join('/')}` }))
}

function Highlighted({ match }: { match: Match }): ReactNode {
  return (
    <>
      {highlightRuns(match.value, match.positions).map((run, index) => (
        <span key={index} className={run.hit ? 'text-brand' : undefined}>
          {run.text}
        </span>
      ))}
    </>
  )
}

export function FolderPicker(): ReactNode {
  const request = useStore((s) => s.folderPicker)
  const close = useStore((s) => s.closeFolderPicker)
  const sessions = useStore((s) => s.sessions)
  const session = useMemo(
    () => sessions.find((entry) => entry.id === request?.sessionId),
    [sessions, request?.sessionId]
  )

  const [mode, setMode] = useState<FolderPickerMode>('browse')
  const [path, setPath] = useState('')
  const [typed, setTyped] = useState('')
  const [listing, setListing] = useState<{
    path: string
    home: string
    parent: string | null
    dirs: string[]
    error?: string
  } | null>(null)
  const [busy, setBusy] = useState(false)

  const [query, setQuery] = useState('')
  const [index, setIndex] = useState<{ dirs: string[]; root: string; truncated: boolean } | null>(
    null
  )
  const [indexing, setIndexing] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [recentQuery, setRecentQuery] = useState('')
  const config = useStore((s) => s.config)
  const remember = useStore((s) => s.rememberFolder)
  const forget = useStore((s) => s.forgetFolder)
  const recentInput = useRef<HTMLInputElement>(null)

  const pathInput = useRef<HTMLInputElement>(null)
  const searchInput = useRef<HTMLInputElement>(null)
  const results = useRef<HTMLDivElement>(null)

  const environmentId = session?.environmentId ?? 'local'

  const go = useCallback(
    async (to: string) => {
      setBusy(true)
      try {
        const next = await window.opendesktop.files.browse(environmentId, to)
        setListing(next)
        setPath(next.path)
      } finally {
        setBusy(false)
      }
    },
    [environmentId]
  )

  // Opening: start where the session is, and in whichever mode was asked for.
  useEffect(() => {
    if (!request || !session) return
    setMode(request.mode)
    setQuery('')
    setRecentQuery('')
    setCursor(0)
    setTyped(session.cwd)
    setPath(session.cwd)
    void go(session.cwd)
  }, [request, session, go])

  /**
   * The candidate list, fetched when search is first opened rather than when
   * the dialog is. Browsing is the cheaper half and should never wait for a
   * whole tree it may not need.
   */
  const loadIndex = useCallback(
    async (refresh = false) => {
      if (!session) return
      setIndexing(true)
      try {
        const next = await window.opendesktop.files.findDirs(
          environmentId,
          session.cwd,
          refresh
        )
        setIndex(next)
      } finally {
        setIndexing(false)
      }
    },
    [environmentId, session]
  )

  useEffect(() => {
    if (mode !== 'search') return
    if (!index && !indexing) void loadIndex()
    searchInput.current?.focus()
  }, [mode, index, indexing, loadIndex])

  useEffect(() => {
    if (mode === 'browse') pathInput.current?.focus()
    if (mode === 'recent') recentInput.current?.focus()
  }, [mode])

  const matches = useMemo(
    () => (index ? fuzzyFilter(index.dirs, query, 300) : []),
    [index, query]
  )

  useEffect(() => {
    setCursor(0)
  }, [query])

  // Keep the highlighted row in view when it moves by keyboard.
  useEffect(() => {
    if (mode !== 'search') return
    results.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [cursor, mode, matches.length])

  // In recent mode nothing is highlighted until one is clicked, so the footer
  // shows the folder the conversation is in — what "Select folder" would keep.
  const recentList = recentFor(config?.recentFolders, environmentId)
  const shownRecent = filterRecent(recentList, recentQuery)
  const chosen =
    mode === 'search' ? (matches[cursor]?.value ?? path) : mode === 'recent' ? path : path

  /**
   * Taking a folder is also the moment to remember it: the list is built from
   * the folders people chose, not from the ones they looked at, or it fills up
   * with every directory somebody wandered through on the way.
   */
  const commit = useCallback(
    (to: string) => {
      if (!session || !to) return
      void window.opendesktop.sessions.update(session.id, { cwd: to })
      void remember(session.environmentId, to)
      close()
    },
    [session, close, remember]
  )

  useEffect(() => {
    if (!request) return
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault()
        // In search, Escape steps back to browsing first: one key, two
        // thoughts — "not this search" before "not this folder".
        if (mode === 'search' || mode === 'recent') setMode('browse')
        else close()
        return
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault()
        setMode('recent')
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [request, mode, close])

  if (!request || !session) return null

  const remote = environmentId !== 'local'

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 p-10">
      <div className="border-ink-700 bg-ink-900 flex h-full max-h-[640px] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border shadow-2xl">
        <div className="flex items-center gap-3 px-5 pt-4">
          <h2 className="text-ink-100 flex-1 text-[19px] font-semibold">
            {remote ? 'Select remote folder' : 'Select folder'}
          </h2>
          <div className="bg-ink-850 flex gap-0.5 rounded-lg p-0.5">
            {(['browse', 'recent', 'search'] as const).map((id) => (
              <button
                key={id}
                type="button"
                onClick={() => setMode(id)}
                className={clsx(
                  'flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px] transition-colors',
                  mode === id ? 'bg-ink-700 text-ink-100' : 'text-ink-400 hover:text-ink-200'
                )}
              >
                {id === 'browse' ? (
                  <FolderOpen className="h-3.5 w-3.5" />
                ) : id === 'recent' ? (
                  <Clock className="h-3.5 w-3.5" />
                ) : (
                  <Search className="h-3.5 w-3.5" />
                )}
                {id === 'browse' ? 'Browse' : id === 'recent' ? 'Recent' : 'Search'}
              </button>
            ))}
          </div>
          <button
            type="button"
            title="Close"
            onClick={close}
            className="text-ink-500 hover:bg-ink-800 hover:text-ink-100 rounded-md p-1.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="text-ink-600 px-5 pb-2 pt-1 text-[11.5px]">
          {session.environmentId} ·{' '}
          {mode === 'search'
            ? `under ${index?.root ?? '…'}`
            : mode === 'recent'
              ? `${recentFor(config?.recentFolders, session.environmentId).length} remembered`
              : path}
        </div>

        {mode === 'browse' ? (
          <>
            <div className="flex items-center gap-2 px-5">
              <input
                ref={pathInput}
                value={typed}
                spellCheck={false}
                onChange={(event) => setTyped(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void go(typed)
                }}
                placeholder="/home/user/work"
                className="border-brand bg-ink-850 text-ink-100 placeholder:text-ink-600 min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-[13px] outline-none"
              />
              <button
                type="button"
                onClick={() => void go(typed)}
                className="bg-ink-800 text-ink-200 hover:bg-ink-700 rounded-lg px-3 py-2 text-[12.5px]"
              >
                Go
              </button>
            </div>

            <div className="flex items-center gap-1 overflow-x-auto px-5 py-2.5">
              <button
                type="button"
                title={listing?.home}
                onClick={() => void go(listing?.home ?? '~')}
                className="text-ink-400 hover:text-ink-100 shrink-0 rounded p-1"
              >
                <Home className="h-3.5 w-3.5" />
              </button>
              {crumbs(path).map((crumb) => (
                <span key={crumb.path} className="flex shrink-0 items-center">
                  <span className="text-ink-700 px-1">›</span>
                  <button
                    type="button"
                    onClick={() => {
                      setTyped(crumb.path)
                      void go(crumb.path)
                    }}
                    className="text-ink-300 hover:text-ink-100 max-w-[180px] truncate text-[13px]"
                  >
                    {crumb.name}
                  </button>
                </span>
              ))}
            </div>

            <div className="border-ink-800 mx-5 min-h-0 flex-1 overflow-y-auto rounded-lg border">
              {listing?.error ? (
                <div className="text-warn px-3 py-2 text-[12px]">{listing.error}</div>
              ) : null}
              {listing?.parent ? (
                <button
                  type="button"
                  onClick={() => {
                    setTyped(listing.parent!)
                    void go(listing.parent!)
                  }}
                  className="hover:bg-ink-850 flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
                >
                  <Folder className="text-ink-500 h-4 w-4 shrink-0" />
                  <span className="text-ink-300 font-mono text-[13px]">..</span>
                </button>
              ) : null}
              {(listing?.dirs ?? []).map((name) => {
                const full = `${path === '/' ? '' : path}/${name}`
                return (
                  <button
                    key={name}
                    type="button"
                    onClick={() => {
                      setTyped(full)
                      void go(full)
                    }}
                    onDoubleClick={() => commit(full)}
                    className="hover:bg-ink-850 flex w-full items-center gap-2.5 px-3 py-1.5 text-left"
                  >
                    <Folder className="text-ink-500 h-4 w-4 shrink-0" />
                    <span className="text-ink-200 truncate text-[13px]">{name}</span>
                  </button>
                )
              })}
              {!busy && !listing?.error && (listing?.dirs.length ?? 0) === 0 ? (
                <div className="text-ink-600 px-3 py-2 text-[12px]">
                  No subdirectories. Select this one, or go up.
                </div>
              ) : null}
            </div>
          </>
        ) : mode === 'recent' ? (
          <>
            <div className="flex items-center gap-2 px-5">
              <Search className="text-ink-600 h-4 w-4 shrink-0" />
              <input
                ref={recentInput}
                value={recentQuery}
                spellCheck={false}
                onChange={(event) => setRecentQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault()
                    // Enter takes the only plausible answer; there is no
                    // highlight to step through, because this list is short
                    // and is meant to be clicked.
                    if (shownRecent.length > 0) commit(shownRecent[0])
                  }
                }}
                placeholder="filter the list"
                className="border-brand bg-ink-850 text-ink-100 placeholder:text-ink-600 min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-[13px] outline-none"
              />
            </div>

            <div className="text-ink-600 px-5 py-2 text-[11.5px]">
              {shownRecent.length} of {recentList.length} · ⏎ opens the first · esc back
            </div>

            <div className="border-ink-800 mx-5 min-h-0 flex-1 overflow-y-auto rounded-lg border">
              {shownRecent.map((entry) => (
                <div
                  key={entry}
                  className="hover:bg-ink-850 group flex items-center gap-2 px-3 py-1.5"
                >
                  <Clock className="text-ink-500 h-3.5 w-3.5 shrink-0" />
                  <button
                    type="button"
                    title={entry}
                    onClick={() => commit(entry)}
                    className="min-w-0 flex-1 text-left"
                  >
                    <span className="text-ink-200 block truncate text-[12.5px]">
                      {folderLabel(entry)}
                    </span>
                    <span className="text-ink-600 block truncate font-mono text-[10.5px]">
                      {parentOf(entry)}
                    </span>
                  </button>
                  {/* Only the list's own item: deleting the folder is another
                      thing entirely, and that is not what an × on a list of
                      recent folders has ever meant. */}
                  <button
                    type="button"
                    title="Forget this folder"
                    onClick={() => void forget(environmentId, entry)}
                    className="text-ink-700 hover:bg-ink-800 hover:text-bad shrink-0 rounded p-1"
                  >
                    <X className="h-3 w-3" />
                  </button>
                </div>
              ))}
              {recentList.length === 0 ? (
                <div className="text-ink-600 px-3 py-6 text-center text-[12px]">
                  Nothing here yet. Folders appear once a conversation has been
                  pointed at one.
                </div>
              ) : shownRecent.length === 0 ? (
                <div className="text-ink-600 px-3 py-2 text-[12px]">
                  Nothing in the list matches “{recentQuery}”.
                </div>
              ) : null}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 px-5">
              <Search className="text-ink-600 h-4 w-4 shrink-0" />
              <input
                ref={searchInput}
                value={query}
                spellCheck={false}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown' || (event.key === 'n' && event.ctrlKey)) {
                    event.preventDefault()
                    setCursor((at) => Math.min(matches.length - 1, at + 1))
                  } else if (event.key === 'ArrowUp' || (event.key === 'p' && event.ctrlKey)) {
                    event.preventDefault()
                    setCursor((at) => Math.max(0, at - 1))
                  } else if (event.key === 'Enter') {
                    event.preventDefault()
                    const hit = matches[cursor]
                    if (hit) commit(hit.value)
                  } else if (event.key === 'Tab') {
                    // Take the highlighted path into the browser, to look
                    // around it rather than commit to it.
                    event.preventDefault()
                    const hit = matches[cursor]
                    if (hit) {
                      setTyped(hit.value)
                      setMode('browse')
                      void go(hit.value)
                    }
                  }
                }}
                placeholder={indexing ? 'reading the tree…' : 'type part of the path'}
                className="border-brand bg-ink-850 text-ink-100 placeholder:text-ink-600 min-w-0 flex-1 rounded-lg border px-3 py-2 font-mono text-[13px] outline-none"
              />
              <button
                type="button"
                title="Read the tree again"
                onClick={() => void loadIndex(true)}
                className="text-ink-500 hover:bg-ink-800 hover:text-ink-100 rounded-lg p-2"
              >
                <RefreshCw className={clsx('h-4 w-4', indexing && 'animate-spin')} />
              </button>
            </div>

            <div className="text-ink-600 flex items-center gap-3 px-5 py-2 text-[11.5px]">
              <span>
                {index ? `${matches.length >= 300 ? '300+' : matches.length} of ${index.dirs.length}` : 'reading the tree…'}
              </span>
              {index?.truncated ? <span className="text-warn">tree is capped</span> : null}
              <span className="ml-auto">↑↓ move · ⏎ select · ⇥ browse it · esc back</span>
            </div>

            <div
              ref={results}
              className="border-ink-800 mx-5 min-h-0 flex-1 overflow-y-auto rounded-lg border"
            >
              {matches.map((match, at) => (
                <button
                  key={match.value}
                  type="button"
                  data-active={at === cursor}
                  onMouseEnter={() => setCursor(at)}
                  onClick={() => commit(match.value)}
                  className={clsx(
                    'flex w-full items-center gap-2.5 px-3 py-1.5 text-left',
                    at === cursor ? 'bg-ink-800' : 'hover:bg-ink-850'
                  )}
                >
                  <Folder className="text-ink-500 h-4 w-4 shrink-0" />
                  <span className="text-ink-300 truncate font-mono text-[12.5px]">
                    <Highlighted match={match} />
                  </span>
                </button>
              ))}
              {index && matches.length === 0 ? (
                <div className="text-ink-600 px-3 py-2 text-[12px]">
                  Nothing under {index.root} matches that.
                </div>
              ) : null}
            </div>
          </>
        )}

        <div className="flex items-center gap-2 px-5 py-4">
          {!remote ? (
            <button
              type="button"
              onClick={async () => {
                const picked = await window.opendesktop.host.pickFolder()
                if (picked) commit(picked)
              }}
              className="text-ink-400 hover:text-ink-100 text-[12.5px]"
            >
              Browse…
            </button>
          ) : null}
          <span className="text-ink-600 min-w-0 flex-1 truncate text-right font-mono text-[11.5px]">
            {chosen}
          </span>
          <button
            type="button"
            onClick={close}
            className="bg-ink-800 text-ink-200 hover:bg-ink-700 rounded-lg px-3.5 py-2 text-[12.5px]"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => commit(chosen)}
            className="bg-ink-100 text-ink-950 hover:bg-white rounded-lg px-3.5 py-2 text-[12.5px] font-medium"
          >
            Select folder
          </button>
        </div>
      </div>
    </div>
  )
}
