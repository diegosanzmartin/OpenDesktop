import clsx from 'clsx'
import { useEffect, useRef, useState, type ReactNode } from 'react'

/**
 * A title you can click to rename. The first message names a chat, which is
 * right most of the time and wrong often enough that it has to be fixable —
 * and a board makes it matter more, since the title is all a card shows.
 *
 * Escape restores what was there rather than saving, so an accidental click
 * followed by typing cannot quietly rename something.
 */
export function EditableTitle({
  value,
  onCommit,
  className,
  inputClassName,
  title
}: {
  value: string
  onCommit: (next: string) => void
  className?: string
  inputClassName?: string
  title?: string
}): ReactNode {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(value)
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setDraft(value)
  }, [value, editing])

  useEffect(() => {
    if (editing) input.current?.select()
  }, [editing])

  const commit = (): void => {
    setEditing(false)
    const next = draft.trim()
    if (next && next !== value) onCommit(next)
    else setDraft(value)
  }

  if (editing) {
    return (
      <input
        ref={input}
        autoFocus
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
          if (event.key === 'Escape') {
            event.preventDefault()
            setDraft(value)
            setEditing(false)
          }
          event.stopPropagation()
        }}
        className={clsx(
          'border-ink-600 bg-ink-850 text-ink-100 min-w-0 rounded-md border px-1.5 py-[2px] outline-none',
          inputClassName ?? className
        )}
      />
    )
  }

  return (
    <button
      type="button"
      title={title ?? 'Click to rename'}
      onClick={(event) => {
        event.stopPropagation()
        setEditing(true)
      }}
      className={clsx(
        'hover:bg-ink-800 min-w-0 truncate rounded-md px-1.5 py-[2px] text-left',
        className
      )}
    >
      {value}
    </button>
  )
}
