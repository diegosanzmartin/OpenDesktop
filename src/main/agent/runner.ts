import { smoothStream, stepCountIs, streamText, type ModelMessage } from 'ai'
import { AUTO_AGENT, type AgentConfig, type AppConfig, type Message } from '@shared/types'
import { effectivePermissions, resolvedConfig } from '../config'
import { bus } from '../bus'
import { cancelSessionApprovals } from '../approvals'
import { resolveModel } from '../providers'
import { getRuntime } from '../runtime'
import * as store from '../store'
import * as history from '../history'
import { createTools, type ToolContext } from './tools'
import { expandSkills } from '../skills'

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
 * The default when no agent is pinned. It does the work itself when the request
 * is one job, and splits it across specialists when it genuinely is several —
 * the distinction matters, because delegating a one-line change costs a round
 * trip and loses the conversation's context.
 */
function orchestrator(config: AppConfig): AgentConfig {
  const roster = Object.values(config.agent)
    .filter((a) => a.mode === 'subagent' || a.mode === 'all')
    .map((a) => `- ${a.id}: ${a.description || a.name}`)
    .join('\n')

  return {
    id: AUTO_AGENT,
    name: 'Auto',
    description: 'Splits the request across specialist agents when that helps.',
    mode: 'primary',
    color: '#d97757',
    prompt: `You are the lead engineer on this session. You decide how the work gets done.

# Specialists you can delegate to
${roster || '(none configured)'}

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

interface TurnInput {
  sessionId: string
  userText: string
  /** Set for subagent turns so the reply is returned instead of only rendered. */
  collectFinalText?: boolean
  depth?: number
  parentBlockId?: string
}

export async function runTurn(input: TurnInput): Promise<string> {
  const session = store.getSession(input.sessionId)
  if (!session) throw new Error(`unknown session ${input.sessionId}`)
  if (controllers.has(session.id)) throw new Error('This session is already running.')

  const config = resolvedConfig()
  const agent =
    session.agentId === AUTO_AGENT || !config.agent[session.agentId]
      ? orchestrator(config)
      : config.agent[session.agentId]
  const controller = new AbortController()
  controllers.set(session.id, controller)

  // The transcript keeps what the user typed; the model gets the skills it named.
  const expanded = expandSkills(input.userText)
  store.addMessage({
    sessionId: session.id,
    role: 'user',
    parts: [{ type: 'text', text: input.userText }]
  })
  if (session.title === 'New session') {
    store.updateSession(session.id, {
      title: input.userText.replace(/\s+/g, ' ').slice(0, 70) || 'New session'
    })
  }
  store.setSessionStatus(session.id, 'running')

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

    const messages: ModelMessage[] = [
      ...history.getHistory(session.id),
      { role: 'user', content: expanded.prompt }
    ]
    history.appendHistory(session.id, [{ role: 'user', content: expanded.prompt }])

    const result = streamText({
      model: resolved.model,
      system: systemPrompt(agent, {
        cwd: session.cwd,
        environmentLabel: runtime.label,
        environmentKind: runtime.kind,
        platform,
        date: new Date().toISOString().slice(0, 10)
      }),
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
    history.trimHistory(session.id)

    const usage = await result.totalUsage
    const inputTokens = usage.inputTokens ?? 0
    const outputTokens = usage.outputTokens ?? 0
    store.updateMessage(session.id, assistant.id, {
      completedAt: Date.now(),
      usage: { input: inputTokens, output: outputTokens }
    })
    store.updateSession(session.id, {
      status: 'idle',
      usage: {
        input: session.usage.input + inputTokens,
        output: session.usage.output + outputTokens,
        cost: session.usage.cost
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
