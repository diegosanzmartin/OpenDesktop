import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, FileText, FolderOpen, ImageIcon, Paperclip, Square, X } from 'lucide-react'
import type { Attachment, Session, Skill } from '@shared/types'
import { isManager } from '@shared/types'
import {
  DEFAULT_MODE,
  MODES,
  modeInfo,
  workerModelRef,
  type SessionMode
} from '@shared/modes'
import { mentionToken } from '@shared/mentions'
import { useStore } from '../state/store'
import { folderName, shortenPath } from '../lib/format'

function Picker({
  value,
  onChange,
  options,
  title
}: {
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  title: string
}): ReactNode {
  return (
    <div className="relative inline-flex items-center">
      <select
        title={title}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="text-ink-400 hover:text-ink-200 cursor-pointer appearance-none bg-transparent pr-4 text-[12px] outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value} className="bg-ink-850">
            {option.label}
          </option>
        ))}
      </select>
      <ChevronDown className="text-ink-600 pointer-events-none absolute right-0 h-3 w-3" />
    </div>
  )
}

/**
 * How much of what a tool produces reaches the model, per session.
 *
 * Next to the environment rather than the model, because that is what it is
 * about: the same model reading a filtered version of the same machine. A mode
 * that cannot work says so here — the alternative is a session labelled `rtk`
 * behaving exactly like `Direct` with nothing to show for it.
 */
function ModePicker({ session }: { session: Session }): ReactNode {
  const mode = session.mode ?? DEFAULT_MODE
  const config = useStore((s) => s.config)
  const [rtk, setRtk] = useState<{ state: string; version?: string; message?: string } | null>(null)

  useEffect(() => {
    if (mode !== 'rtk') {
      setRtk(null)
      return
    }
    let live = true
    void window.opendesktop.rtk.status(session.environmentId, true).then((status) => {
      if (live) setRtk(status ?? null)
    })
    return () => {
      live = false
    }
  }, [mode, session.environmentId])

  const info = modeInfo(mode)
  const broken = rtk && (rtk.state === 'missing' || rtk.state === 'too-old')
  const worker = config ? workerModelRef(config, session.model) : session.model

  return (
    <>
      <Picker
        title={`Mode — ${info.blurb}`}
        value={mode}
        onChange={(next) => {
          void window.opendesktop.sessions.update(session.id, { mode: next as SessionMode })
        }}
        options={MODES.map((entry) => ({ value: entry.id, label: entry.label }))}
      />
      {broken ? (
        <span className="text-warn shrink-0 text-[11.5px]" title={rtk?.message}>
          rtk not installed here
        </span>
      ) : rtk?.state === 'ready' && rtk.version ? (
        <span className="text-ink-600 hidden shrink-0 text-[11.5px] @[620px]:inline">
          rtk {rtk.version}
        </span>
      ) : mode === 'shunt' ? (
        worker === session.model ? (
          <span
            className="text-warn shrink-0 text-[11.5px]"
            title="Reading is delegated to this session's own model, so the files stay out of the conversation but are charged at full price. Set a cheaper one under Settings → Models → Mode."
          >
            no cheaper model set
          </span>
        ) : (
          <span className="text-ink-600 hidden shrink-0 text-[11.5px] @[620px]:inline">
            reading → {worker}
          </span>
        )
      ) : null}
    </>
  )
}

/** The working-tree strip above the composer, mirroring the app's status bar. */
function ChangesBar({ session }: { session: Session }): ReactNode {
  const changes = useStore((s) => s.changes)
  const refreshChanges = useStore((s) => s.refreshChanges)
  const openDock = useStore((s) => s.openDock)

  useEffect(() => {
    void refreshChanges()
  }, [session.id, session.cwd, refreshChanges])

  if (!changes?.isRepo || changes.files.length === 0) return null

  return (
    <div className="border-ink-800 bg-ink-850 mb-2 flex items-center gap-2 rounded-lg border px-3 py-1.5">
      <span className="text-ink-300 text-[12px]">{folderName(changes.root)}</span>
      <span className="text-ink-600 text-[12px]">{changes.branch}</span>
      <span className="ml-auto flex items-center gap-1.5 font-mono text-[11.5px]">
        <span className="text-ok">+{changes.added}</span>
        <span className="text-bad">-{changes.removed}</span>
      </span>
      <button
        type="button"
        onClick={() => {
          openDock('changes')
          void refreshChanges()
        }}
        className="bg-ink-800 text-ink-200 hover:bg-ink-700 rounded px-2 py-[3px] text-[11.5px]"
      >
        Review changes
      </button>
    </div>
  )
}

/** The `/` menu. Filters as you type and inserts the skill's id. */
interface Suggestion {
  key: string
  label: string
  description?: string
  colour?: string
}

/** The list under the composer: `/` offers skills, `@` offers agents. */
function MentionMenu({
  items,
  query,
  active,
  empty,
  onPick
}: {
  items: Suggestion[]
  query: string
  active: number
  empty: string
  onPick: (item: Suggestion) => void
}): ReactNode {
  if (items.length === 0) {
    return (
      <div className="border-ink-700 bg-ink-850 absolute bottom-full left-0 mb-2 w-full rounded-lg border px-3 py-2 shadow-2xl">
        <span className="text-ink-500 text-[12px]">
          {query ? `Nothing matches “${query}”.` : empty}
        </span>
      </div>
    )
  }

  return (
    <div className="border-ink-700 bg-ink-850 absolute bottom-full left-0 mb-2 max-h-72 w-full overflow-y-auto rounded-lg border p-1 shadow-2xl">
      {items.map((item, index) => (
        <button
          key={item.key}
          type="button"
          onMouseDown={(event) => {
            // mousedown, not click: the textarea must not lose focus first.
            event.preventDefault()
            onPick(item)
          }}
          className={clsx(
            'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left',
            index === active ? 'bg-ink-800' : 'hover:bg-ink-800/60'
          )}
        >
          <span
            className="font-mono text-[12.5px]"
            style={{ color: item.colour ?? 'var(--color-ink-100)' }}
          >
            {item.label}
          </span>
          {item.description ? (
            <span className="text-ink-500 line-clamp-2 text-[11.5px]">{item.description}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

function AttachmentChip({
  attachment,
  blocked,
  onRemove
}: {
  attachment: Attachment
  blocked: boolean
  onRemove: () => void
}): ReactNode {
  const [preview, setPreview] = useState<string | null>(null)

  useEffect(() => {
    if (attachment.kind !== 'image') return
    void window.opendesktop.files.previewUrl('local', attachment.path).then(setPreview)
  }, [attachment.kind, attachment.path])

  return (
    <div
      title={blocked ? `${attachment.name} — this model cannot read images` : attachment.name}
      className={clsx(
        'group border-ink-700 bg-ink-850 relative flex items-center gap-1.5 rounded-lg border py-1 pl-1.5 pr-2',
        blocked && 'border-warn/50'
      )}
    >
      {attachment.kind === 'image' ? (
        preview ? (
          <img src={preview} alt="" className="h-7 w-7 rounded object-cover" />
        ) : (
          <ImageIcon className="text-ink-500 h-4 w-4" />
        )
      ) : (
        <FileText className="text-ink-500 h-4 w-4" />
      )}
      <span className="max-w-[150px] truncate text-[11.5px]">{attachment.name}</span>
      <button
        type="button"
        onClick={onRemove}
        title="Remove"
        className="text-ink-600 hover:text-bad ml-0.5"
      >
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export function Composer({ session }: { session: Session }): ReactNode {
  const [text, setText] = useState('')
  const config = useStore((s) => s.config)
  const models = useStore((s) => s.models)
  const send = useStore((s) => s.send)
  const stop = useStore((s) => s.stop)

  const skills = useStore((s) => s.skills)
  const area = useRef<HTMLTextAreaElement>(null)
  const [menu, setMenu] = useState<{ kind: 'skill' | 'agent'; at: number } | null>(null)
  const [active, setActive] = useState(0)

  const query = menu === null ? '' : text.slice(menu.at + 1).split(/\s/)[0] ?? ''

  // Named agents, minus the manager: it is the one asking, so it cannot be
  // handed the work.
  const agents = useMemo(
    () =>
      Object.values(config?.agent ?? {}).filter(
        (agent) => !isManager(agent.id) && (agent.mode === 'subagent' || agent.mode === 'all')
      ),
    [config]
  )

  const matches = useMemo<Suggestion[]>(() => {
    if (menu === null) return []
    const needle = query.toLowerCase()
    const hit = (...fields: string[]): boolean =>
      !needle || fields.some((field) => field.toLowerCase().includes(needle))

    if (menu.kind === 'agent') {
      return agents
        .filter((agent) => hit(agent.id, agent.name))
        .slice(0, 8)
        .map((agent) => ({
          key: agent.id,
          label: mentionToken(agent),
          description: agent.description,
          colour: agent.color
        }))
    }
    return skills
      .filter((skill) => hit(skill.id, skill.name))
      .slice(0, 8)
      .map((skill) => ({ key: skill.id, label: `/${skill.id}`, description: skill.description }))
  }, [skills, agents, query, menu])

  const syncMenu = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    // A skill is a command, so it only starts a line. An agent is named
    // mid-sentence — "ask @Infrastructure to check the module" — so it only
    // needs to not be inside a word.
    const skill = /(^|\n)\/([\w-]*)$/.exec(before)
    const agent = /(^|[^\w@/])@([\w-]*)$/.exec(before)
    if (skill) setMenu({ kind: 'skill', at: caret - skill[2].length - 1 })
    else if (agent) setMenu({ kind: 'agent', at: caret - agent[2].length - 1 })
    else setMenu(null)
    setActive(0)
  }

  const insert = (item: Suggestion): void => {
    if (menu === null) return
    const caret = area.current?.selectionStart ?? text.length
    const token = menu.kind === 'agent' ? item.label : `/${item.key}`
    const next = `${text.slice(0, menu.at)}${token} ${text.slice(caret)}`
    setText(next)
    setMenu(null)
    queueMicrotask(() => {
      const position = menu.at + token.length + 1
      area.current?.focus()
      area.current?.setSelectionRange(position, position)
    })
  }

  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [acceptsImages, setAcceptsImages] = useState(false)
  const [dropping, setDropping] = useState(false)
  const [attachError, setAttachError] = useState<string | null>(null)

  useEffect(() => {
    void window.opendesktop.attachments
      .accepted(session.model)
      .then((accepted) => setAcceptsImages(accepted.images))
  }, [session.model])

  // Attachments belong to the message being composed, not to the session.
  useEffect(() => {
    setAttachments([])
  }, [session.id])

  const take = (result: { added: Attachment[]; errors: string[] }): void => {
    if (result.added.length > 0) setAttachments((current) => [...current, ...result.added])
    setAttachError(result.errors[0] ?? null)
  }

  const attachPaths = async (paths: string[]): Promise<void> => {
    if (paths.length > 0) take(await window.opendesktop.attachments.addPaths(session.id, paths))
  }

  const busy = session.status === 'running' || session.status === 'awaiting-approval'
  const environments = Object.values(config?.environment ?? {})
  const agent = config?.agent[session.agentId]
  const managed = isManager(session.agentId)
  const model = models.find((m) => m.ref === session.model)

  const submit = (): void => {
    const value = text.trim()
    if ((!value && attachments.length === 0) || busy) return
    setText('')
    setMenu(null)
    setAttachError(null)
    void send(value, attachments)
    setAttachments([])
  }

  const patch = (next: Partial<Session>): void => {
    void window.opendesktop.sessions.update(session.id, next)
  }

  return (
    // A container, not a media query: this composer is used both full width in
    // the chat and in the board's 460px side panel, and what has room is a
    // property of the pane, not of the window.
    <div className="@container px-6 pb-4 pt-1">
      <div className="mx-auto max-w-[760px]">
        <ChangesBar session={session} />

        {attachError ? (
          <div className="border-warn/40 bg-warn/10 text-warn mb-2 flex items-start gap-2 rounded-lg border px-3 py-1.5 text-[11.5px]">
            <span className="flex-1">{attachError}</span>
            <button type="button" onClick={() => setAttachError(null)}>
              <X className="h-3 w-3" />
            </button>
          </div>
        ) : null}

        <div
          onDragOver={(event) => {
            event.preventDefault()
            setDropping(true)
          }}
          onDragLeave={() => setDropping(false)}
          onDrop={(event) => {
            event.preventDefault()
            setDropping(false)
            const paths = Array.from(event.dataTransfer.files).map((file) =>
              window.opendesktop.attachments.pathFor(file)
            )
            void attachPaths(paths.filter(Boolean))
          }}
          onPaste={(event) => {
            // A pasted screenshot has no path, so it arrives as bytes.
            const image = Array.from(event.clipboardData.items).find((item) =>
              item.type.startsWith('image/')
            )
            const file = image?.getAsFile()
            if (!file) return
            event.preventDefault()
            void file.arrayBuffer().then(async (buffer) =>
              take(
                await window.opendesktop.attachments.addBytes(
                  session.id,
                  file.name || `pasted-${Date.now()}.png`,
                  file.type,
                  new Uint8Array(buffer)
                )
              )
            )
          }}
          className={clsx(
            'border-ink-700 bg-ink-850 focus-within:border-ink-600 relative flex flex-col rounded-2xl border px-3.5 py-2.5',
            dropping && 'border-brand bg-brand/5'
          )}
        >
          {attachments.length > 0 ? (
            <div className="mb-2 flex flex-wrap gap-1.5">
              {attachments.map((attachment) => (
                <AttachmentChip
                  key={attachment.id}
                  attachment={attachment}
                  blocked={attachment.kind === 'image' && !acceptsImages}
                  onRemove={() => {
                    void window.opendesktop.attachments.remove(attachment.path)
                    setAttachments((current) => current.filter((a) => a.id !== attachment.id))
                  }}
                />
              ))}
            </div>
          ) : null}

          <div className="flex items-end gap-2">
          {menu !== null ? (
            <MentionMenu
              items={matches}
              query={query}
              active={active}
              empty={
                menu.kind === 'agent'
                  ? 'No agents yet — add them in Settings → Agents.'
                  : 'No skills yet — import them from Settings → Skills.'
              }
              onPick={insert}
            />
          ) : null}
          <textarea
            ref={area}
            value={text}
            rows={1}
            placeholder="Type your message, or / for a skill…"
            onChange={(event) => {
              setText(event.target.value)
              syncMenu(event.target.value, event.target.selectionStart ?? 0)
            }}
            onClick={(event) => syncMenu(text, event.currentTarget.selectionStart ?? 0)}
            onBlur={() => setMenu(null)}
            onKeyDown={(event) => {
              if (menu !== null && matches.length > 0) {
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  return setActive((index) => (index + 1) % matches.length)
                }
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  return setActive((index) => (index - 1 + matches.length) % matches.length)
                }
                if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
                  event.preventDefault()
                  return insert(matches[active])
                }
              }
              if (event.key === 'Escape' && menu !== null) {
                event.preventDefault()
                return setMenu(null)
              }
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                submit()
              }
            }}
            className="text-ink-100 placeholder:text-ink-600 max-h-56 min-h-[24px] flex-1 resize-none bg-transparent text-[14px] leading-[1.6] outline-none"
          />
          <button
            type="button"
            title="Attach files"
            onClick={async () => take(await window.opendesktop.attachments.pick(session.id))}
            className="text-ink-500 hover:bg-ink-800 hover:text-ink-200 mb-0.5 shrink-0 rounded-md p-1.5"
          >
            <Paperclip className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={busy ? () => void stop() : submit}
            disabled={!busy && !text.trim() && attachments.length === 0}
            title={busy ? 'Stop' : 'Send'}
            className={clsx(
              'flex h-7 w-7 shrink-0 items-center justify-center rounded-full transition-colors',
              busy
                ? 'bg-bad/20 text-bad hover:bg-bad/30'
                : text.trim()
                  ? 'bg-brand text-ink-950 hover:bg-brand-dim'
                  : 'bg-ink-800 text-ink-600'
            )}
          >
            {busy ? <Square className="h-3 w-3" /> : <ArrowUp className="h-4 w-4" />}
          </button>
          </div>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
          <button
            type="button"
            title={session.cwd}
            onClick={async () => {
              if (session.environmentId !== 'local') return
              const picked = await window.opendesktop.host.pickFolder()
              if (picked) patch({ cwd: picked })
            }}
            className="text-ink-500 hover:text-ink-200 flex min-w-0 shrink items-center gap-1.5 text-[12px]"
          >
            <FolderOpen className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{shortenPath(session.cwd, 26)}</span>
          </button>

          {/* No picker: the manager runs every session, and the way to put a
              specialist on something is to name it with @ in the message. */}
          <span className="text-ink-500 shrink-0 text-[12px]">
            {managed ? 'Manager' : (agent?.name ?? session.agentId)}
          </span>
          {attachments.some((a) => a.kind === 'image') && !acceptsImages ? (
            <span className="text-warn text-[11.5px]">
              this model is not set as vision-capable — images will not be sent
            </span>
          ) : managed ? (
            // Hidden below ~620px: in the board's side panel the pickers matter
            // and the hint does not.
            <span className="text-ink-600 hidden text-[11.5px] @[620px]:inline">
              type @ to put a specialist on part of it
            </span>
          ) : agent?.description ? (
            <span className="text-ink-600 hidden max-w-[280px] truncate text-[11.5px] @[620px]:inline">
              {agent.description}
            </span>
          ) : null}

          <Picker
            title="Environment"
            value={session.environmentId}
            onChange={(next) => {
              const cwd = config?.environment[next]?.cwd
              patch({ environmentId: next, ...(cwd ? { cwd } : {}) })
            }}
            options={environments.map((e) => ({ value: e.id, label: e.name }))}
          />

          <ModePicker session={session} />

          <div className="ml-auto flex min-w-0 items-center gap-3">
            <Picker
              title="Model"
              value={session.model}
              onChange={(next) => patch({ model: next })}
              options={
                models.length
                  ? models.map((m) => ({ value: m.ref, label: m.label }))
                  : [{ value: session.model, label: session.model }]
              }
            />
            {busy ? <span className="bg-brand h-2 w-2 animate-pulse rounded-full" /> : null}
            {!model && models.length > 0 ? (
              <span className="text-warn text-[11px]">unknown model</span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  )
}
