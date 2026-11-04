import type { AppConfig } from '@shared/types'
import type { Runtime } from './runtime'
import * as store from './store'
import { logLine } from './log'

/**
 * Checking an edit before the agent calls it done.
 *
 * Aider, OpenCode and Claude Code run the project's lint or tests after an edit
 * and hand the failure straight back, so the agent fixes its own breakage
 * instead of reporting success over a red build. Here the person names the
 * check per folder (`verify` in the config); it runs once after a step that
 * wrote or edited a file, is shown as a block, and on failure its output is the
 * next thing the model reads.
 */

const TIMEOUT_MS = 120_000
const SHOWN = 3_000

/** The check for the deepest configured folder that holds `cwd`, or null. */
export function verifyCommandFor(config: AppConfig, cwd: string): string | null {
  let best: { folder: string; command: string } | null = null
  for (const [folder, command] of Object.entries(config.verify ?? {})) {
    const root = folder.replace(/\/+$/, '')
    const holds = cwd === root || cwd.startsWith(`${root}/`)
    if (holds && (!best || root.length > best.folder.length)) best = { folder: root, command }
  }
  return best?.command ?? null
}

/** Runs the check as a block of the turn; the note for the model when it failed, else null. */
export async function runVerify(input: {
  command: string
  runtime: Runtime
  cwd: string
  sessionId: string
  messageId: string
  environmentId: string
  agentId: string
  signal: AbortSignal
}): Promise<string | null> {
  const block = store.createBlock({
    sessionId: input.sessionId,
    messageId: input.messageId,
    tool: 'verify',
    title: input.command,
    subtitle: 'Checking the edit',
    input: { command: input.command },
    cwd: input.cwd,
    environmentId: input.environmentId,
    agentId: input.agentId,
    status: 'running',
    startedAt: Date.now()
  })
  store.pushPart(input.sessionId, input.messageId, { type: 'block', blockId: block.id })
  try {
    const result = await input.runtime.exec(input.command, {
      cwd: input.cwd,
      timeoutMs: TIMEOUT_MS,
      signal: input.signal
    })
    const output = `${result.stdout}${result.stderr ? `\n${result.stderr}` : ''}`.trim()
    const passed = result.exitCode === 0
    store.updateBlock(input.sessionId, block.id, {
      status: passed ? 'success' : 'error',
      output,
      exitCode: result.exitCode,
      endedAt: Date.now()
    })
    if (passed) return null
    const tail = output.length > SHOWN ? `…${output.slice(-SHOWN)}` : output
    return (
      `<verify>\`${input.command}\` failed after your edits (exit ${result.exitCode}):\n${tail}\n` +
      `Fix what it reports before you call the work done.</verify>`
    )
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
    logLine('warn', `verify could not run \`${input.command}\` in ${input.cwd}\n${detail.slice(0, 2000)}`)
    store.updateBlock(input.sessionId, block.id, { status: 'error', error: String(error), endedAt: Date.now() })
    return null
  }
}
