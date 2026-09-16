/**
 * Delegated reading: spotify/portal-ai-plugins/plugins/shunt, adapted.
 *
 * The idea is not compression but displacement. A file the agent reads costs
 * its whole length in this conversation, and then again on every turn after
 * it. So the reading is given to a second, cheaper model: it gets the files and
 * the question, and what comes back into this conversation is the answer. The
 * corpus never enters it at all. Upstream measures 82–94% on large reads.
 *
 * Two things are adapted rather than copied.
 *
 * Upstream reaches the worker through Portal's `aika:invoke-chat` action, one
 * shell invocation per delegation, and pays for that with a payload limit
 * (input travels through argv) and an inability to follow up. Here the second
 * model is just another entry in `provider`, called the same way the summariser
 * is, so neither limit applies — the cap below is about the worker's own
 * context window, not about `ARG_MAX`.
 *
 * Upstream also enforces the gate with hooks that block the assistant's read tool.
 * Here `read` is our own tool, so the gate is in the tool: same threshold, same
 * exemptions — a targeted read with an offset or a limit always goes through,
 * because that is the agent saying it already knows what it needs.
 *
 * The planner below is not upstream's. It is the other half of the same idea:
 * if the cheap model does the reading, the expensive one should do the
 * thinking, and only the thinking.
 */
import { generateText } from 'ai'
import type { AppConfig } from '@shared/types'
import { resolveModel } from './providers'

export { plannerModelRef, workerIsTheSameModel, workerModelRef } from '@shared/routing'

/**
 * Worth delegating above this many lines, and not below it: the round trip and
 * the worker's own reply cost something, and under a few hundred lines the
 * saving does not pay for them. Upstream's default, kept.
 */
export const DEFAULT_MIN_LINES = 350

/**
 * As much as one delegation may carry. Upstream's number, for a different
 * reason: there it is what fits in a command line, here it is a guess at what
 * fits in a cheap model's window without being silently truncated at the far
 * end, where nobody would see it happen.
 */
export const MAX_PAYLOAD_CHARS = 400_000

/** Upstream's bulk-reader mode instructions, verbatim. */
export const BULK_READER_INSTRUCTIONS =
  'You are a precise code analyst. Read the provided files and answer the question ' +
  'concisely. Output structured bullets only. No greetings, no prose, no preambles, no ' +
  'summaries. Lead every bullet with the exact name, type, or line number. Use nested ' +
  'bullets for details. Skip anything the caller did not ask for.'

/**
 * The planner's instructions. Not upstream's — shunt has no planner; this is
 * the other half of the same idea. If the cheap model does the reading, the
 * expensive one should do the thinking, and nothing else.
 */
export const PLANNER_INSTRUCTIONS =
  'You are a senior engineer asked how to do something, not to do it. You have no tools ' +
  'and you will not see the result. Answer with the plan: the steps in order, what each ' +
  'one changes, what could go wrong and how it would be noticed, and what you would check ' +
  'at the end. Name files and functions exactly when they are given to you, and say ' +
  'plainly when something has to be found out first rather than guessing at it. No ' +
  'preamble, no restating the question, no offers to help further.'

/** Upstream's code-writer mode instructions, verbatim. */
export const CODE_WRITER_INSTRUCTIONS =
  'You generate code files based on a spec and reference files. Match the existing ' +
  'patterns, conventions, naming, and style exactly. Output only the code — no ' +
  'explanations, no markdown fences unless asked. If the spec is ambiguous, make ' +
  'reasonable choices that match the patterns in the reference code.'

/**
 * The refusal a large untargeted read gets, or null when the read may proceed.
 *
 * Phrased as an instruction with the way out in it. A block that only says no
 * gets answered by the same read with a smaller limit, one page at a time,
 * which is the expensive path with extra steps.
 */
export function readRefusal(input: {
  path: string
  lines: number
  offset?: number
  limit?: number
  minLines?: number
}): string | null {
  const minLines = input.minLines ?? DEFAULT_MIN_LINES
  // The agent asked for a specific range, so it already knows what it needs.
  if (input.offset !== undefined || input.limit !== undefined) return null
  if (input.lines <= minLines) return null

  return (
    `${input.path} is ${input.lines} lines, over this session's limit of ${minLines} for ` +
    `reading a whole file into the conversation.\n\n` +
    `Use bulk_read with a question and this path instead: the file goes to another model ` +
    `and only its answer comes back here. Asking again with the same paths costs you ` +
    `nothing, so ask one question at a time rather than one question about everything.\n\n` +
    `If you need the exact text — to edit it, or to quote a line — read it again with an ` +
    `offset and a limit for the part you need. That is always allowed.`
  )
}

/**
 * The file a read-shaped shell command would pull into the conversation, or
 * null. A port of upstream's `check-bash-read`, with its exemptions:
 * a pipe or a redirect means the output is going somewhere other than here.
 */
export function bashReadTarget(command: string): string | null {
  if (command.includes('|') || command.includes('>')) return null
  const match = /^\s*(cat|head|tail|less|more)\s+(.+)$/.exec(command)
  if (!match) return null

  // Quoted arguments are read as one word. Upstream splits on whitespace, so
  // `cat "my file.md"` gave it the path `my`, which is not a file, which meant
  // no refusal and the whole file read after all — a hole in its own gate.
  for (const word of match[2].match(/'[^']*'|"[^"]*"|\S+/g) ?? []) {
    if (word.startsWith('-')) continue
    const path = word.replace(/^['"]|['"]$/g, '')
    return path || null
  }
  return null
}

/** One file, fenced by name so the worker can tell them apart. */
export function packFiles(files: { path: string; text: string }[]): string {
  return files.map((file) => `<file path="${file.path}">\n${file.text}\n</file>`).join('\n\n')
}

/**
 * Strips the markdown fence a model wraps code in however firmly it was asked
 * not to. Only an outer fence, and only when it wraps the whole answer:
 * a fence in the middle is part of the file.
 */
export function stripFences(text: string): string {
  const trimmed = text.trim()
  if (!trimmed.startsWith('```')) return trimmed
  const lines = trimmed.split('\n')
  if (lines.length < 2) return trimmed
  const last = lines[lines.length - 1].trim()
  if (last !== '```' && !/^```\w*$/.test(last)) return trimmed
  return lines.slice(1, -1).join('\n')
}

export interface WorkerAnswer {
  text: string
  usage: { input: number; output: number }
  modelRef: string
}

/** One delegated call. No tools, no history, nothing kept: it answers and ends. */
export async function askWorker(input: {
  config: AppConfig
  modelRef: string
  system: string
  prompt: string
  signal?: AbortSignal
}): Promise<WorkerAnswer> {
  const resolved = await resolveModel(input.config, input.modelRef)
  const answer = await generateText({
    model: resolved.model,
    system: input.system,
    prompt: input.prompt,
    temperature: 0.2,
    abortSignal: input.signal
  })
  return {
    text: answer.text,
    usage: {
      input: answer.usage.inputTokens ?? 0,
      output: answer.usage.outputTokens ?? 0
    },
    modelRef: input.modelRef
  }
}
