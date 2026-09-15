/** Shared types between the main process, the preload bridge and the renderer. */

export type BlockStatus = 'pending' | 'awaiting-approval' | 'running' | 'success' | 'error' | 'canceled'

export type SessionStatus = 'idle' | 'running' | 'awaiting-approval' | 'error'

export type EnvironmentKind = 'local' | 'ssh'

export interface EnvironmentConfig {
  id: string
  name: string
  kind: EnvironmentKind
  /** Default working directory for new sessions on this environment. */
  cwd?: string
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

export interface ProviderModelConfig {
  id: string
  name: string
  /** Advertised context window, used for the token meter. */
  contextWindow?: number
  maxOutputTokens?: number
  reasoning?: boolean
  toolCall?: boolean
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

export interface AppConfig {
  $schema?: string
  model: string
  smallModel?: string
  provider: Record<string, ProviderConfig>
  environment: Record<string, EnvironmentConfig>
  agent: Record<string, AgentConfig>
  permissions: Permissions
  maxSteps: number
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
  archived?: boolean
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
  | { type: 'message.created'; message: Message }
  | { type: 'message.updated'; message: Message }
  | { type: 'message.part.delta'; messageId: string; sessionId: string; partIndex: number; text: string }
  | { type: 'block.created'; block: Block }
  | { type: 'block.updated'; block: Block }
  | { type: 'block.output'; blockId: string; sessionId: string; chunk: string }
  | { type: 'approval.requested'; request: ApprovalRequest }
  | { type: 'approval.resolved'; approvalId: string }
  | { type: 'environment.status'; environmentId: string; connected: boolean; message?: string }
  | { type: 'terminal.data'; terminalId: string; chunk: string }
  | { type: 'terminal.exit'; terminalId: string; code: number }
  | { type: 'toast'; level: 'info' | 'warn' | 'error'; message: string }
