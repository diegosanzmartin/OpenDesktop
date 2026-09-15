import clsx from 'clsx'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUp, ChevronDown, FileText, FolderOpen, ImageIcon, Paperclip, Square, X } from 'lucide-react'
import type { Attachment, Session, Skill } from '@shared/types'
import { AUTO_AGENT } from '@shared/types'
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
function SkillMenu({
  skills,
  query,
  active,
  onPick
}: {
  skills: Skill[]
  query: string
  active: number
  onPick: (skill: Skill) => void
}): ReactNode {
  if (skills.length === 0) {
    return (
      <div className="border-ink-700 bg-ink-850 absolute bottom-full left-0 mb-2 w-full rounded-lg border px-3 py-2 shadow-2xl">
        <span className="text-ink-500 text-[12px]">
          {query
            ? `No skill matches “${query}”.`
            : 'No skills yet — import them from Settings → Skills.'}
        </span>
      </div>
    )
  }

  return (
    <div className="border-ink-700 bg-ink-850 absolute bottom-full left-0 mb-2 max-h-72 w-full overflow-y-auto rounded-lg border p-1 shadow-2xl">
      {skills.map((skill, index) => (
        <button
          key={skill.id}
          type="button"
          onMouseDown={(event) => {
            // mousedown, not click: the textarea must not lose focus first.
            event.preventDefault()
            onPick(skill)
          }}
          className={clsx(
            'flex w-full flex-col items-start gap-0.5 rounded-md px-2.5 py-1.5 text-left',
            index === active ? 'bg-ink-800' : 'hover:bg-ink-800/60'
          )}
        >
          <span className="text-ink-100 font-mono text-[12.5px]">/{skill.id}</span>
          {skill.description ? (
            <span className="text-ink-500 line-clamp-2 text-[11.5px]">{skill.description}</span>
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
  const [menuAt, setMenuAt] = useState<number | null>(null)
  const [active, setActive] = useState(0)

  // The menu is open while the caret sits in a `/word` at the start of a line.
  const query = menuAt === null ? '' : text.slice(menuAt + 1).split(/\s/)[0] ?? ''
  const matches = useMemo(() => {
    if (menuAt === null) return []
    const needle = query.toLowerCase()
    return skills
      .filter(
        (skill) =>
          !needle ||
          skill.id.toLowerCase().includes(needle) ||
          skill.name.toLowerCase().includes(needle)
      )
      .slice(0, 8)
  }, [skills, query, menuAt])

  const syncMenu = (value: string, caret: number): void => {
    const before = value.slice(0, caret)
    const match = /(^|\n)\/([\w-]*)$/.exec(before)
    setMenuAt(match ? caret - match[2].length - 1 : null)
    setActive(0)
  }

  const insertSkill = (skill: Skill): void => {
    if (menuAt === null) return
    const caret = area.current?.selectionStart ?? text.length
    const next = `${text.slice(0, menuAt)}/${skill.id} ${text.slice(caret)}`
    setText(next)
    setMenuAt(null)
    queueMicrotask(() => {
      const position = menuAt + skill.id.length + 2
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
  const primaryAgents = Object.values(config?.agent ?? {}).filter(
    (a) => a.mode === 'primary' || a.mode === 'all'
  )
  const environments = Object.values(config?.environment ?? {})
  const agent = config?.agent[session.agentId]
  const isAuto = session.agentId === AUTO_AGENT
  const model = models.find((m) => m.ref === session.model)

  const submit = (): void => {
    const value = text.trim()
    if ((!value && attachments.length === 0) || busy) return
    setText('')
    setMenuAt(null)
    setAttachError(null)
    void send(value, attachments)
    setAttachments([])
  }

  const patch = (next: Partial<Session>): void => {
    void window.opendesktop.sessions.update(session.id, next)
  }

  return (
    <div className="px-6 pb-4 pt-1">
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
          {menuAt !== null ? (
            <SkillMenu skills={matches} query={query} active={active} onPick={insertSkill} />
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
            onBlur={() => setMenuAt(null)}
            onKeyDown={(event) => {
              if (menuAt !== null && matches.length > 0) {
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
                  return insertSkill(matches[active])
                }
              }
              if (event.key === 'Escape' && menuAt !== null) {
                event.preventDefault()
                return setMenuAt(null)
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

        <div className="mt-2 flex items-center gap-3 px-1">
          <button
            type="button"
            title={session.cwd}
            onClick={async () => {
              if (session.environmentId !== 'local') return
              const picked = await window.opendesktop.host.pickFolder()
              if (picked) patch({ cwd: picked })
            }}
            className="text-ink-500 hover:text-ink-200 flex items-center gap-1.5 text-[12px]"
          >
            <FolderOpen className="h-3.5 w-3.5" />
            {shortenPath(session.cwd, 26)}
          </button>

          <Picker
            title="Agent"
            value={session.agentId}
            onChange={(agentId) => patch({ agentId })}
            options={[
              { value: AUTO_AGENT, label: 'Auto' },
              ...primaryAgents.map((a) => ({ value: a.id, label: a.name }))
            ]}
          />
          {attachments.some((a) => a.kind === 'image') && !acceptsImages ? (
            <span className="text-warn text-[11.5px]">
              this model is not set as vision-capable — images will not be sent
            </span>
          ) : isAuto ? (
            <span className="text-ink-600 text-[11.5px]">splits the work across specialists</span>
          ) : agent?.description ? (
            <span className="text-ink-600 max-w-[280px] truncate text-[11.5px]">
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

          <div className="ml-auto flex items-center gap-3">
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
