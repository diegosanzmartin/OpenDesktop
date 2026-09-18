/** Shared types between the main process, the preload bridge and the renderer. */

import type { LegacyMode, Savings } from './savings'
import type { Billing } from './routing'
import type { LocalModelStatus } from './local-model'

export type BlockStatus = 'pending' | 'awaiting-approval' | 'running' | 'success' | 'error' | 'canceled'

/**
 * `queued` waits for the scheduler to free a slot; `blocked` waits for a human;
 * `done` is a board task whose work finished. A plain chat only ever sees
 * idle/running/awaiting-approval/error, exactly as before.
 */
export type SessionStatus =
  | 'idle'
  | 'queued'
  | 'running'
  | 'awaiting-approval'
  | 'blocked'
  | 'error'
  | 'done'

export type EnvironmentKind = 'local' | 'ssh' | 'gcp-workstation'

export interface EnvironmentConfig {
  id: string
  name: string
  kind: EnvironmentKind
  /** Default working directory for new sessions on this environment. */
  cwd?: string
  /** Reached through `gcloud workstations start-tcp-tunnel`, then plain SSH. */
  workstation?: {
    project: string
    region: string
    cluster: string
    config: string
    workstation: string
    /** The login on the workstation; gcloud defaults this to "user". */
    user?: string
    /** Pass --start-workstation, which boots a stopped workstation. */
    startWorkstation?: boolean
    /** Key gcloud provisions for workstation access. */
    privateKey?: string
  }
  ssh?: {
    host: string
    port?: number
    username?: string
    /** Path to a private key file. Supports {env:VAR} expansion. */
    privateKey?: string
    passphrase?: string
    password?: string
    /** Read host/user/key from ~/.ssh/config for this alias instead. */
    alias?: string
    keepaliveInterval?: number
  }
}

export interface Attachment {
  id: string
  name: string
  mediaType: string
  size: number
  /** Images need a model that can read them; text is inlined and always works. */
  kind: 'image' | 'text' | 'binary'
  /** A copy kept beside the session, so the transcript survives the original moving. */
  path: string
  /** Present for text: the contents, inlined into the prompt. */
  text?: string
}

export interface ProviderModelConfig {
  id: string
  name: string
  /** Advertised context window, used for the token meter. */
  contextWindow?: number
  maxOutputTokens?: number
  reasoning?: boolean
  toolCall?: boolean
  /** Declared, not detected: an OpenAI-compatible endpoint cannot be asked. */
  vision?: boolean
  /**
   * What the model costs, in whole currency units per million tokens — the way
   * every provider publishes it, so it can be copied across without arithmetic.
   * Absent means unknown, and unknown is shown as nothing rather than as zero.
   */
  price?: {
    input?: number
    output?: number
    /**
     * What a cached input token costs, and what it costs to write one. Unset,
     * the usual convention is assumed — a tenth of the input price to read and
     * a quarter more than it to write — because a provider that caches and does
     * not say so is still charging that way, and counting a cache read at full
     * price overstates every figure this app shows.
     */
    cacheRead?: number
    cacheWrite?: number
  }
  /**
   * How this model is paid for. It changes what the next token costs, which is
   * what the router balances: a flat-rate model is paid for whether it is used
   * or not, so at the margin it is the cheapest thing there is.
   */
  billing?: Billing
  /** What the subscription costs, for `flat`. Informational; nothing divides by it. */
  monthlyCost?: number
  /**
   * The quota, for `allowance`, counted from what this app has spent.
   *
   * In tokens where the provider counts tokens, or in money where it counts
   * money — a $400-a-month key is a budget, not a token bucket, and rounding it
   * into tokens would need a price per model to be exactly right anyway. When
   * both are set, whichever runs out first ends the free part.
   */
  allowance?: { tokens?: number; usd?: number; period: 'day' | 'month' }
  /**
   * 1 (cheap) to 5 (expensive), relative to the other models declared here.
   * Absent is read off the price, so a config written before this existed
   * still routes sensibly.
   */
  cost?: number
  /** 1 (modest) to 5 (strong): what the router means by capable. */
  iq?: number
}

/** What the settings page reads for one model: tokens and money, by period. */
export interface MeterEntry {
  day: number
  month: number
  dayCost: number
  monthCost: number
}

export interface ProviderConfig {
  id: string
  /** The AI SDK package that backs this provider. */
  npm: string
  name: string
  /**
   * A cap on the whole key, shared by every model under it.
   *
   * A spend limit belongs to the credential, not to one model: $400 a month on
   * an Anthropic key is $400 across Opus, Sonnet and Haiku together. A model
   * with its own `allowance` uses that instead; everything else here counts
   * against this.
   */
  allowance?: { tokens?: number; usd?: number; period: 'day' | 'month' }
  options: {
    baseURL?: string
    apiKey?: string
    headers?: Record<string, string>
    [key: string]: unknown
  }
  models: Record<string, ProviderModelConfig>
}

/**
 * A tool server the app can talk to, declared once and switched on per session.
 *
 * Per session rather than globally because a tool is a schema in the prefix of
 * every step of every turn: a list of a hundred and thirty of them is fifty
 * thousand tokens resent all day, and a schema that changes throws away the
 * provider's cache of everything in front of it. So a server is a thing you
 * turn on for the conversation that needs it.
 */
export interface McpServerConfig {
  id: string
  name: string
  /** The command that speaks MCP on its stdin and stdout. */
  command: string
  args?: string[]
  /** Added to the environment the command gets, which never has this app's keys in it. */
  env?: Record<string, string>
  cwd?: string
}

/** What a declared server turned out to be, once somebody asked it. */
export interface McpStatus {
  id: string
  name: string
  state: 'idle' | 'starting' | 'ready' | 'failed'
  tools: { name: string; description: string }[]
  /**
   * What its schemas add to the prefix of every step of every turn. The number
   * that decides whether a server is worth switching on, which is why it is
   * measured rather than described.
   */
  tokens: number
  message?: string
}

/**
 * When a hook runs. Three moments, because a longer list is a longer thing to
 * learn and these are the ones with a use: stop something, react to it, or
 * tidy up after the whole turn.
 */
export type HookEvent = 'before' | 'after' | 'turn'

/**
 * A command this app runs when the agent does something.
 *
 * The cheapest lever in the app: it runs on the machine rather than in the
 * conversation, so it costs no tokens and the model spends no attention on it.
 * A `before` hook that exits non-zero refuses the call and what it printed
 * becomes the reason; everywhere else the output is kept for you and never
 * reaches the model.
 */
export interface HookConfig {
  id: string
  name?: string
  event: HookEvent
  /** A regular expression over the tool name. Absent means every tool. */
  matcher?: string
  /** Shell, run on the session's execution target in its working directory. */
  command: string
  timeoutMs?: number
  enabled?: boolean
}

export type PermissionMode = 'ask' | 'allow' | 'deny'

export interface Permissions {
  bash: PermissionMode
  edit: PermissionMode
  write: PermissionMode
  read: PermissionMode
  fetch: PermissionMode
  /**
   * Calling a tool that belongs to an MCP server, which is a program this app
   * did not write doing something it did not define. Asked by default, and
   * asked per tool rather than per server: "connect the ticket tracker" is not
   * the same decision as "close this ticket".
   */
  mcp: PermissionMode
  /** Commands matching these glob-ish patterns skip the bash prompt. */
  allowlist: string[]
  /** Commands matching these are always refused. */
  denylist: string[]
}

export type AgentMode = 'primary' | 'subagent' | 'all'

export interface AgentConfig {
  id: string
  name: string
  description: string
  mode: AgentMode
  /** `provider/model`. Falls back to the global model when omitted. */
  model?: string
  prompt?: string
  temperature?: number
  /** Tool name -> enabled. Unlisted tools default to enabled. */
  tools?: Record<string, boolean>
  permissions?: Partial<Permissions>
  color?: string
}

export interface Skill {
  id: string
  name: string
  description: string
  /** Directory on disk, so instructions can point the agent at its own files. */
  path: string
  files: string[]
  instructions: string
}

/**
 * Every session runs the manager. It does the ordinary work itself and splits
 * off the parts that are genuinely someone else's, so there is nothing to pick
 * before starting — naming an agent is something you do mid-sentence, with @.
 */
export const MANAGER_AGENT = 'manager'

/** What the manager used to be called. Sessions on disk still say this. */
export const AUTO_AGENT = 'auto'

/** Whether an id means "the manager", including the name it used to have. */
export function isManager(agentId: string | undefined): boolean {
  return agentId === MANAGER_AGENT || agentId === AUTO_AGENT || !agentId
}

export interface AppConfig {
  $schema?: string
  model: string
  smallModel?: string
  provider: Record<string, ProviderConfig>
  environment: Record<string, EnvironmentConfig>
  agent: Record<string, AgentConfig>
  /** Tool servers, declared here and enabled per session. */
  mcp?: Record<string, McpServerConfig>
  /** Commands the app runs around a tool call or a turn. Cost no tokens. */
  hooks?: HookConfig[]
  permissions: Permissions
  maxSteps: number
  /** What a session starts with, unless it says otherwise. */
  savings?: Partial<Savings>
  /** The single mode this used to be. Read for compatibility, never written. */
  mode?: LegacyMode
  /** Whether a new session starts without approval prompts. */
  autoApprove?: boolean
  /**
   * What shunt delegates reading to, as `provider/model`. Unset, the cheapest
   * model that clears the capability floor is chosen for each job.
   */
  shuntModel?: string
  /** Who is asked how to do something hard. Unset, the most capable declared. */
  plannerModel?: string
  /** Whole-file reads longer than this are refused while shunt is on. */
  shuntMinLines?: number
  /**
   * Share of the usable window at which old tool output stops being resent.
   *
   * Dropping it is free in tokens and used to happen on every turn — which
   * turned out to be the most expensive thing the app did. Rewriting the
   * transcript changes the prefix, and a changed prefix is one the provider
   * cannot serve from its cache, so every step of every later turn paid full
   * price for the whole conversation instead of a tenth. Below this share the
   * transcript is left byte-for-byte alone and the cache does the saving;
   * above it, resending really is the bigger cost.
   */
  dehydrateAtFraction?: number
  /** How many board tasks the scheduler will run at once. */
  maxConcurrentTasks?: number
  /**
   * What one turn may spend before it is stopped, in tokens across all its
   * steps, and in wall-clock milliseconds.
   *
   * `maxSteps` bounds how many times the model may act, which is not the same
   * as how much it may spend: a step that resends a 300k-token transcript costs
   * two hundred times one that resends 1.5k. Both ceilings are deliberately
   * generous — they exist to end a runaway, not to ration ordinary work — and a
   * turn that hits one is handed back rather than failed, so replying carries
   * it on.
   */
  maxTurnTokens?: number
  maxTurnMs?: number
  /**
   * How many subagents one agent may have working at the same time.
   *
   * The board limit does not cover these: a single manager that calls `task`
   * eight times in one step opens eight streams, and a provider with a
   * concurrency ceiling answers that by making all of them slow. Extra calls
   * wait for a slot and then run; nothing is dropped.
   */
  maxParallelSubagents?: number
  /** Share of a model's usable window at which the transcript is summarised. */
  compactAtFraction?: number
  /** How many messages stay verbatim after a summary. */
  keepRecentMessages?: number
  /**
   * Tool output older than this many turns stops being resent, replaced by a
   * note naming the call that produced it. Free, and usually a bigger saving
   * than summarising.
   */
  dehydrateAfterTurns?: number
  /** Outputs smaller than this are left alone; the saving would not pay. */
  dehydrateOverChars?: number
  /**
   * Milliseconds between words when re-chunking the model's text for display.
   * 0 disables the smoothing and shows provider chunks as they arrive.
   */
  smoothStreamMs: number
  theme: 'dark' | 'light' | 'system'
}

export interface Block {
  id: string
  sessionId: string
  messageId: string
  /** Tool name: bash, read, write, edit, grep, glob, list, fetch, task... */
  tool: string
  /** One-line summary shown collapsed, e.g. the command itself. */
  title: string
  /** Second line of context, e.g. relative path or host. */
  subtitle?: string
  status: BlockStatus
  input: Record<string, unknown>
  output: string
  /** Truncated stdout/stderr stream for live display. */
  error?: string
  exitCode?: number
  /** Line counts for write/edit, so the transcript can summarise a group. */
  added?: number
  removed?: number
  cwd: string
  environmentId: string
  agentId: string
  createdAt: number
  startedAt?: number
  endedAt?: number
  /** Set when the block is a subagent's work, pointing at the parent task block. */
  parentBlockId?: string
  approvalId?: string
}

export type MessagePartType = 'text' | 'reasoning' | 'block' | 'error'

export interface MessagePart {
  type: MessagePartType
  /** For text/reasoning/error parts. */
  text?: string
  /** For block parts. */
  blockId?: string
}

export interface Message {
  id: string
  sessionId: string
  role: 'user' | 'assistant' | 'system'
  parts: MessagePart[]
  attachments?: Attachment[]
  agentId?: string
  model?: string
  createdAt: number
  completedAt?: number
  /**
   * Recorded as the turn ends, cost included. Kept rather than recomputed, so
   * changing a price later does not rewrite what past turns are said to have
   * cost.
   */
  usage?: { input: number; output: number; reasoning?: number; cost?: number }
}

export interface Session {
  id: string
  title: string
  cwd: string
  environmentId: string
  agentId: string
  model: string
  /**
   * This session's own switches. A key that is absent follows the app; that is
   * not the same as `false`, which is this session saying no.
   */
  savings?: Partial<Savings>
  /** What a session stored before there were two switches. Read, never written. */
  mode?: LegacyMode
  /**
   * Run without asking: every `ask` becomes `allow` for this session. The
   * denylist and anything set to `deny` are unaffected.
   */
  autoApprove?: boolean
  /**
   * How hard to try, 1 (faster) to 5 (smarter). Unset means 3.
   *
   * Two things follow from it, and only two, because those are the two this
   * app can honestly change: how much the model may think before answering,
   * for the models that take a reasoning setting, and how many steps a turn
   * may spend. Everything else — which model, which tools — is chosen
   * elsewhere and is not quietly rewritten by a slider.
   */
  effort?: number
  /**
   * The ids of the tool servers this session has switched on.
   *
   * Empty or absent means none, which is what every session is until somebody
   * chooses: what is not here is not in the prefix and is not paid for.
   */
  mcp?: string[]
  status: SessionStatus
  createdAt: number
  updatedAt: number
  /** Accumulated token usage across all turns. */
  usage: { input: number; output: number; cost: number }
  /**
   * Roughly what the next turn will resend — measured when the provider last
   * charged for it, estimated when the transcript has been tightened since.
   * Drives the context gauge.
   */
  contextTokens?: number
  /**
   * How much of the *first* step of the last turn came out of the provider's
   * cache, 0 to 1.
   *
   * The first step is the only one that answers the question that matters:
   * whether this conversation's prefix survived between turns. Later steps of a
   * turn hit the cache almost by definition — they resend what the step before
   * them just sent — so counting those would say every provider caches
   * everything. What this drives is whether the transcript is worth leaving
   * byte-for-byte alone: if the prefix is being served from cache, rewriting it
   * throws that away; if it is not, shrinking it is free.
   */
  cacheShare?: number
  /**
   * What the last turn's request was actually made of, in tokens.
   *
   * Measured where it is built rather than estimated where it is drawn: the
   * transcript, the tool schemas and the system prompt are three different
   * things that grow for three different reasons, and a single "context: 37%"
   * cannot say which of them to do something about. A conversation that is 90%
   * tool schemas needs fewer tools, not a summary.
   *
   * Absent until a turn has run, because before that there is nothing to
   * report and a guess would be worse than a blank.
   */
  contextParts?: {
    /**
     * What the provider charged for the whole first step, which is the one
     * number here that is not an estimate.
     */
    total: number
    /** The model-facing transcript: messages, tool calls and their output. */
    messages: number
    /** The agent's prompt and the rules, including whatever the switches added. */
    system: number
    /** Skills expanded into the message, when any were named. */
    skills?: number
  }
  /**
   * What was typed while the turn was still running.
   *
   * Sending used to be refused outright, which is the wrong answer to "I have
   * one more thing you should know": the thought is gone by the time the turn
   * ends. They queue here instead, survive a restart, and go as the next turn
   * the moment this one stops.
   */
  queuedFollowUps?: string[]
  /** Parent session when this was spawned by a `task` tool call. */
  parentSessionId?: string
  /** Short label for a subagent session, shown on its subchat. */
  taskLabel?: string
  archived?: boolean
  /** Kept at the top of the list, above the grouping. */
  pinned?: boolean

  /* ---- board placement. Absent on a session that is just a chat. ---- */
  boardId?: string
  columnId?: string
  /** Position within the column; lower is higher up. */
  order?: number
  /** What to send when the scheduler starts a queued task. */
  queuedPrompt?: string
  /** Why a human is needed, shown on the card while it sits in Blocked. */
  blockedReason?: string
  /**
   * Other tasks judged to be working on the same thing. Set by the
   * coordinator, shown on the card, and named in the agent's prompt.
   */
  relatedSessionIds?: string[]
  /**
   * Tasks this one is queued behind because they would edit the same files.
   * Cleared when it starts; it is why a card can sit in To do while a slot
   * is free.
   */
  heldBy?: string[]
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  blockId: string
  tool: string
  title: string
  detail: string
  /** The agent's own description of what it is about to do, when it gave one. */
  summary?: string
  /** A diff preview for write/edit, the command for bash. */
  preview?: string
  environmentId: string
  cwd: string
  createdAt: number
}

/**
 * Anything the agent chose not to wait for: a log follow or a dev server, but
 * equally a query or an export that takes a while and does not need to block
 * the turn. Bound to the process, so a restart does not carry them over.
 */
export interface BackgroundTask {
  id: string
  /** The session that started it — a subagent's own session, when delegated. */
  sessionId: string
  /**
   * The chat this belongs to. A subagent runs in a child session, but its
   * background work is the parent conversation's work, so that is where it is
   * listed.
   */
  rootSessionId: string
  command: string
  description: string
  cwd: string
  environmentId: string
  agentId: string
  status: 'running' | 'exited' | 'killed' | 'failed'
  exitCode?: number
  error?: string
  startedAt: number
  endedAt?: number
  /** How much of the output the agent has already read. */
  readOffset: number
  output: string
}

export interface FileEntry {
  name: string
  path: string
  directory: boolean
  size: number
  modifiedAt: number
}

/* ---------- Activity rail filtering ---------- */

export type ActivityGroupBy = 'none' | 'folder' | 'status' | 'date' | 'environment' | 'agent' | 'tool' | 'session'
export type ActivitySortBy = 'recent' | 'oldest' | 'duration' | 'status' | 'tool' | 'folder'

export interface ActivityQuery {
  groupBy: ActivityGroupBy
  sortBy: ActivitySortBy
  search: string
  statuses: BlockStatus[]
  environments: string[]
  agents: string[]
  tools: string[]
  sessionId: string | null
  /** Epoch ms lower bound. */
  since: number | null
}

/** A labelled bucket of rows, for the grouped lists. */
export interface Group<T> {
  key: string
  label: string
  items: T[]
}

/* ---------- Boards ---------- */

/**
 * What a column means, which is what makes the board more than decoration:
 * `todo` is the scheduler's queue, `in-progress` is what is running, `blocked`
 * is waiting on a human. `backlog` and `review` are parked — nothing starts by
 * itself from there.
 */
export type ColumnKind = 'backlog' | 'todo' | 'in-progress' | 'blocked' | 'review' | 'done'

export interface BoardColumn {
  id: string
  name: string
  kind: ColumnKind
  /** Warn past this many cards. Advisory: it never blocks a drag. */
  wipLimit?: number
}

export interface Board {
  id: string
  name: string
  /** The workspace: a folder on an environment. Several boards may share one. */
  cwd: string
  environmentId: string
  columns: BoardColumn[]
  createdAt: number
  updatedAt: number
  archived?: boolean
}

/* ---------- Session list filtering ---------- */

export type SessionGroupBy = 'none' | 'folder' | 'status' | 'date' | 'environment' | 'agent'
export type SessionSortBy = 'recent' | 'created' | 'title' | 'folder' | 'status'
/** `active` is everything not archived — the sensible default, not a state. */
export type SessionStatusFilter =
  | 'active'
  | 'all'
  | 'running'
  | 'queued'
  | 'approval'
  | 'error'
  | 'idle'
  | 'done'

export interface SessionQuery {
  status: SessionStatusFilter
  /** An environment id, or `all`. */
  environment: string
  groupBy: SessionGroupBy
  sortBy: SessionSortBy
  search: string
  /** Whether each row carries its repository's branch and dirty count. */
  showGitStatus: boolean
}

export interface GitSummary {
  isRepo: boolean
  branch: string
  dirty: number
}

export interface ChangedFile {
  path: string
  /** Index + worktree status, e.g. "M", "A", "??". */
  status: string
  added: number
  removed: number
  staged: boolean
}

export interface RepoChanges {
  isRepo: boolean
  root: string
  branch: string
  upstream?: string
  files: ChangedFile[]
  added: number
  removed: number
}

/* ---------- IPC events ---------- */

export type AppEvent =
  | { type: 'config.updated'; config: AppConfig }
  | { type: 'session.created'; session: Session }
  | { type: 'session.updated'; session: Session }
  | { type: 'session.deleted'; sessionId: string }
  /**
   * A session was cut back to an earlier point, so what the renderer holds for
   * it is wrong in a way no incremental event can express: messages and blocks
   * were removed. It refetches.
   */
  | { type: 'session.rewound'; sessionId: string }
  | { type: 'board.updated'; board: Board }
  | { type: 'board.deleted'; boardId: string }
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'message.part.delta'; messageId: string; sessionId: string; partIndex: number; text: string }
  | { type: 'block.created'; block: Block }
  | { type: 'block.updated'; block: Block }
  | { type: 'block.output'; blockId: string; sessionId: string; chunk: string }
  | { type: 'approval.requested'; request: ApprovalRequest }
  | { type: 'approval.resolved'; approvalId: string }
  | { type: 'environment.status'; environmentId: string; connected: boolean; message?: string }
  | { type: 'background.updated'; task: BackgroundTask }
  | { type: 'background.output'; taskId: string; sessionId: string; chunk: string }
  | { type: 'background.cleared'; sessionId: string | null }
  | { type: 'terminal.data'; terminalId: string; chunk: string }
  | { type: 'terminal.exit'; terminalId: string; code: number }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
  /**
   * The state of the model that runs on this machine: what is downloaded,
   * how far a download has got, and whether the server is up. A progress bar
   * cannot be polled into existence, and the install is minutes long.
   */
  | { type: 'local.status'; status: LocalModelStatus }
