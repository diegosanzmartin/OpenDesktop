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
import { savingsOf, type Savings } from '@shared/savings'
import { allowanceFor, allowanceUsed, pickModel } from '@shared/routing'
import { mentionToken, mentionedAgents } from '@shared/mentions'
import { costOf, formatCost } from '@shared/cost'
import { isAbort } from '@shared/errors'
import { budgetFor } from '@shared/context'
import { effectivePermissions, resolvedConfig } from '../config'
import { bus } from '../bus'
import { cancelSessionApprovals, withoutPrompts } from '../approvals'
import { resolveModel } from '../providers'
import { getRuntime, type Runtime } from '../runtime'
import { rtkStatus } from '../rtk'
import { workerIsTheSameModel } from '../shunt'
import { record as meterRecord, spentLookup } from '../meter'
import { logError, logLine } from '../log'
import * as store from '../store'
import * as history from '../history'
import { MUTATING_TOOLS, createTools, type ToolContext } from './tools'
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
Start by sizing the request, knowing what delegating costs. A subagent cannot see
this conversation, so it re-reads and re-derives everything from its brief:
measured on this app, three one-file fixes split across three subagents cost
about 2.4x the tokens and 2.5x the time of the same three fixes done here. Split
for breadth you cannot cover in one thread of work — not to parallelise a
handful of edits.

- Do it yourself when the request is one thread of work: a few files you can hold
  at once, anything that needs what was said here, and anything where writing the
  brief would take longer than making the change. Several small fixes in one
  repository are one thread of work, even when they are in different files.
- Split when a piece is a body of work in its own right — somewhere you have not
  read yet and would have to survey, a different part of the system, a different
  skill, or a change that needs its own reading before anything can be written.
  The test is whether the piece needs understanding of its own, not whether it
  touches a different file. Say in one short line how you are splitting it and
  why, then call \`task\` once per piece **in the same step** so they run in
  parallel.
- Work that must happen in order: run the first stage, read what came back, then
  start the next. Do not launch a task that depends on another task's output.

Pick the agent whose description actually matches the piece. A subagent starts
with no memory of this conversation, so its prompt must stand alone: say what to
do, where, and what to report back. Hand over what you already know with
\`context_paths\` and \`context_notes\` — the files you have read that it will need,
and what you worked out that is not in them. Rediscovering the repository is
most of what delegating costs, and this is how you stop paying for it twice.

When the subagents return, you own the result. Read their reports, reconcile
anything that conflicts, verify what matters, and give the user one answer —
not a list of what each agent said.

Answer in the language the user wrote in.`
  }
}

/**
 * What this agent has had taken away, in its own words.
 *
 * A read-only agent is given no `write` and no `edit`, and nothing used to tell
 * it so — it inferred the absence, which it did well, and then wrote the change
 * out in prose and finished. The card said Done with half the instruction not
 * carried out. Naming the gap and pointing at `need_human` is what turns that
 * into a task handed back.
 */
function restrictions(available: string[]): string {
  const missing = MUTATING_TOOLS.filter((name) => !available.includes(name))
  if (missing.length === 0) return ''

  const cannot: string[] = []
  if (!available.includes('write') || !available.includes('edit')) cannot.push('change files')
  if (!available.includes('bash')) cannot.push('run commands')

  return `

# What you cannot do in this session
You have no ${missing.join(' and no ')} tool here, so you cannot ${cannot.join(' or ')}.
That is this agent's configuration, not an obstacle to get around. If the work
you were asked for needs one of them, do the part you can and then hand the rest
back with \`need_human\`, saying exactly what has to be done. Do not write the
change out and finish as though you had made it.`
}

function systemPrompt(agent: AgentConfig, input: {
  cwd: string
  environmentLabel: string
  environmentKind: string
  platform: string
  date: string
  tools: string[]
}): string {
  const base =
    agent.prompt ??
    'You are a capable software engineering agent. Answer in the language the user wrote in.'
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
- One purpose per bash call — and a purpose is often two or three commands, so
  chain those together rather than spending a step on each. A step resends the
  whole conversation, which is what it costs; what must not be chained is
  unrelated work, since the interface renders each call as its own block.
- When you are done, summarize what changed in a few lines. Do not pad the answer.
- When a check disagrees with the code, the code is what was asked about: fix it, or
  say why the check itself was wrong. Never edit an expectation to make a run pass.
- Write to the user in the language they wrote to you in, and keep to it.${restrictions(
    input.tools
  )}`
}

/**
 * What the agent needs to know about the switches it is running under.
 *
 * Only what is actually in force. An agent told that its output is being
 * filtered when it is not will second-guess perfectly complete output — and
 * the first thing it does about it is run the command again with more flags,
 * which costs exactly what these exist to save. They compose: with both on it
 * gets both notes, because both are true.
 */
function savingsGuidance(savings: Savings, planner: string | null): string {
  let text = ''

  if (savings.rtk) {
    text += `

# Filtered command output (rtk)
Shell commands on this target run through rtk, which filters their output
before you read it: a tree with counts instead of one line per file, failing
tests instead of a whole run, \`ok abc1234\` instead of git's progress report.
Directory listings and searches are filtered the same way.

What comes back is meant to be enough to act on. Do not re-run a command with
more flags to see "the real output", and do not conclude a command printed
nothing because it printed little. A file's contents are never filtered: when
you need exact text — before an edit, always — use \`read\`.`
  }

  if (savings.shunt) {
    text += `

# Delegated reading (shunt)
Reading a file into this conversation costs its whole length now and again on
every turn afterwards, so in this session that is not how files get read.

- \`bulk_read\` takes a question and some paths. The files go to another model,
  which answers and is then forgotten; only its answer comes back here. Use it
  for anything you are reading to *understand*. Files over the line limit are
  refused by \`read\` and by \`cat\`/\`head\`/\`tail\`, so this is the way in.
- Each call stands alone. Asking again with the same paths costs you nothing, so
  ask one thing at a time rather than one question about everything.
- What comes back is second-hand. Before you edit or quote a line, read that
  part with \`read\` and an offset — a targeted read is always allowed, and it is
  the only thing you should trust for exact text.
- \`code_write\` generates a file from a spec and a reference file without the
  result passing through here. For work that is mostly predictable from
  something that already exists. Anything needing judgement you do yourself.`

    if (planner) {
      text += `
- \`plan\` asks ${planner}, which is more capable than you, how to do something
  hard — before you start it, not after it has gone wrong. Use it when the work
  has several moving parts or when a wrong approach would be expensive to undo.
  The plan comes from the stronger model; the work is still yours.`
    }
  }

  return text
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
 * The files and notes a lead hands to a subagent, as the model sees them.
 *
 * A subagent starts with no memory of the conversation, so it re-reads and
 * re-derives whatever the lead already had: measured here, three one-file fixes
 * split three ways cost 2.4x the tokens of doing them in one session, and most
 * of that was rediscovery. Handing the files over costs their length once,
 * against reading them again plus the round trips to find them.
 *
 * Capped, because a lead that names a directory's worth of files would
 * otherwise fill the child's window before its brief arrives. Anything dropped
 * is said, so the subagent knows to read the rest itself.
 */
const HANDOVER_CHARS = 80_000

async function handover(
  runtime: Runtime,
  cwd: string,
  paths: string[] | undefined,
  notes: string | undefined
): Promise<string | undefined> {
  if ((!paths || paths.length === 0) && !notes) return undefined

  const parts: string[] = []
  let budget = HANDOVER_CHARS
  const skipped: string[] = []

  for (const path of paths ?? []) {
    const resolved = runtime.resolve(cwd, path)
    if (budget <= 0) {
      skipped.push(path)
      continue
    }
    try {
      const text = await runtime.readFile(resolved)
      if (text.length > budget) {
        skipped.push(path)
        continue
      }
      budget -= text.length
      parts.push(`<file name="${path}">\n${text}\n</file>`)
    } catch {
      // A path the lead got wrong is not worth failing the delegation over:
      // the subagent can read it itself, and now it knows to.
      skipped.push(path)
    }
  }

  if (parts.length === 0 && !notes) return undefined

  return (
    `<handover from="the lead agent">\n` +
    `These were read for you and are current as of now; you do not need to read them again.\n` +
    (notes ? `\n<notes>\n${notes}\n</notes>\n` : '') +
    (parts.length > 0 ? `\n${parts.join('\n\n')}\n` : '') +
    (skipped.length > 0
      ? `\nNot included (read them yourself if you need them): ${skipped.join(', ')}\n`
      : '') +
    `</handover>\n\n`
  )
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
): Promise<{ prefix: 'kept' | 'dehydrated' | 'compacted' }> {
  /*
   * Leaving the transcript alone is usually the cheaper move.
   *
   * Dropping old tool output costs nothing in tokens, so it used to happen at
   * the end of every turn. But the provider caches by prefix, and a rewritten
   * transcript is a different prefix: from the third turn of a session onwards,
   * every step of every turn was paying full price for the whole conversation
   * because the app had just changed the part that would otherwise have been
   * served from the cache. Measured on this app, two thirds of a turn's input
   * can come back as a cache read — that is what is being thrown away.
   *
   * So it waits now. Under the threshold the transcript is byte-for-byte what
   * it was and the cache does the saving; over it, the transcript really is the
   * bigger cost and dropping the old bodies is worth the cold prefix it buys.
   *
   * Measured on helmcode, on a 34k-token transcript: a turn whose prefix had
   * been sent before came back 99% served from cache, against 0% on the turn
   * after a rewrite. Dropping the old bodies saved 10% of the same transcript.
   * The turn's `first=` figure in the log is that measurement — it is what to
   * check if a provider ever stops rewarding this.
   */
  const budget = budgetFor(config, modelRef)
  const share = budget > 0 ? measuredTokens / budget : 0
  const worthIt = share >= (config.dehydrateAtFraction ?? 0.5)
  const freed = worthIt
    ? history.dehydrateHistory(sessionId, {
        afterTurns: config.dehydrateAfterTurns,
        overChars: config.dehydrateOverChars
      })
    : { dropped: 0, freedTokens: 0 }
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

  return { prefix: compacted ? 'compacted' : freed.dropped > 0 ? 'dehydrated' : 'kept' }
}

async function compactIfNeeded(
  config: AppConfig,
  sessionId: string,
  modelRef: string,
  measuredTokens: number,
  force = false
): Promise<boolean> {
  // A summary is not the work, so it does not go to the model doing the work.
  // Whatever was named for it, or whatever the router says is cheapest and
  // still capable enough to be trusted with it.
  const ref =
    config.smallModel ??
    pickModel(config, 'delegate', { spent: spentLookup(config) })?.ref ??
    modelRef

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
      // Summarising was free in the accounting until now, which it never was
      // in fact. Charged to the session, priced as whichever model did it.
      const used = {
        input: answer.usage.inputTokens ?? 0,
        output: answer.usage.outputTokens ?? 0
      }
      store.creditUsage(sessionId, { ...used, cost: costOf(config, ref, used) ?? 0 })
      meterRecord(ref, { ...used, cost: costOf(config, ref, used) ?? 0 })
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

/**
 * Says so when a paid key is running out of the budget it was given.
 *
 * Nothing on the other side reports a balance, so this is what this app has
 * spent, counted locally and labelled that way. Said at nine tenths and again
 * when it is gone, once each per period per key — a warning repeated every turn
 * is one nobody reads, and this one costs real money to ignore.
 */
const allowanceSaid = new Set<string>()

function warnOnAllowance(config: AppConfig, ref: string): void {
  const slash = ref.indexOf('/')
  if (slash === -1) return
  const providerId = ref.slice(0, slash)
  const model = config.provider?.[providerId]?.models[ref.slice(slash + 1)]
  if (!model || (model.billing ?? 'pay-as-you-go') !== 'allowance') return

  const allowance = allowanceFor(config, providerId, model)
  const spent = spentLookup(config)(ref)
  const used = allowanceUsed(allowance, spent)
  if (used === null) return

  const stage = used >= 1 ? 'spent' : used > 0.9 ? 'nearly spent' : null
  if (stage === null) return
  const key = `${providerId}|${allowance?.period ?? 'month'}|${stage}`
  if (allowanceSaid.has(key)) return
  allowanceSaid.add(key)

  const of = allowance?.usd
    ? `${formatCost(spent?.cost ?? 0)} of ${formatCost(allowance.usd)}`
    : `${(spent?.tokens ?? 0).toLocaleString('en-US')} of ${(allowance?.tokens ?? 0).toLocaleString('en-US')} tokens`
  const period = allowance?.period === 'day' ? 'today' : 'this month'
  const message =
    stage === 'spent'
      ? `${providerId}'s included allowance is spent ${period} — ${of} by this app's own count. Anything more is charged at the model's price.`
      : `${providerId} has used ${Math.round(used * 100)}% of its allowance ${period} — ${of}, counted here.`

  logLine('warn', `allowance ${providerId}: ${stage} (${of}, ${period})`)
  bus.emit({ type: 'toast', level: 'warn', message })
}

/**
 * Sessions already told that a switch cannot do what it says, so the
 * transcript says it once instead of at every turn.
 */
const modeWarned = new Set<string>()

function sayOnce(sessionId: string, key: string, text: string): void {
  if (modeWarned.has(key)) return
  modeWarned.add(key)
  store.addMessage({ sessionId, role: 'system', parts: [{ type: 'text', text }] })
}

/**
 * Says so in the chat when a switch is on but cannot do what it claims.
 *
 * The alternative is a session that quietly behaves as if the switch were off
 * while the composer says it is on — the user would be reading the token
 * counts of one setting and the label of another.
 *
 * Returns the switches that are actually in force, which is what the agent is
 * told about: a note describing filtered output to an agent whose output is
 * not filtered is worse than no note at all.
 */
async function announceSavingsProblems(input: {
  config: AppConfig
  sessionId: string
  environmentId: string
  cwd: string
  modelRef: string
  savings: Savings
}): Promise<Savings> {
  const inForce: Savings = { ...input.savings }

  if (input.savings.rtk) {
    const runtime = getRuntime(input.environmentId)
    const status = await rtkStatus(input.environmentId, runtime, input.cwd)
    if (status.state !== 'ready') {
      inForce.rtk = false
      sayOnce(
        input.sessionId,
        `${input.sessionId}:${input.environmentId}:${status.state}`,
        // The point first: a notice is a divider in the chat, and only its
        // first line is read at a glance.
        `rtk is not available on ${runtime.label} — commands are running unfiltered.\n\n` +
          `${status.message ?? 'It could not be used on this execution target.'}\n\n` +
          `rtk has to be on the machine whose commands it filters, because it is what runs ` +
          `them — but it does not have to be installed by hand. Open the savings menu beside ` +
          `the composer and choose "Install rtk on ${runtime.id}": it fetches the release for ` +
          `this host into ~/.opendesktop/bin, checks its checksum, and touches nothing else. ` +
          `Or turn the switch off there if you would rather not be reminded.`
      )
    }
  }

  if (input.savings.shunt && workerIsTheSameModel(input.config, input.modelRef)) {
    // Not a failure: the corpus still stays out of the conversation, which is
    // most of the point. But it is not the saving the setting advertises, and
    // a user watching the cost should know which of the two they are getting.
    sayOnce(
      input.sessionId,
      `${input.sessionId}:shunt:same-model`,
      `Delegated reading is going to ${input.modelRef}, this session's own model.\n\n` +
        `No cheaper one is declared, so large files still stay out of the conversation — ` +
        `which is where most of the saving is — but the reading is charged at full price.\n\n` +
        `Give another model a lower cost under Settings → Models → Cost, or name one ` +
        `directly under Savings.`
    )
  }

  return inForce
}

interface TurnInput {
  sessionId: string
  userText: string
  /**
   * What the lead already knew, handed to a subagent with its brief: the files
   * it would otherwise have opened, and what the lead learned that is not in
   * them. Put in front of the model, kept out of the visible message — the
   * transcript should read as the brief that was given, not as a paste of the
   * repository.
   */
  handover?: string
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
  const asked = store.addMessage({
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
  /*
   * Outside the try, because a turn that fails has still spent everything it
   * spent up to the point it failed. Two agents died mid-turn having used
   * 180,000 input tokens between them, and the session recorded zero.
   */
  let usedInput = 0
  let usedOutput = 0
  /** Set when the provider failed mid-stream, which is not the same as a throw. */
  let streamFailure: string | null = null

  /**
   * Armed when the request goes out, cleared by the first thing that comes
   * back.
   *
   * A turn that never produced a token used to be indistinguishable from a turn
   * thinking hard: the card said running, the transcript stayed empty, nothing
   * reached the log, and the only way out was to notice. This does not cancel
   * anything — a slow provider is not a broken one — it says so, once, where
   * both the user and whoever reads the log afterwards can see it.
   */
  let silence: NodeJS.Timeout | null = null

  /**
   * The two ceilings on one turn, and what to say when one of them is hit.
   *
   * A turn stopped for spending too much is not a turn the user stopped and not
   * a turn that failed, so it needs its own answer: the reason goes in the
   * transcript, the card goes to Blocked, and replying carries the work on from
   * where it stopped. The wall-clock one exists because tokens are not the only
   * way a turn runs away — a shell command that never returns spends nothing.
   */
  let budgetStop: string | null = null
  let clock: NodeJS.Timeout | null = null
  let budgetWarned = false
  let budgetSaid = false
  const startedAt = Date.now()
  let steps = 0

  const sayBudgetStop = (): void => {
    if (!budgetStop || budgetSaid) return
    budgetSaid = true
    store.pushPart(session.id, assistant.id, { type: 'error', text: budgetStop })
    store.updateSession(session.id, { status: 'blocked', blockedReason: budgetStop })
    bus.emit({ type: 'toast', level: 'warn', message: budgetStop })
  }

  /*
   * What this turn has already added to the session's running totals.
   *
   * They used to be written once, when the turn ended, so a card that had been
   * working for ten minutes showed a session that had spent nothing — which is
   * exactly the ten minutes somebody is watching to see what it costs. Credited
   * per step now, as the difference from what was credited last time, so the
   * arithmetic stays right however the steps arrive and whatever else spends
   * against this session mid-turn.
   */
  let creditedInput = 0
  let creditedOutput = 0
  let creditedCost = 0

  /*
   * What the provider says it charged for and what it served from a cache.
   *
   * Every step of a turn resends the whole prefix — the system prompt, the tool
   * schemas, the transcript — so whether those tokens are cache reads or full
   * price is most of what a turn costs. The SDK reports the split; without it
   * in the log there is no way to tell a cache that is working from one that
   * silently is not, and the difference is an order of magnitude on the bill.
   */
  let cacheRead = 0
  let cacheWrite = 0
  /** The first step's numbers, which say whether the prefix carried over. */
  let firstStepInput = 0
  let firstStepCacheRead = 0

  const creditSession = (input: number, output: number, cost: number | null): void => {
    const deltaInput = Math.max(0, input - creditedInput)
    const deltaOutput = Math.max(0, output - creditedOutput)
    const deltaCost = Math.max(0, (cost ?? 0) - creditedCost)
    if (deltaInput === 0 && deltaOutput === 0 && deltaCost === 0) return
    creditedInput += deltaInput
    creditedOutput += deltaOutput
    creditedCost += deltaCost
    store.creditUsage(session.id, { input: deltaInput, output: deltaOutput, cost: deltaCost })
  }

  try {
    const runtime = getRuntime(session.environmentId)
    await runtime.connect()
    const { platform } = await describeTarget(session.environmentId)
    const resolved = await resolveModel(config, agent.model ?? session.model)

    const modelRef = agent.model ?? session.model
    const autoApprove = session.autoApprove ?? config.autoApprove ?? false
    const savings = await announceSavingsProblems({
      config,
      sessionId: session.id,
      environmentId: session.environmentId,
      cwd: session.cwd,
      modelRef,
      savings: savingsOf(config, session)
    })
    const planner = savings.shunt
      ? (config.plannerModel ??
        pickModel(config, 'plan', { spent: spentLookup(config) })?.ref ??
        null)
      : null

    /*
     * One line when a turn starts and one when it ends.
     *
     * The log was only ever written when something went wrong, so an ordinary
     * turn left no trace — and the one time it mattered, a turn that hung for
     * thirteen minutes could not be told from a turn that never started. Two
     * lines per turn is a file you can read a day's work out of.
     */
    logLine(
      'info',
      `turn ${session.id} start agent=${agent.id} model=${modelRef} env=${session.environmentId}` +
        `${input.depth ? ` depth=${input.depth}` : ''} cwd=${session.cwd}`
    )

    const ctx: ToolContext = {
      config,
      agent,
      /*
       * The session's own permissions. Auto-approve is read from the session,
       * falling back to the app's default, and it only ever removes the
       * prompt: `deny` stays denied and the denylist is checked before any of
       * this is consulted.
       */
      permissions: autoApprove
        ? withoutPrompts(effectivePermissions(config, agent.id))
        : effectivePermissions(config, agent.id),
      sessionId: session.id,
      environmentId: session.environmentId,
      cwd: session.cwd,
      runtime,
      signal: controller.signal,
      savings,
      modelRef,
      currentMessageId: () => assistant.id,
      depth: input.depth ?? 0,
      parentBlockId: input.parentBlockId,
      spawnSubagent: async ({
        agentId,
        prompt,
        description,
        parentBlockId,
        contextPaths,
        contextNotes
      }) => {
        const child = store.createSession({
          title: description,
          cwd: session.cwd,
          environmentId: session.environmentId,
          agentId,
          model: config.agent[agentId]?.model ?? session.model,
          savings,
          autoApprove,
          parentSessionId: session.id
        })
        store.updateSession(child.id, { taskLabel: description })
        const report = await runTurn({
          sessionId: child.id,
          userText: prompt,
          handover: await handover(runtime, session.cwd, contextPaths, contextNotes),
          collectFinalText: true,
          depth: (input.depth ?? 0) + 1,
          parentBlockId
        })
        /*
         * What the subagent spent is what this task cost, so it is credited
         * here as well as kept on the subchat. A card that delegated three
         * pieces of work used to report only the manager's own tokens — a
         * fifth of the real figure, and wrong in the direction that makes
         * delegating look free.
         */
        const spent = store.getSession(child.id)?.usage
        if (spent && (spent.input > 0 || spent.output > 0)) {
          store.creditUsage(session.id, {
            input: spent.input,
            output: spent.output,
            cost: spent.cost
          })
        }
        return { sessionId: child.id, report: report || '(the subagent returned no text)' }
      }
    }

    const tools = createTools(ctx)

    const userMessage = buildUserMessage(
      config,
      session.model,
      (input.handover ?? '') + expanded.prompt + mentionDirective(config, input.userText),
      input.attachments
    )
    const messages: ModelMessage[] = [...history.getHistory(session.id), userMessage]
    // Where this turn begins, recorded before it is appended: rewinding to this
    // message later cuts the model transcript back to exactly here.
    history.markTurn(session.id, asked.id)
    history.appendHistory(session.id, [userMessage])

    const result = streamText({
      model: resolved.model,
      system:
        systemPrompt(agent, {
          cwd: session.cwd,
          environmentLabel: runtime.label,
          environmentKind: runtime.kind,
          platform,
          date: new Date().toISOString().slice(0, 10),
          tools: Object.keys(tools)
        }) +
        savingsGuidance(savings, planner === modelRef ? null : planner) +
        (input.coordinationNote ?? ''),
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
        // streamText does not reject for a provider failure mid-stream: it
        // reports it here and ends the stream. Without remembering it, the
        // turn looked successful — an idle session, a red line in the
        // transcript nobody was told about, and no toast.
        streamFailure = logError(`stream ${session.id}`, error)
        store.pushPart(session.id, assistant.id, { type: 'error', text: streamFailure })
      }
    })

    const wallCeiling = config.maxTurnMs ?? 0
    if (wallCeiling > 0) {
      clock = setTimeout(() => {
        if (budgetStop) return
        budgetStop =
          `This turn stopped at its time limit: ${Math.round(wallCeiling / 60_000)} minutes ` +
          `(maxTurnMs). Whatever it had already done stands — reply to carry on.`
        logLine('warn', `turn ${session.id} hit maxTurnMs after ${Date.now() - startedAt}ms`)
        controller.abort()
      }, wallCeiling)
    }

    const QUIET_MS = 90_000
    silence = setTimeout(() => {
      logLine(
        'warn',
        `turn ${session.id} has had nothing from ${modelRef} in ${QUIET_MS / 1000}s; still waiting`
      )
      bus.emit({
        type: 'toast',
        level: 'warn',
        message:
          `${modelRef} has sent nothing for ${QUIET_MS / 1000} seconds. The turn is still open — ` +
          `stop it if you would rather not wait.`
      })
    }, QUIET_MS)

    let textPartIndex = -1
    let reasoningPartIndex = -1
    // Accumulated as each step reports it, so the transcript can show a real
    // count while the turn is still going rather than an estimate from
    // characters. Input is summed across steps because every step resends the
    // conversation, which is what the turn actually costs.
    // The last step's input is the size of the assembled prefix. The sum across
    // steps is what the turn cost; it is not how full the window is.
    let lastStepInput = 0
    /*
     * Where a long turn's tokens actually go.
     *
     * Every step resends the conversation, so a turn's bill is roughly the
     * prefix times the number of steps — but which of the two is to blame is
     * not guessable from the total. A turn that opened at 34k and closed at
     * 109k spent most of it carrying tool output it had already read; one that
     * opened and closed at 34k spent it on steps. Both are fixable, and by
     * different means, so the log says which.
     */
    let firstStepTotal = 0

    for await (const part of result.fullStream) {
      if (silence) {
        clearTimeout(silence)
        silence = null
      }
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
          steps++
          cacheRead += part.usage.inputTokenDetails?.cacheReadTokens ?? 0
          cacheWrite += part.usage.inputTokenDetails?.cacheWriteTokens ?? 0
          if (steps === 1) {
            firstStepInput = part.usage.inputTokens ?? 0
            firstStepCacheRead = part.usage.inputTokenDetails?.cacheReadTokens ?? 0
            firstStepTotal = firstStepInput
          }
          lastStepInput = part.usage.inputTokens ?? lastStepInput
          usedInput += part.usage.inputTokens ?? 0
          usedOutput += part.usage.outputTokens ?? 0
          const so_far = costOf(config, agent.model ?? session.model, {
            input: usedInput,
            output: usedOutput,
            cacheRead,
            cacheWrite
          })
          store.updateMessage(session.id, assistant.id, {
            usage: {
              input: usedInput,
              output: usedOutput,
              ...(so_far === null ? {} : { cost: so_far })
            }
          })
          creditSession(usedInput, usedOutput, so_far)

          const ceiling = config.maxTurnTokens ?? 0
          const spentSoFar = usedInput + usedOutput
          if (ceiling > 0 && !budgetStop) {
            if (spentSoFar >= ceiling) {
              budgetStop =
                `This turn stopped at its ceiling: ${spentSoFar.toLocaleString('en-US')} tokens ` +
                `across ${steps} steps, against a limit of ${ceiling.toLocaleString('en-US')} ` +
                `(maxTurnTokens). Nothing is lost — reply to carry on, or raise the limit in ` +
                `Settings if this is ordinary work for this project.`
              logLine('warn', `turn ${session.id} hit maxTurnTokens (${spentSoFar} >= ${ceiling})`)
              controller.abort()
            } else if (!budgetWarned && spentSoFar > ceiling * 0.6) {
              budgetWarned = true
              logLine('info', `turn ${session.id} past 60% of maxTurnTokens (${spentSoFar}/${ceiling})`)
              bus.emit({
                type: 'toast',
                level: 'warn',
                message:
                  `This turn has spent ${spentSoFar.toLocaleString('en-US')} tokens of its ` +
                  `${ceiling.toLocaleString('en-US')} ceiling.`
              })
            }
          }
          break
        }
        case 'tool-call':
          // The block is created by the tool itself, which knows its own shape.
          // Resetting the text cursor keeps prose after a tool call in its own bubble.
          textPartIndex = -1
          reasoningPartIndex = -1
          break
        case 'error': {
          streamFailure = logError(`stream ${session.id}`, part.error)
          store.pushPart(session.id, assistant.id, { type: 'error', text: streamFailure })
          break
        }
        default:
          break
      }
    }

    /*
     * A ceiling reached is the end of this turn, not a failure of it.
     *
     * Aborting the stream only breaks the loop above — the rest of the turn
     * still runs, records what was spent and keeps what was produced, which is
     * what makes "reply to carry on" mean anything. Said here rather than in
     * the catch because this is the path an abort actually takes.
     */
    if (budgetStop) sayBudgetStop()

    const responseMessages = await result.responseMessages
    history.appendHistory(session.id, responseMessages as ModelMessage[])
    const tightened = await tighten(config, session.id, agent.model ?? session.model, lastStepInput)
    // What the next turn's decision reads: did this conversation's prefix
    // survive between turns, or did it arrive as new tokens?
    store.updateSession(session.id, {
      cacheShare: firstStepInput > 0 ? firstStepCacheRead / firstStepInput : 0
    })

    const usage = await result.totalUsage
    /*
     * The per-step counts win when they are larger. A turn that broke halfway
     * reports a total of zero even though ten thousand tokens went out the
     * door, and a turn that is recorded as free is the one somebody is trying
     * to account for.
     */
    const inputTokens = Math.max(usage.inputTokens ?? 0, usedInput)
    const outputTokens = Math.max(usage.outputTokens ?? 0, usedOutput)
    // Worked out now and kept on the message: a price edited next week must not
    // change what this turn is recorded as having cost.
    const turnCost = costOf(config, modelRef, {
      input: inputTokens,
      output: outputTokens,
      cacheRead,
      cacheWrite
    })
    meterRecord(modelRef, { input: inputTokens, output: outputTokens, cost: turnCost ?? 0 })
    warnOnAllowance(config, modelRef)
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
    // Only the difference. The steps have already been credited, and anything
    // else that spent against this session mid-turn — a delegated read, a
    // subagent's report — is in those totals too and must not be overwritten.
    creditSession(inputTokens, outputTokens, turnCost)
    store.updateSession(session.id, {
      status: ended?.status === 'blocked' ? 'blocked' : streamFailure !== null ? 'error' : 'idle'
    })
    logLine(
      'info',
      `turn ${session.id} done model=${modelRef} steps=${steps} ` +
        `tokens=${inputTokens}/${outputTokens} ` +
        `cache=${cacheRead}r/${cacheWrite}w` +
        `${inputTokens > 0 ? `(${Math.round((cacheRead / inputTokens) * 100)}%)` : ''} ` +
        `first=${firstStepInput > 0 ? Math.round((firstStepCacheRead / firstStepInput) * 100) : 0}% ` +
        `prefix=${Math.round(firstStepTotal / 1000)}k→${Math.round(lastStepInput / 1000)}k ` +
        `after=${tightened.prefix}` +
        `${turnCost === null ? '' : ` cost=${turnCost.toFixed(4)}`} ` +
        `calls=${store.listBlocks(session.id).filter((block) => block.messageId === assistant.id).length} ` +
        `${Date.now() - startedAt}ms${streamFailure === null ? '' : ' (stream failed)'}`
    )

    /*
     * Told, not left to be noticed. A provider that fails mid-stream used to
     * end the turn quietly: the session went idle, the answer simply stopped,
     * and the only trace was a line in the transcript that scrolls away.
     */
    if (streamFailure !== null) {
      logLine('warn', `turn ${session.id} ended on a stream failure after ${inputTokens} in / ${outputTokens} out`)
      bus.emit({ type: 'toast', level: 'error', message: streamFailure })
    }
  } catch (err) {
    const aborted = isAbort(err, controller.signal.aborted)
    // The whole chain, not the outermost wrapper: "Failed to process
    // successful response" is a sentence about nothing on its own.
    const message = budgetStop ?? (aborted ? 'Stopped by the user.' : logError(`turn ${session.id}`, err))
    if (budgetStop) {
      // Handed back, not failed: the work is fine, there is just more of it
      // than one turn was allowed to spend.
      sayBudgetStop()
    } else {
      store.pushPart(session.id, assistant.id, { type: 'error', text: message })
      store.setSessionStatus(session.id, aborted ? 'idle' : 'error')
    }
    store.updateMessage(session.id, assistant.id, { completedAt: Date.now() })

    // Charged for what it used before it broke. The tokens were spent whether
    // or not an answer came back, and a turn that fails is exactly when
    // somebody is trying to work out what it cost.
    if (usedInput > 0 || usedOutput > 0) {
      const spentCost = costOf(config, agent.model ?? session.model, {
        input: usedInput,
        output: usedOutput,
        cacheRead,
        cacheWrite
      })
      creditSession(usedInput, usedOutput, spentCost)
      meterRecord(agent.model ?? session.model, {
        input: usedInput,
        output: usedOutput,
        cost: spentCost ?? 0
      })
      logLine(
        'warn',
        `turn ${session.id} ${budgetStop ? 'stopped at its ceiling' : 'failed'} after ` +
          `${steps} steps, ${usedInput} in / ${usedOutput} out on ${agent.model ?? session.model}, ` +
          `${Date.now() - startedAt}ms`
      )
    }
    // The ceiling has already said its piece, through sayBudgetStop.
    if (!budgetStop && !aborted) bus.emit({ type: 'toast', level: 'error', message })
  } finally {
    if (silence) clearTimeout(silence)
    if (clock) clearTimeout(clock)
    controllers.delete(session.id)
    if (store.getSession(session.id)?.status === 'running') store.setSessionStatus(session.id, 'idle')
    store.flush()
  }

  return input.collectFinalText ? finalText : ''
}

export function stopAll(): void {
  for (const id of [...controllers.keys()]) stop(id)
}
