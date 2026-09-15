import clsx from 'clsx'
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { ChevronRight, Square, Trash2 } from 'lucide-react'
import type { BackgroundTask } from '@shared/types'
import { useStore } from '../state/store'
import { stripAnsi, timeAgo } from '../lib/format'
import { Button } from './ui'

interface Tone {
  label: string
  tone: string
  dot: string
}

/**
 * A command that exited non-zero has not "finished" in any useful sense, so it
 * reads as a failure with its code rather than as a success.
 */
function toneOf(task: BackgroundTask): Tone {
  switch (task.status) {
    case 'running':
      return { label: 'Running', tone: 'text-info', dot: 'bg-info' }
    case 'killed':
      return { label: 'Stopped', tone: 'text-ink-500', dot: 'bg-ink-600' }
    case 'failed':
      return { label: 'Failed', tone: 'text-bad', dot: 'bg-bad' }
    default:
      return task.exitCode && task.exitCode !== 0
        ? { label: 'Failed', tone: 'text-bad', dot: 'bg-bad' }
        : { label: 'Finished', tone: 'text-ok', dot: 'bg-ok' }
  }
}

/** How long it has been going, ticking while it runs. */
function elapsed(task: BackgroundTask, now: number): string {
  const ms = Math.max(0, (task.endedAt ?? now) - task.startedAt)
  const seconds = Math.floor(ms / 1000)
  if (seconds < 60) return `${seconds}s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

function TaskCard({ task, now }: { task: BackgroundTask; now: number }): ReactNode {
  const [open, setOpen] = useState(task.status === 'running')
  const status = toneOf(task)
  const output = useMemo(() => stripAnsi(task.output), [task.output])

  return (
    <div className="border-ink-800 bg-ink-850/40 overflow-hidden rounded-lg border">
      <div className="flex items-start gap-2 px-3 py-2">
        <span
          className={clsx(
            'mt-[5px] h-2 w-2 shrink-0 rounded-full',
            status.dot,
            task.status === 'running' && 'animate-pulse'
          )}
        />
        <button type="button" onClick={() => setOpen(!open)} className="min-w-0 flex-1 text-left">
          <div className="text-ink-200 truncate text-[12.5px]">{task.description}</div>
          <div className="text-ink-500 mt-0.5 truncate font-mono text-[11px]">{task.command}</div>
          <div className="text-ink-600 mt-1 flex flex-wrap items-center gap-x-2 text-[10.5px]">
            <span className={status.tone}>{status.label}</span>
            <span>·</span>
            <span>{elapsed(task, now)}</span>
            {task.exitCode !== undefined && task.status !== 'running' ? (
              <>
                <span>·</span>
                <span>exit {task.exitCode}</span>
              </>
            ) : null}
            <span>·</span>
            <span className="truncate">{task.environmentId}</span>
            <Origin task={task} />
            <span>·</span>
            <span>{timeAgo(task.startedAt)}</span>
          </div>
        </button>

        <div className="flex shrink-0 items-center gap-0.5">
          {task.status === 'running' ? (
            <Button
              size="sm"
              variant="danger"
              title="Stop"
              onClick={() => void window.opendesktop.background.kill(task.id)}
            >
              <Square className="h-3 w-3" />
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => setOpen(!open)}
            className="text-ink-600 hover:text-ink-300 rounded p-1"
          >
            <ChevronRight className={clsx('h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
          </button>
        </div>
      </div>

      {open ? (
        <div className="border-ink-800 border-t">
          {task.error ? (
            <div className="text-bad bg-bad/5 px-3 py-2 font-mono text-[11px] whitespace-pre-wrap">
              {task.error}
            </div>
          ) : null}
          <pre className="text-ink-300 max-h-72 overflow-auto px-3 py-2 font-mono text-[11px] leading-[1.55] whitespace-pre-wrap break-all">
            {output || (task.status === 'running' ? 'waiting for output…' : 'no output')}
          </pre>
          <div className="border-ink-800 text-ink-600 flex items-center gap-2 border-t px-3 py-1.5 text-[10.5px]">
            <span className="font-mono">{task.cwd}</span>
            <span>·</span>
            <span>{task.agentId}</span>
            {task.readOffset < task.output.length ? (
              <span className="text-warn ml-auto">
                {task.output.length - task.readOffset} characters the agent has not read yet
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  )
}

/** Named when a subagent started it, since the card sits in the parent's list. */
function Origin({ task }: { task: BackgroundTask }): ReactNode {
  const sessions = useStore((s) => s.sessions)
  const config = useStore((s) => s.config)
  if (task.sessionId === task.rootSessionId) return null

  const child = sessions.find((session) => session.id === task.sessionId)
  const agent = config?.agent[task.agentId]
  return (
    <>
      <span>·</span>
      <span style={{ color: agent?.color ?? undefined }}>
        {agent?.name ?? task.agentId}
        {child?.taskLabel ? `: ${child.taskLabel}` : ''}
      </span>
    </>
  )
}

export function BackgroundTasksPane(): ReactNode {
  const sessionId = useStore((s) => s.activeSessionId)
  const tasks = useStore((s) => s.backgroundTasks)
  const refresh = useStore((s) => s.refreshBackgroundTasks)
  const [now, setNow] = useState(Date.now())

  // Only this chat's, including whatever its subagents started.
  const mine = useMemo(
    () => tasks.filter((task) => task.rootSessionId === sessionId || task.sessionId === sessionId),
    [tasks, sessionId]
  )
  const running = mine.filter((task) => task.status === 'running')
  const finished = mine.filter((task) => task.status !== 'running')

  useEffect(() => {
    void refresh()
  }, [sessionId, refresh])

  useEffect(() => {
    if (running.length === 0) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [running.length])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="border-ink-800 flex items-center gap-2 border-b px-3 py-2">
        <span className="text-ink-500 text-[11.5px]">
          {running.length} running · {finished.length} finished
        </span>
        {finished.length > 0 ? (
          <Button
            size="sm"
            className="ml-auto"
            title="Forget the finished ones"
            onClick={async () => {
              await window.opendesktop.background.clear(sessionId ?? undefined)
              await refresh()
            }}
          >
            <Trash2 className="h-3 w-3" />
            Clear finished
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
        {mine.length === 0 ? (
          <div className="text-ink-600 px-3 py-8 text-center text-[12px] leading-[1.6]">
            Nothing in the background yet.
            <div className="mt-1.5">
              Whatever the agent decides not to wait for shows up here — a log follow or a dev
              server, but equally a query or an export that takes a while. Work its subagents
              start counts as this chat's too.
            </div>
          </div>
        ) : (
          <>
            {running.map((task) => (
              <TaskCard key={task.id} task={task} now={now} />
            ))}
            {finished.length > 0 && running.length > 0 ? (
              <div className="text-ink-600 px-1 pt-1 text-[10.5px] uppercase tracking-[0.08em]">
                Finished
              </div>
            ) : null}
            {finished.map((task) => (
              <TaskCard key={task.id} task={task} now={now} />
            ))}
          </>
        )}
      </div>
    </div>
  )
}
