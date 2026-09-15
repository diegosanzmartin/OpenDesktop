import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { AUTO_AGENT } from '@shared/types'
import { useStore } from '../state/store'
import { folderName } from '../lib/format'
import { Button, Label } from './ui'

/**
 * A stacked field. The shared Select puts its label beside the control, which
 * is right in a toolbar but overflows in a narrow dialog column.
 */
function Field({
  label,
  value,
  onChange,
  options
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
}): ReactNode {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="border-ink-700 bg-ink-850 text-ink-200 focus:border-ink-600 w-full min-w-0 cursor-pointer truncate rounded-md border px-2 py-1.5 text-[12.5px] outline-none"
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  )
}

/**
 * Creating a task is creating a chat that has not been sent yet. The column
 * decides what happens next: To do hands it to the scheduler, In progress runs
 * it as soon as a slot is free, Backlog just parks it.
 */
export function NewTaskDialog({
  boardId: initialBoardId,
  columnId,
  onClose
}: {
  boardId: string
  columnId: string
  onClose: () => void
}): ReactNode {
  const boards = useStore((s) => s.boards)
  const config = useStore((s) => s.config)
  const sessions = useStore((s) => s.sessions)

  // Picked here rather than fixed by the caller, because on the overview there
  // is no current board and the task has to land on a real one.
  const [boardId, setBoardId] = useState(initialBoardId)
  const board = boards.find((candidate) => candidate.id === boardId)
  const [title, setTitle] = useState('')
  const [prompt, setPrompt] = useState('')
  const [agentId, setAgentId] = useState(AUTO_AGENT)
  const [column, setColumn] = useState(columnId || board?.columns[1]?.id || '')

  // A board change invalidates the chosen column, which belongs to the old one.
  useEffect(() => {
    if (!board) return
    if (!board.columns.some((candidate) => candidate.id === column)) {
      setColumn(board.columns.find((candidate) => candidate.kind === 'todo')?.id ?? board.columns[0].id)
    }
  }, [board, column])
  const [parent, setParent] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Only cards already on this board can be a parent, so a story and its
  // subtasks always sit together.
  const stories = useMemo(
    () => sessions.filter((session) => session.boardId === boardId && !session.parentSessionId),
    [sessions, boardId]
  )

  const agents = [
    { value: AUTO_AGENT, label: 'Auto — split across specialists' },
    ...Object.values(config?.agent ?? {}).map((agent) => ({ value: agent.id, label: agent.name }))
  ]

  const chosen = board?.columns.find((candidate) => candidate.id === column)
  const willRun = chosen?.kind === 'todo' || chosen?.kind === 'in-progress'

  const submit = async (): Promise<void> => {
    if (!prompt.trim() || busy) return
    setBusy(true)
    try {
      await window.opendesktop.boards.createTask({
        boardId,
        columnId: column,
        title: title.trim() || prompt.trim().replace(/\s+/g, ' ').slice(0, 70),
        prompt: prompt.trim(),
        agentId,
        parentSessionId: parent || undefined
      })
      onClose()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-8">
      <div className="border-ink-700 bg-ink-900 w-full max-w-lg overflow-hidden rounded-xl border shadow-2xl">
        <div className="border-ink-800 flex h-11 items-center border-b px-4">
          <span className="text-ink-100 text-[13.5px] font-medium">New task</span>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-500 hover:bg-ink-800 hover:text-ink-100 ml-auto rounded-md p-1.5"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="space-y-3 p-4">
          <div>
            <Label>Title</Label>
            <input
              autoFocus
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Taken from the instructions if you leave it empty"
              className="border-ink-700 bg-ink-850 text-ink-100 placeholder:text-ink-600 focus:border-ink-600 mt-1 w-full rounded-md border px-2.5 py-1.5 text-[13px] outline-none"
            />
          </div>

          <div>
            <Label>Instructions</Label>
            <textarea
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void submit()
              }}
              rows={5}
              placeholder="What should the agent do? This is sent as the first message."
              className="border-ink-700 bg-ink-850 text-ink-100 placeholder:text-ink-600 focus:border-ink-600 mt-1 h-28 w-full resize-none rounded-md border px-2.5 py-1.5 text-[13px] leading-[1.55] outline-none"
            />
          </div>

          {boards.length > 1 ? (
            <Field
              label="Board"
              value={boardId}
              onChange={setBoardId}
              options={boards.map((candidate) => ({
                value: candidate.id,
                label: `${candidate.name} · ${folderName(candidate.cwd)}`
              }))}
            />
          ) : null}

          <div className="grid grid-cols-2 gap-3">
            <Field
              label="Column"
              value={column}
              onChange={setColumn}
              options={(board?.columns ?? []).map((candidate) => ({
                value: candidate.id,
                label: candidate.name
              }))}
            />
            <Field label="Agent" value={agentId} onChange={setAgentId} options={agents} />
          </div>

          {stories.length > 0 ? (
            <Field
              label="Part of"
              value={parent}
              onChange={setParent}
              options={[
                { value: '', label: 'Nothing — a task of its own' },
                ...stories.map((story) => ({ value: story.id, label: story.title }))
              ]}
            />
          ) : null}

          <div className="text-ink-600 text-[11.5px] leading-[1.5]">
            {willRun
              ? 'Queued. It starts as soon as the scheduler has a free slot, and moves itself to In progress.'
              : 'Parked. Nothing runs until you move it to To do.'}
          </div>
        </div>

        <div className="border-ink-800 flex items-center justify-end gap-2 border-t px-4 py-3">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!prompt.trim() || busy} onClick={() => void submit()}>
            {busy ? 'Creating…' : 'Create task'}
          </Button>
        </div>
      </div>
    </div>
  )
}
