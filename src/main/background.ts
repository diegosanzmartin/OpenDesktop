import { nanoid } from 'nanoid'
import type { BackgroundTask } from '@shared/types'
import { bus } from './bus'
import { getRuntime } from './runtime'
import { getSession } from './store'

/**
 * Anything the agent chose not to wait for. A log follow or a dev server, but
 * equally a query, an export or a build that takes a while and does not need to
 * hold up the turn — the decision is the agent's, not a property of the command.
 *
 * These are built on the same `exec` every other command uses. Not awaiting its
 * promise gives the start; its `onChunk` gives the live output; aborting its
 * signal is the kill. Nothing here needs a second execution path, so local and
 * remote behave identically for free.
 */
interface Running {
  task: BackgroundTask
  controller: AbortController
}

const tasks = new Map<string, Running>()
const OUTPUT_CAP = 400_000

function publish(task: BackgroundTask): void {
  bus.emit({ type: 'background.updated', task: { ...task } })
}

/**
 * The chat a task belongs to. A subagent works in its own session, but its
 * background work is the parent conversation's, so it is listed there. The root
 * is resolved once at start rather than walked on every read, so it survives
 * the child session being deleted afterwards.
 */
function rootOf(sessionId: string): string {
  const seen = new Set<string>()
  let current = sessionId
  for (;;) {
    if (seen.has(current)) return current
    seen.add(current)
    const parent = getSession(current)?.parentSessionId
    if (!parent) return current
    current = parent
  }
}

export function startBackgroundTask(input: {
  sessionId: string
  command: string
  description: string
  cwd: string
  environmentId: string
  agentId: string
}): BackgroundTask {
  const controller = new AbortController()
  const task: BackgroundTask = {
    id: nanoid(10),
    sessionId: input.sessionId,
    rootSessionId: rootOf(input.sessionId),
    command: input.command,
    description: input.description,
    cwd: input.cwd,
    environmentId: input.environmentId,
    agentId: input.agentId,
    status: 'running',
    startedAt: Date.now(),
    readOffset: 0,
    output: ''
  }

  const entry: Running = { task, controller }
  tasks.set(task.id, entry)
  publish(task)

  const runtime = getRuntime(input.environmentId)
  void runtime
    .connect()
    .then(() =>
      runtime.exec(input.command, {
        cwd: input.cwd,
        signal: controller.signal,
        // No timeout: outliving the turn is the entire point.
        onChunk: (chunk) => {
          if (task.output.length < OUTPUT_CAP) task.output += chunk
          bus.emit({ type: 'background.output', taskId: task.id, sessionId: task.sessionId, chunk })
        }
      })
    )
    .then((result) => {
      task.status = controller.signal.aborted ? 'killed' : 'exited'
      task.exitCode = result.exitCode
      task.endedAt = Date.now()
      publish(task)
    })
    .catch((err: Error) => {
      task.status = controller.signal.aborted ? 'killed' : 'failed'
      task.error = err.message
      task.endedAt = Date.now()
      publish(task)
    })

  return { ...task }
}

/**
 * What has arrived since the agent last looked. Returning only the new output
 * is what lets it poll a long-running task without re-reading the whole log.
 */
export function readBackgroundOutput(id: string, peek = false): {
  task: BackgroundTask
  chunk: string
} | null {
  const entry = tasks.get(id)
  if (!entry) return null
  const chunk = entry.task.output.slice(entry.task.readOffset)
  if (!peek) {
    entry.task.readOffset = entry.task.output.length
    publish(entry.task)
  }
  return { task: { ...entry.task }, chunk }
}

export function killBackgroundTask(id: string): BackgroundTask | null {
  const entry = tasks.get(id)
  if (!entry) return null
  if (entry.task.status === 'running') {
    entry.controller.abort()
    entry.task.status = 'killed'
    entry.task.endedAt = Date.now()
    publish(entry.task)
  }
  return { ...entry.task }
}

/** Everything belonging to a chat, including what its subagents started. */
export function listBackgroundTasks(sessionId?: string): BackgroundTask[] {
  return [...tasks.values()]
    .map((entry) => ({ ...entry.task }))
    .filter(
      (task) => !sessionId || task.rootSessionId === sessionId || task.sessionId === sessionId
    )
    .sort((a, b) => b.startedAt - a.startedAt)
}

/** Forgets finished tasks; a running one is left alone. */
export function clearFinished(sessionId?: string): number {
  let removed = 0
  for (const [id, entry] of [...tasks.entries()]) {
    if (entry.task.status === 'running') continue
    if (sessionId && entry.task.rootSessionId !== sessionId) continue
    tasks.delete(id)
    removed++
  }
  if (removed > 0) bus.emit({ type: 'background.cleared', sessionId: sessionId ?? null })
  return removed
}

export function killSessionTasks(sessionId: string): void {
  for (const entry of tasks.values()) {
    const mine = entry.task.rootSessionId === sessionId || entry.task.sessionId === sessionId
    if (mine && entry.task.status === 'running') {
      entry.controller.abort()
    }
  }
}

export function killAllBackgroundTasks(): void {
  for (const entry of tasks.values()) entry.controller.abort()
  tasks.clear()
}

/** A one-line summary for the model, so it can decide whether to keep waiting. */
export function describeForModel(task: BackgroundTask): string {
  const state =
    task.status === 'running'
      ? 'still running'
      : task.status === 'exited'
        ? task.exitCode
          ? `failed with exit code ${task.exitCode}`
          : 'finished successfully'
        : task.status
  return `Background task ${task.id} (${task.description}) is ${state}.`
}
