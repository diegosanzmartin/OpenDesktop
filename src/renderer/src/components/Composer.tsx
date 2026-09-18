import clsx from 'clsx'
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUp,
  Check,
  ShieldCheck,
  Zap,
  ChevronDown,
  FileText,
  FolderOpen,
  Download,
  Gauge,
  ImageIcon,
  Paperclip,
  Square,
  X
} from 'lucide-react'
import type { Attachment, Session, Skill } from '@shared/types'
import { isManager } from '@shared/types'
import { SWITCHES, savingsLabel, savingsOf, type Savings } from '@shared/savings'
import { NeighbourBar } from './NeighbourBar'
import { ContextMeter } from './ContextMeter'
import { ToolServerChip } from './ToolServerChip'
import { isInWorkspace } from '@shared/workspace'
import { EffortDial } from './EffortDial'
import { workerModelRef } from '@shared/routing'
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
        className="text-ink-400 hover:text-ink-200 cursor-pointer appearance-none bg-transparent pr-4 text-[11.5px] outline-none"
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
 * The two switches, per session, as a chip that opens them.
 *
 * They were a three-way mode picker, which was wrong: filtering command output
 * and delegating file reading are not alternatives, and nothing about either
 * makes the other less useful. So they are independent, and the chip says which
 * are on — `Direct` when neither is, which is a label and not a third thing to
 * choose.
 *
 * Next to the environment rather than the model, because that is what one of
 * them is about: the same model reading a filtered version of the same machine.
 * Anything a switch cannot actually do is said here, beside it.
 */
function SavingsChip({ session }: { session: Session }): ReactNode {
  const config = useStore((s) => s.config)
  const savings = savingsOf(config, session)

  const [open, setOpen] = useState(false)
  const [anchor, setAnchor] = useState({ bottom: 0, left: 0 })
  const button = useRef<HTMLButtonElement>(null)
  const panel = useRef<HTMLDivElement>(null)
  const [rtk, setRtk] = useState<{ state: string; version?: string; message?: string } | null>(null)
  const [installing, setInstalling] = useState(false)

  // Portalled and placed by hand: the composer sits at the bottom of a pane
  // that scrolls, and a menu opening upwards inside it gets clipped.
  useLayoutEffect(() => {
    if (!open || !button.current) return
    const rect = button.current.getBoundingClientRect()
    setAnchor({ bottom: window.innerHeight - rect.top + 6, left: rect.left })
  }, [open])

  useEffect(() => {
    if (!open) return
    const onDown = (event: MouseEvent): void => {
      const target = event.target as Node
      if (!button.current?.contains(target) && !panel.current?.contains(target)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    window.addEventListener('mousedown', onDown)
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (!savings.rtk) {
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
  }, [savings.rtk, session.environmentId])

  const toggle = (key: keyof Savings, next: boolean): void => {
    void window.opendesktop.sessions.update(session.id, {
      savings: { ...(session.savings ?? {}), [key]: next }
    })
  }

  const broken = rtk && (rtk.state === 'missing' || rtk.state === 'too-old')
  const worker = config ? workerModelRef(config, session.model) : session.model
  const noCheaper = savings.shunt && worker === session.model

  return (
    <>
      <button
        ref={button}
        type="button"
        title="What this session does to keep its context and its bill down"
        onClick={() => setOpen(!open)}
        className={clsx(
          'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-[3px] text-[12px] transition-colors',
          open ? 'bg-ink-800 text-ink-100' : 'text-ink-400 hover:text-ink-200'
        )}
      >
        <Gauge className="h-3.5 w-3.5" />
        <span className="hidden @[620px]:inline">{savingsLabel(savings)}</span>
      </button>

      {broken ? (
        <span className="text-warn hidden shrink-0 text-[11.5px] @[760px]:inline" title={rtk?.message}>
          rtk not installed here
        </span>
      ) : noCheaper ? (
        /*
         * Not a warning, which is what this was and what it is not.
         *
         * With nothing cheaper declared, reading is delegated to this session's
         * own model: the file goes to a request that is thrown away, so it
         * stays out of the conversation — which is most of what the switch is
         * for — and it is charged at full price. Amber and the words "no
         * cheaper model" read as something broken, and the honest version of
         * it is a fact in the same place the worker is normally named.
         */
        <span
          className="text-ink-600 hidden shrink-0 text-[11.5px] @[760px]:inline"
          title="Reading goes to this session's own model in a throwaway request: the files stay out of the conversation, but they are charged at full price. Give another model a lower cost under Providers & keys, or name one under Routing & limits."
        >
          reading → same model
        </span>
      ) : savings.shunt ? (
        <span className="text-ink-600 hidden shrink-0 text-[11.5px] @[760px]:inline">
          reading → {worker}
        </span>
      ) : rtk?.state === 'ready' && rtk.version ? (
        <span className="text-ink-600 hidden shrink-0 text-[11.5px] @[760px]:inline">
          rtk {rtk.version}
        </span>
      ) : null}

      {open
        ? createPortal(
            <div
              ref={panel}
              style={{ bottom: anchor.bottom, left: anchor.left }}
              className="border-ink-700 bg-ink-850 fixed z-[60] w-[290px] rounded-lg border p-1 shadow-2xl"
            >
              {SWITCHES.map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  onClick={() => toggle(entry.id, !savings[entry.id])}
                  className="hover:bg-ink-800 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left"
                >
                  <span
                    className={clsx(
                      'mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded-[4px] border',
                      savings[entry.id] ? 'border-brand bg-brand' : 'border-ink-600'
                    )}
                  >
                    {savings[entry.id] ? (
                      <Check className="text-ink-950 h-2.5 w-2.5" strokeWidth={3.5} />
                    ) : null}
                  </span>
                  <span className="min-w-0">
                    <span className="text-ink-200 block text-[12.5px]">{entry.label}</span>
                    <span className="text-ink-500 block text-[11.5px] leading-snug">
                      {entry.blurb}
                    </span>
                  </span>
                </button>
              ))}
              {broken ? (
                /*
                 * rtk has to be on the machine whose commands it filters — it
                 * is what runs them — so the binary cannot be avoided. Having
                 * to install it by hand on every host can be: this fetches the
                 * release for that target into the home directory, checksum
                 * and all, and nothing else on the machine is touched.
                 */
                <button
                  type="button"
                  disabled={installing}
                  onClick={() => {
                    setInstalling(true)
                    void window.opendesktop.rtk
                      .install(session.environmentId)
                      .then((result) => {
                        setInstalling(false)
                        if (result?.ok) {
                          void window.opendesktop.rtk
                            .status(session.environmentId, true)
                            .then((next) => setRtk(next ?? null))
                        }
                      })
                      .catch(() => setInstalling(false))
                  }}
                  className="hover:bg-ink-800 text-ink-200 flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left disabled:opacity-60"
                >
                  <Download className="text-ink-500 mt-[3px] h-3.5 w-3.5 shrink-0" />
                  <span className="min-w-0">
                    <span className="block text-[12.5px]">
                      {installing
                        ? `Installing rtk on ${session.environmentId}…`
                        : `Install rtk on ${session.environmentId}`}
                    </span>
                    <span className="text-ink-500 block text-[11.5px] leading-snug">
                      Downloads the release for that host into ~/.opendesktop/bin, verifying its
                      checksum. No brew, no sudo, nothing else changed.
                    </span>
                  </span>
                </button>
              ) : null}
              <div className="text-ink-600 px-2 py-1 text-[11px]">
                Neither is Direct. Defaults are in Settings → Models.
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  )
}

/**
 * Whether this session asks before it acts.
 *
 * Always shown, in both states, because the dangerous one is the one that is
 * easy to forget you are in: a chat that runs commands without asking should
 * say so every time you look at it, not only when you turn it on.
 *
 * It lifts `ask` to `allow` and nothing else. Anything set to `deny` stays
 * denied and the denylist is checked before any of this, so the things nobody
 * should ever run still cannot run — which is what makes the toggle safe to
 * offer at all.
 */
function ApprovalChip({ session }: { session: Session }): ReactNode {
  const config = useStore((s) => s.config)
  const auto = session.autoApprove ?? config?.autoApprove ?? false

  return (
    <button
      type="button"
      title={
        auto
          ? 'Running without asking. Commands still cannot run if they match the denylist, or if a tool is set to deny.'
          : 'Asking before bash, edit and write. Click to run without asking.'
      }
      onClick={() => void window.opendesktop.sessions.update(session.id, { autoApprove: !auto })}
      className={clsx(
        'flex shrink-0 items-center gap-1 rounded-md px-1.5 py-[3px] text-[12px] transition-colors',
        auto ? 'text-warn hover:bg-warn/10' : 'text-ink-500 hover:text-ink-200'
      )}
    >
      {auto ? <Zap className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
      <span className="hidden @[620px]:inline">{auto ? 'Auto-approve' : 'Asks first'}</span>
    </button>
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
    if (!value && attachments.length === 0) return
    /*
     * Sending while it works queues the message rather than refusing it: the
     * thought is now, and the turn may have ten minutes left. Attachments wait
     * for a turn of their own — a file only means something alongside the
     * message it came with, and that message is going later.
     */
    if (busy) {
      setText('')
      setMenu(null)
      void send(value, [])
      return
    }
    setText('')
    setMenu(null)
    setAttachError(null)
    void send(value, attachments)
    setAttachments([])
  }

  const openFolderPicker = useStore((s) => s.openFolderPicker)
  const workspacesRoot = useStore((s) => s.workspacesRoot)

  /*
   * A rewind puts what the message said back here, so it can be edited and
   * sent again. Claimed rather than read: the draft is cleared as it is taken,
   * so it cannot overwrite what someone types next.
   */
  const draft = useStore((s) => s.draft)
  const setDraft = useStore((s) => s.setDraft)
  useEffect(() => {
    if (!draft || draft.sessionId !== session.id) return
    setText(draft.text)
    setAttachments(draft.attachments)
    setDraft(null)
    queueMicrotask(() => {
      area.current?.focus()
      const end = draft.text.length
      area.current?.setSelectionRange(end, end)
    })
  }, [draft, session.id, setDraft])

  // Its own folder rather than one somebody chose, which changes what this
  // line is worth saying.
  const ownFolder = isInWorkspace(workspacesRoot, session.cwd)

  const patch = (next: Partial<Session>): void => {
    void window.opendesktop.sessions.update(session.id, next)
  }

  return (
    // A container, not a media query: this composer is used both full width in
    // the chat and in the board's 460px side panel, and what has room is a
    // property of the pane, not of the window.
    <div className="@container px-6 pb-4 pt-1">
      <div className="mx-auto max-w-[760px]">
        <NeighbourBar session={session} />
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
            'border-ink-700 bg-ink-850 focus-within:border-ink-600 relative flex flex-col rounded-2xl border px-3.5 py-2',
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
            className="text-ink-100 placeholder:text-ink-600 max-h-56 min-h-[22px] flex-1 resize-none bg-transparent text-[14px] leading-[22px] outline-none"
          />
          <button
            type="button"
            title="Attach files"
            onClick={async () => take(await window.opendesktop.attachments.pick(session.id))}
            className="text-ink-500 hover:bg-ink-800 hover:text-ink-200 shrink-0 rounded-md p-1"
          >
            <Paperclip className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={busy ? () => void stop() : submit}
            disabled={!busy && !text.trim() && attachments.length === 0}
            title={busy ? 'Stop' : 'Send'}
            className={clsx(
              'flex h-6 w-6 shrink-0 items-center justify-center rounded-full transition-colors',
              busy
                ? 'bg-bad/20 text-bad hover:bg-bad/30'
                : text.trim()
                  ? 'bg-brand text-ink-950 hover:bg-brand-dim'
                  : 'bg-ink-800 text-ink-600'
            )}
          >
            {busy ? <Square className="h-2.5 w-2.5" /> : <ArrowUp className="h-3.5 w-3.5" />}
          </button>
          </div>
        </div>

        {busy && (text.trim() || (session.queuedFollowUps?.length ?? 0) > 0) ? (
          <div className="text-ink-500 mt-1.5 px-1 text-[11.5px]">
            {text.trim()
              ? '↵ adds this to the queue — it goes as the next turn when this one stops.'
              : `${session.queuedFollowUps?.length} message${
                  (session.queuedFollowUps?.length ?? 0) === 1 ? '' : 's'
                } queued — they go when this turn stops.`}
          </div>
        ) : null}

        {/*
          * One line under the box, quieter than the box.
          *
          * Everything here is a fact about the session rather than about the
          * message being written, so none of it should catch the eye on the
          * way to the send key: 11.5px, ink-500, no borders, and the two
          * things that open a panel are the only ones that respond to a
          * hover. What you set rarely is on the left, what you watch is on
          * the right.
          */}
        <div data-footer className="mt-1.5 flex items-center gap-x-2.5 px-1">
          <div className="flex min-w-0 flex-1 items-center gap-x-2.5 overflow-hidden">
          {/*
            * Just the icon when the folder is the conversation's own: the path
            * is `…/workspaces/94adVYh3JLDa`, which is an id nobody typed and
            * nobody can use — it says "somewhere" in twenty-six characters.
            * Pointed at a repository, the path is the most useful thing on
            * this line.
            */}
          <button
            type="button"
            title={
              ownFolder
                ? "This conversation's own folder — click to point it at a repository instead"
                : `${session.cwd} — click to change it, ⌘R to search for one`
            }
            onClick={() => openFolderPicker(session.id)}
            className="text-ink-500 hover:text-ink-200 flex min-w-0 shrink items-center gap-1.5 text-[11.5px]"
          >
            <FolderOpen className="h-3 w-3 shrink-0" />
            {ownFolder ? null : <span className="truncate">{shortenPath(session.cwd, 26)}</span>}
          </button>

          {/* Nothing is said when the manager is running it, which is almost
              always: naming the default on every chat is a label that never
              changes, and the way to hand part of the work to a specialist is
              to type @ in the message — which the mention menu already shows
              the moment it is typed. A named agent still says which one it is,
              because that is a chat where the answer is not obvious. */}
          {managed ? null : (
            <span className="text-ink-500 shrink-0 text-[11.5px]">
              {agent?.name ?? session.agentId}
            </span>
          )}
          {attachments.some((a) => a.kind === 'image') && !acceptsImages ? (
            <span className="text-warn text-[11px]">
              this model is not set as vision-capable — images will not be sent
            </span>
          ) : !managed && agent?.description ? (
            // Hidden below ~620px: in the board's side panel the pickers matter
            // and the description does not.
            <span className="text-ink-600 hidden max-w-[240px] truncate text-[11px] @[620px]:inline">
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

          <SavingsChip session={session} />

          <ApprovalChip session={session} />

          {/* Only when servers are declared: a control for a thing you do not
              have is furniture. */}
          <ToolServerChip session={session} />
          </div>

          {/* The right-hand end: what is answering, how hard it is trying, and
              how full its window is. In that order because that is the order
              you ask about them in, and because the two that open a panel are
              nearest the corner the panel comes out of. Never wraps, never
              shrinks: with both savings switches and auto-approve on, this is
              what used to drop onto a second line. */}
          <div data-footer-right className="flex shrink-0 items-center gap-1.5">
            {!model && models.length > 0 ? (
              <span className="text-warn text-[11px]">unknown model</span>
            ) : null}
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
            <EffortDial session={session} />
            <ContextMeter session={session} />
            {busy ? <span className="bg-brand h-1.5 w-1.5 animate-pulse rounded-full" /> : null}
          </div>
        </div>
      </div>
    </div>
  )
}
