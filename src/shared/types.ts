/** Shared types between the main process, the preload bridge and the renderer. */

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
}

export interface ProviderConfig {
  id: string
  /** The AI SDK package that backs this provider. */
  npm: string
  name: string
  options: {
    baseURL?: string
    apiKey?: string
    headers?: Record<string, string>
    [key: string]: unknown
  }
  models: Record<string, ProviderModelConfig>
}

export type PermissionMode = 'ask' | 'allow' | 'deny'

export interface Permissions {
  bash: PermissionMode
  edit: PermissionMode
  write: PermissionMode
  read: PermissionMode
  fetch: PermissionMode
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
 * The session is not pinned to one agent: an orchestrator splits the request
 * into tasks and picks an agent for each.
 */
export const AUTO_AGENT = 'auto'

export interface AppConfig {
  $schema?: string
  model: string
  smallModel?: string
  provider: Record<string, ProviderConfig>
  environment: Record<string, EnvironmentConfig>
  agent: Record<string, AgentConfig>
  permissions: Permissions
  maxSteps: number
  /** How many board tasks the scheduler will run at once. */
  maxConcurrentTasks?: number
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
  usage?: { input: number; output: number; reasoning?: number; cost?: number }
}

export interface Session {
  id: string
  title: string
  cwd: string
  environmentId: string
  agentId: string
  model: string
  status: SessionStatus
  createdAt: number
  updatedAt: number
  /** Accumulated token usage across all turns. */
  usage: { input: number; output: number; cost: number }
  /** Parent session when this was spawned by a `task` tool call. */
  parentSessionId?: string
  /** Short label for a subagent session, shown on its subchat. */
  taskLabel?: string
  archived?: boolean

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
}

export interface ApprovalRequest {
  id: string
  sessionId: string
  blockId: string
  tool: string
  title: string
  detail: string
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
