import {
  generateText,
  smoothStream,
  stepCountIs,
  streamText,
  type ModelMessage,
  type UserContent
} from 'ai'
import {
  MANAGER_AGENT,
  isManager,
  type AgentConfig,
  type AppConfig,
  type Attachment,
  type Message
} from '@shared/types'
import { mentionToken, mentionedAgents } from '@shared/mentions'
import { costOf } from '@shared/cost'
import { budgetFor } from '@shared/context'
import { effectivePermissions, resolvedConfig } from '../config'
import { bus } from '../bus'
import { cancelSessionApprovals } from '../approvals'
import { resolveModel } from '../providers'
import { getRuntime } from '../runtime'
import * as store from '../store'
import * as history from '../history'
import { createTools, type ToolContext } from './tools'
import { expandSkills } from '../skills'
import { modelAcceptsImages, readAttachment } from '../attachments'

const controllers = new Map<string, AbortController>()

export function isRunning(sessionId: string): boolean {
  return controllers.has(sessionId)
}

export function stop(sessionId: string): void {
  cancelSessionApprovals(sessionId)
  controllers.get(sessionId)?.abort()
  controllers.delete(sessionId)
  store.setSessionStatus(sessionId, 'idle')
}

/**
 * The agent every session runs. It does the work itself when the request is one
 * job, and splits it across specialists when it genuinely is several — the
 * distinction matters, because delegating a one-line change costs a round trip
 * and loses the conversation's context.
 */
function orchestrator(config: AppConfig): AgentConfig {
  const roster = Object.values(config.agent)
    .filter((a) => a.mode === 'subagent' || a.mode === 'all')
    .map((a) => `- ${mentionToken(a)} (id \`${a.id}\`): ${a.description || a.name}`)
    .join('\n')

  return {
    id: MANAGER_AGENT,
    name: 'Manager',
    description: 'Does the ordinary work, and splits off what belongs to a specialist.',
    mode: 'primary',
    color: '#d97757',
    prompt: `You are the lead engineer on this session. You decide how the work gets done.

# Specialists you can delegate to
${roster || '(none configured)'}

# When the user names one with @
\`@Name\` in the request names an agent from the list above. It is an
instruction, not a mention in passing: give that part of the work to that agent
with \`task\`, even when you could have done it yourself. If they name an agent
that is not on the list, say so rather than picking a different one.

# How to decide
Start by sizing the request.

- One coherent job, or anything that needs the thread of this conversation: do it
  yourself with your own tools. Delegating a small change costs a round trip and
  the subagent cannot see what was said here.
- Genuinely separable pieces — different parts of the system, different skills,
  or work that would otherwise be done one after another for no reason: split it.
  Say in one short line how you are splitting it and why, then call \`task\` once per
  piece **in the same step** so they run in parallel.
- Work that must happen in order: run the first stage, read what came back, then
  start the next. Do not launch a task that depends on another task's output.

Pick the agent whose description actually matches the piece. A subagent starts
with no memory of this conversation, so its prompt must stand alone: say what to
do, where, and what to report back.

When the subagents return, you own the result. Read their reports, reconcile
anything that conflicts, verify what matters, and give the user one answer —
not a list of what each agent said.

Answer in English.`
  }
}

function systemPrompt(agent: AgentConfig, input: {
  cwd: string
  environmentLabel: string
  environmentKind: string
  platform: string
  date: string
}): string {
  const base =
    agent.prompt ??
    'You are a capable software engineering agent. Answer in English.'
  return `${base}

# Environment
- Working directory: ${input.cwd}
- Execution target: ${input.environmentLabel} (${input.environmentKind})
- Platform: ${input.platform}
- Today: ${input.date}
- Agent: ${agent.name} (${agent.id})

# Rules
- Every command and file operation you request runs on the execution target above,
  not on the machine rendering this interface.
- Read a file before you edit it. Never invent a path.
- Keep each bash call to one purpose; the interface renders every call as its own
  collapsible block, so one command per idea reads far better than a chained script.
- When you are done, summarize what changed in a few lines. Do not pad the answer.
- All user-facing text you write must be in English.`
}

async function describeTarget(environmentId: string): Promise<{ platform: string }> {
  try {
    const runtime = getRuntime(environmentId)
    if (runtime.kind === 'local') return { platform: `${process.platform} ${process.arch}` }
    const res = await runtime.exec('uname -sm', { cwd: '/', timeoutMs: 10_000 })
    return { platform: res.stdout.trim() || 'unknown' }
  } catch {
    return { platform: 'unknown' }
  }
}

/**
 * Text files are inlined — every model can read them and it keeps the
 * transcript reproducible. Images are only attached when the model has been
 * declared able to read them; otherwise they are named in the text so the model
 * knows something was left out rather than answering as if nothing was sent.
 */
export function buildUserMessage(
  config: AppConfig,
  model: string,
  text: string,
  attachments: Attachment[] | undefined
): ModelMessage {
  if (!attachments || attachments.length === 0) return { role: 'user', content: text }

  const parts: Extract<UserContent, unknown[]> = []

  const images = attachments.filter((a) => a.kind === 'image')
  const texts = attachments.filter((a) => a.kind === 'text')
  const canSeeImages = modelAcceptsImages(config, model)

  for (const file of texts) {
    parts.push({
      type: 'text',
      text: `<file name="${file.name}" media-type="${file.mediaType}">\n${file.text ?? ''}\n</file>`
    })
  }

  if (canSeeImages) {
    for (const image of images) {
      const bytes = readAttachment(image)
      if (bytes) parts.push({ type: 'image', image: bytes, mediaType: image.mediaType })
    }
  } else if (images.length > 0) {
    parts.push({
      type: 'text',
      text:
        `[${images.length} image${images.length === 1 ? '' : 's'} were attached (${images
          .map((image) => image.name)
          .join(', ')}) but this model is not configured to read images, so they were not sent. ` +
        `Say so rather than guessing at their contents.]`
    })
  }

  parts.push({ type: 'text', text })
  return { role: 'user', content: parts }
}

/**
 * Resolves the `@names` in a message to agent ids for the model.
 *
 * The visible message keeps what the user typed. The model is handed the
 * mapping as well, because a display name is not an id and guessing between
 * "Infrastructure" and `infra` is exactly the kind of near-miss that ends with
 * the wrong specialist doing the work.
 */
function mentionDirective(config: AppConfig, text: string): string {
  const agents = Object.values(config.agent)
  const ids = mentionedAgents(text, agents)
  if (ids.length === 0) return ''

  const lines = ids
    .map((id) => `- ${mentionToken(config.agent[id])} is the agent with id \`${id}\``)
    .join('\n')

  return (
    `\n\n<agents-the-user-named>\n${lines}\n` +
    `Hand the work they named to these agents with \`task\`, using those ids.\n` +
    `</agents-the-user-named>`
  )
}

/**
 * Summarises the older half of a session's transcript once it outgrows the
 * context window, and leaves a line in the chat saying so.
 *
 * Done after the turn rather than before: the user has their answer, and the
 * cost of the summary is paid out of sight instead of in front of them.
 */
/**
 * Shrinks what the next turn will resend, cheapest thing first.
 *
 * Dropping the body of old tool results costs nothing and often saves more than
 * a summary would, so it runs first and the summariser is only asked if the
 * transcript is still over budget afterwards. The measured token count came
 * from the prefix *as it was sent*, so what the free pass just removed is
 * subtracted before deciding — otherwise a session would pay for a summary it
 * no longer needs.
 */
async function tighten(
  config: AppConfig,
  sessionId: string,
  modelRef: string,
  measuredTokens: number
): Promise<void> {
  const freed = history.dehydrateHistory(sessionId, {
    afterTurns: config.dehydrateAfterTurns,
    overChars: config.dehydrateOverChars
  })
  const projected = Math.max(0, measuredTokens - freed.freedTokens)
  const compacted = await compactIfNeeded(config, sessionId, modelRef, projected)

  /*
   * What the next turn will actually send. Measured while nothing was removed;
   * estimated when something was, because the provider has not seen the new
   * shape yet and an estimate that is roughly right beats a measurement that is
   * certainly stale. The gauge this feeds would otherwise sit at the
   * pre-compaction figure until the turn after next.
   */
  store.updateSession(sessionId, {
    contextTokens:
      compacted || freed.dropped > 0 ? history.estimateTokens(history.getHistory(sessionId)) : projected
  })
}

async function compactIfNeeded(
  config: AppConfig,
  sessionId: string,
  modelRef: string,
  measuredTokens: number,
  force = false
): Promise<boolean> {
  // The smaller model if one is configured: this is a summary, not the work.
  const ref = config.smallModel ?? modelRef

  const result = await history.compactHistory(
    sessionId,
    async ({ previous, messages }) => {
      const resolved = await resolveModel(config, ref)
      const answer = await generateText({
        model: resolved.model,
        system:
          'You are maintaining a running summary of a working session so it can replace the ' +
          'messages it covers in the model\'s context. Write it for whoever picks the work up ' +
          'next. Keep: decisions and why, files created or changed with their paths, commands ' +
          'whose result mattered, facts established about the system, and anything still open. ' +
          'Drop: greetings, restatements, and tool output that no longer matters. Use short ' +
          'sections, name things exactly, and never invent a detail that is not there.' +
          (previous
            ? ' You are given an existing summary and the messages that came after it. Merge ' +
              'them into one summary. Everything in the existing summary stays unless the new ' +
              'messages contradict it — it covers work you can no longer see, so dropping a ' +
              'fact from it loses that fact for good.'
            : ''),
        prompt:
          // The previous summary goes in whole and unabridged. Passed as just
          // another message it would be truncated like the rest, and it is the
          // one artefact holding the oldest decisions in the session.
          (previous ? `<existing-summary>\n${previous}\n</existing-summary>\n\n` : '') +
          `<new-messages>\n${messages
            .map((message) => {
              const content =
                typeof message.content === 'string'
                  ? message.content
                  : JSON.stringify(message.content)
              return `[${message.role}] ${content.slice(0, 4000)}`
            })
            .join('\n\n')}\n</new-messages>`
      })
      return answer.text
    },
    {
      measuredTokens,
      budgetTokens: budgetFor(config, modelRef),
      fraction: config.compactAtFraction,
      keepRecent: config.keepRecentMessages,
      force
    }
  )

  if (!result) return false

  // Said out loud in the transcript, at the point it happened.
  store.addMessage({
    sessionId,
    role: 'system',
    parts: [
      {
        type: 'text',
        text:
          `The ${result.summarised} messages before this were summarised to stay inside the ` +
          `context window${result.total > result.summarised ? `, ${result.total} in total so far` : ''}.` +
          `\n\n${result.summary}`
      }
    ]
  })
  return true
}

/**
 * Summarises now, whatever the budget says.
 *
 * A person knows a thread of work is finished before any threshold does, and
 * the hour behind them is dead weight they can see and the app cannot.
 */
export async function compactNow(sessionId: string): Promise<boolean> {
  const session = store.getSession(sessionId)
  if (!session) return false
  const config = resolvedConfig()
  const agent = config.agent[session.agentId]
  const modelRef = agent?.model ?? session.model
  const done = await compactIfNeeded(config, sessionId, modelRef, 0, true)
  store.updateSession(sessionId, {
    contextTokens: history.estimateTokens(history.getHistory(sessionId))
  })
  return done
}

interface TurnInput {
  sessionId: string
  userText: string
  attachments?: Attachment[]
  /** Set for subagent turns so the reply is returned instead of only rendered. */
  collectFinalText?: boolean
  depth?: number
  parentBlockId?: string
  /** Appended to the system prompt when other agents are working nearby. */
  coordinationNote?: string
}

export async function runTurn(input: TurnInput): Promise<string> {
  const session = store.getSession(input.sessionId)
  if (!session) throw new Error(`unknown session ${input.sessionId}`)
  if (controllers.has(session.id)) throw new Error('This session is already running.')

  const config = resolvedConfig()
  const agent =
    isManager(session.agentId) || !config.agent[session.agentId]
      ? orchestrator(config)
      : config.agent[session.agentId]
  const controller = new AbortController()
  controllers.set(session.id, controller)

  // The transcript keeps what the user typed; the model gets the skills it named.
  const expanded = expandSkills(input.userText)
  store.addMessage({
    sessionId: session.id,
    role: 'user',
    parts: [{ type: 'text', text: input.userText }],
    attachments: input.attachments
  })
  if (session.title === 'New session' || session.title === 'New task') {
    store.updateSession(session.id, {
      title: input.userText.replace(/\s+/g, ' ').slice(0, 70) || 'New session'
    })
  }
  // A reply is the answer to whatever it was blocked on, so the reason goes.
  store.updateSession(session.id, { status: 'running', blockedReason: undefined })

  const assistant: Message = store.addMessage({
    sessionId: session.id,
    role: 'assistant',
    parts: [],
    agentId: agent.id,
    model: session.model
  })

  let finalText = ''

  try {
    const runtime = getRuntime(session.environmentId)
    await runtime.connect()
    const { platform } = await describeTarget(session.environmentId)
    const resolved = await resolveModel(config, agent.model ?? session.model)

    const ctx: ToolContext = {
      config,
      agent,
      permissions: effectivePermissions(config, agent.id),
      sessionId: session.id,
      environmentId: session.environmentId,
      cwd: session.cwd,
      runtime,
      signal: controller.signal,
      currentMessageId: () => assistant.id,
      depth: input.depth ?? 0,
      parentBlockId: input.parentBlockId,
      spawnSubagent: async ({ agentId, prompt, description, parentBlockId }) => {
        const child = store.createSession({
          title: description,
          cwd: session.cwd,
          environmentId: session.environmentId,
          agentId,
          model: config.agent[agentId]?.model ?? session.model,
          parentSessionId: session.id
        })
        store.updateSession(child.id, { taskLabel: description })
        const report = await runTurn({
          sessionId: child.id,
          userText: prompt,
          collectFinalText: true,
          depth: (input.depth ?? 0) + 1,
          parentBlockId
        })
        return { sessionId: child.id, report: report || '(the subagent returned no text)' }
      }
    }

    const tools = createTools(ctx)

    const userMessage = buildUserMessage(
      config,
      session.model,
      expanded.prompt + mentionDirective(config, input.userText),
      input.attachments
    )
    const messages: ModelMessage[] = [...history.getHistory(session.id), userMessage]
    history.appendHistory(session.id, [userMessage])

    const result = streamText({
      model: resolved.model,
      system:
        systemPrompt(agent, {
          cwd: session.cwd,
          environmentLabel: runtime.label,
          environmentKind: runtime.kind,
          platform,
          date: new Date().toISOString().slice(0, 10)
        }) + (input.coordinationNote ?? ''),
      messages,
      tools,
      temperature: agent.temperature,
      stopWhen: stepCountIs(config.maxSteps),
      // Providers emit text in lumps of wildly varying size — a whole paragraph
      // in one chunk, then three characters. Re-chunking by word at a steady
      // cadence makes the transcript read as it is written instead of jumping.
      // Set smoothStreamMs to 0 to see the provider's own chunking instead.
      ...((config.smoothStreamMs ?? 10) > 0
        ? {
            experimental_transform: smoothStream({
              delayInMs: config.smoothStreamMs ?? 10,
              chunking: 'word'
            })
          }
        : {}),
      abortSignal: controller.signal,
      onError: ({ error }) => {
        store.pushPart(session.id, assistant.id, {
          type: 'error',
          text: (error as Error)?.message ?? String(error)
        })
      }
    })

    let textPartIndex = -1
    let reasoningPartIndex = -1
    // Accumulated as each step reports it, so the transcript can show a real
    // count while the turn is still going rather than an estimate from
    // characters. Input is summed across steps because every step resends the
    // conversation, which is what the turn actually costs.
    let usedInput = 0
    let usedOutput = 0
    // The last step's input is the size of the assembled prefix. The sum across
    // steps is what the turn cost; it is not how full the window is.
    let lastStepInput = 0

    for await (const part of result.fullStream) {
      if (controller.signal.aborted) break
      switch (part.type) {
        case 'text-delta': {
          if (textPartIndex === -1) {
            textPartIndex = store.pushPart(session.id, assistant.id, { type: 'text', text: '' })
          }
          finalText += part.text
          store.appendPartText(session.id, assistant.id, textPartIndex, part.text)
          break
        }
        case 'reasoning-delta': {
          if (reasoningPartIndex === -1) {
            reasoningPartIndex = store.pushPart(session.id, assistant.id, { type: 'reasoning', text: '' })
          }
          store.appendPartText(session.id, assistant.id, reasoningPartIndex, part.text)
          break
        }
        case 'finish-step': {
          lastStepInput = part.usage.inputTokens ?? lastStepInput
          usedInput += part.usage.inputTokens ?? 0
          usedOutput += part.usage.outputTokens ?? 0
          const so_far = costOf(config, agent.model ?? session.model, {
            input: usedInput,
            output: usedOutput
          })
          store.updateMessage(session.id, assistant.id, {
            usage: {
              input: usedInput,
              output: usedOutput,
              ...(so_far === null ? {} : { cost: so_far })
            }
          })
          break
        }
        case 'tool-call':
          // The block is created by the tool itself, which knows its own shape.
          // Resetting the text cursor keeps prose after a tool call in its own bubble.
          textPartIndex = -1
          reasoningPartIndex = -1
          break
        case 'error': {
          store.pushPart(session.id, assistant.id, {
            type: 'error',
            text: (part.error as Error)?.message ?? String(part.error)
          })
          break
        }
        default:
          break
      }
    }

    const responseMessages = await result.responseMessages
    history.appendHistory(session.id, responseMessages as ModelMessage[])
    await tighten(config, session.id, agent.model ?? session.model, lastStepInput)

    const usage = await result.totalUsage
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    // Worked out now and kept on the message: a price edited next week must not
    // change what this turn is recorded as having cost.
    const turnCost = costOf(config, agent.model ?? session.model, {
      input: inputTokens,
      output: outputTokens
    })
    store.updateMessage(session.id, assistant.id, {
      completedAt: Date.now(),
      usage: {
        input: inputTokens,
        output: outputTokens,
        ...(turnCost === null ? {} : { cost: turnCost })
      }
    })
    // The agent may have handed the task back mid-turn; finishing the turn
    // does not un-block it, so the status it set is left alone.
    const ended = store.getSession(session.id)
    store.updateSession(session.id, {
      status: ended?.status === 'blocked' ? 'blocked' : 'idle',
      usage: {
        input: session.usage.input + inputTokens,
        output: session.usage.output + outputTokens,
        cost: session.usage.cost + (turnCost ?? 0)
      }
    })
  } catch (err) {
    const message = (err as Error).message ?? String(err)
    const aborted = controller.signal.aborted || /abort/i.test(message)
    store.pushPart(session.id, assistant.id, {
      type: 'error',
      text: aborted ? 'Stopped by the user.' : message
    })
    store.updateMessage(session.id, assistant.id, { completedAt: Date.now() })
    store.setSessionStatus(session.id, aborted ? 'idle' : 'error')
    if (!aborted) bus.emit({ type: 'toast', level: 'error', message })
  } finally {
    controllers.delete(session.id)
    if (store.getSession(session.id)?.status === 'running') store.setSessionStatus(session.id, 'idle')
    store.flush()
  }

  return input.collectFinalText ? finalText : ''
}

export function stopAll(): void {
  for (const id of [...controllers.keys()]) stop(id)
}
