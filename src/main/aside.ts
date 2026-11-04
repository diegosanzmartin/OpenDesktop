import { streamText } from 'ai'
import { costOf } from '@shared/cost'
import { liveConversation } from './agent/runner'
import { resolvedConfig } from './config'
import { getHistory } from './history'
import { logLine } from './log'
import { record as meterRecord } from './meter'
import { resolveModel } from './providers'
import * as store from './store'

/**
 * A side question: `/btw` in Claude Code.
 *
 * It sees the conversation — the running turn too, as its latest step was
 * handed it — and the conversation never sees it: no tools, nothing saved, and
 * the turn carries on untouched. The answer is shown once and then gone.
 */

export type AsideAnswer = { text: string } | { error: string }

const SYSTEM =
  'You answer a quick side question about the conversation so far. You cannot run tools or change ' +
  'anything: answer briefly from what is already in the conversation, and say so when it is not there.'

/** The calls under way: the step that made them is not in the conversation until they return. */
function runningNow(sessionId: string): string {
  const lines = store
    .listBlocks(sessionId)
    .filter((block) => block.status === 'running')
    .map((block) => `${block.tool}: ${(block.input as { command?: string } | undefined)?.command ?? block.title}`)
  return lines.length > 0 ? `<running-now>\n${lines.join('\n')}\n</running-now>\n\n` : ''
}

export async function askAside(sessionId: string, question: string): Promise<AsideAnswer> {
  const session = store.getSession(sessionId)
  if (!session) return { error: 'That conversation is gone.' }
  let failure: unknown
  try {
    const config = resolvedConfig()
    const resolved = await resolveModel(config, session.model)
    const result = streamText({
      model: resolved.model,
      system: SYSTEM,
      messages: [
        ...(liveConversation(sessionId) ?? getHistory(sessionId)),
        { role: 'user', content: runningNow(sessionId) + question }
      ],
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(60_000),
      onError: ({ error }) => {
        failure = error
      }
    })
    const text = await result.text
    if (failure) throw failure
    const usage = await result.usage
    const used = { input: usage.inputTokens ?? 0, output: usage.outputTokens ?? 0 }
    meterRecord(session.model, { ...used, cost: costOf(config, session.model, used) ?? 0 })
    return { text }
  } catch (error) {
    const cause = failure ?? error
    const detail = cause instanceof Error ? `${cause.name}: ${cause.message}\n${cause.stack ?? ''}` : String(cause)
    logLine('warn', `side question failed in ${sessionId}\n${detail.slice(0, 2000)}`)
    return { error: cause instanceof Error ? cause.message : String(cause) }
  }
}
