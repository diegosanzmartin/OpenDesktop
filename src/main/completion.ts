import { generateText } from 'ai'
import { z } from 'zod'
import type { AppConfig } from '@shared/types'
import { costOf } from '@shared/cost'
import { logLine } from './log'
import { record as meterRecord } from './meter'
import { resolveModel } from './providers'

/**
 * Did the turn really finish what was asked?
 *
 * After GitHub Copilot's Autopilot. A turn that did work is compared, by a
 * small model with no reasoning, with what the person asked; when a concrete
 * part is neither done nor explained, the turn carries on with that named —
 * at most twice for one message. An agent saying why it could not do something
 * counts as finished: the point is the step it forgot, not the one it refused.
 */

export interface CompletionQuestion {
  /** What the person asked, as they typed it. */
  asked: string
  /** What the turn did and said: the calls it made and its last words. */
  did: string
}

export interface CompletionVerdict {
  done: boolean
  missing?: string
}

type Judge = (question: CompletionQuestion) => Promise<CompletionVerdict | null>

let judgeOverride: Judge | null = null

/** Test seam: drives the whole path without a provider. */
export function setCompletionJudge(judge: Judge | null): void {
  judgeOverride = judge
}

const VERDICT = z.object({ reason: z.string().optional(), missing: z.string().optional(), done: z.boolean() })

const SYSTEM =
  'You check whether an AI coding agent finished what a person asked. Compare the request with what ' +
  'the agent did and said. It is finished when every concrete part of the request was done, or the ' +
  'agent said plainly why it was not; a question answered is finished. It is not finished only when a ' +
  'concrete part was skipped without a word. Answer with JSON only, reason first: ' +
  '{"reason":"one short sentence","missing":"what is left, empty when finished","done":bool}.'

/** The verdict, or null when the check could not be made (the turn then simply ends). */
export async function checkCompletion(config: AppConfig, question: CompletionQuestion): Promise<CompletionVerdict | null> {
  try {
    if (judgeOverride) return await judgeOverride(question)
    const ref = config.smallModel ?? config.model
    const resolved = await resolveModel(config, ref)
    const result = await generateText({
      model: resolved.model,
      system: SYSTEM,
      prompt: `Request:\n${question.asked.slice(0, 4000)}\n\nWhat the agent did and said:\n${question.did.slice(0, 6000)}\n\nJSON:`,
      // A yes or no in JSON needs no thinking, and the person is waiting on the turn.
      reasoning: 'none',
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(30_000)
    })
    const usage = { input: result.usage.inputTokens ?? 0, output: result.usage.outputTokens ?? 0 }
    meterRecord(ref, { ...usage, cost: costOf(config, ref, usage) ?? 0 })
    const match = result.text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error(`no JSON in the completion check's answer: ${result.text.slice(0, 300)}`)
    const verdict = VERDICT.parse(JSON.parse(match[0]))
    return { done: verdict.done, ...(verdict.missing?.trim() ? { missing: verdict.missing.trim() } : {}) }
  } catch (error) {
    const detail = error instanceof Error ? `${error.name}: ${error.message}\n${error.stack ?? ''}` : String(error)
    logLine('warn', `completion check could not run; the turn ends as it is\n${detail.slice(0, 2000)}`)
    return null
  }
}

export function unfinishedNote(missing: string): string {
  return (
    `<check>A check of the request against what was done says it is not finished: ${missing}. ` +
    `Finish that part, or say plainly why you cannot. Do not redo what is already done.</check>`
  )
}
