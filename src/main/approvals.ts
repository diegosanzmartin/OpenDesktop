import { nanoid } from 'nanoid'
import type { ApprovalRequest, PermissionMode, Permissions } from '@shared/types'
import { bus } from './bus'

export type ApprovalAnswer = 'once' | 'always' | 'reject'

interface Pending {
  request: ApprovalRequest
  resolve: (answer: ApprovalAnswer) => void
}

const pending = new Map<string, Pending>()
/** Per-session grants keyed by `tool` or `tool:signature`, from "Always allow". */
const sessionGrants = new Map<string, Set<string>>()

export class PermissionDenied extends Error {
  constructor(what: string) {
    super(`Denied by the user: ${what}. Do not retry this; tell the user what you needed and why.`)
  }
}

export function listPending(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.request)
}

export function grantForSession(sessionId: string, key: string): void {
  const set = sessionGrants.get(sessionId) ?? new Set<string>()
  set.add(key)
  sessionGrants.set(sessionId, set)
}

export function hasSessionGrant(sessionId: string, key: string): boolean {
  return sessionGrants.get(sessionId)?.has(key) ?? false
}

export function clearSessionGrants(sessionId: string): void {
  sessionGrants.delete(sessionId)
}

export function resolveApproval(approvalId: string, answer: ApprovalAnswer): void {
  const entry = pending.get(approvalId)
  if (!entry) return
  pending.delete(approvalId)
  bus.emit({ type: 'approval.resolved', approvalId })
  if (answer === 'always') grantForSession(entry.request.sessionId, entry.request.tool)
  entry.resolve(answer)
}

/** Rejects everything outstanding for a session, e.g. when the user stops the turn. */
export function cancelSessionApprovals(sessionId: string): void {
  for (const [id, entry] of [...pending.entries()]) {
    if (entry.request.sessionId !== sessionId) continue
    pending.delete(id)
    bus.emit({ type: 'approval.resolved', approvalId: id })
    entry.resolve('reject')
  }
}

export function requestApproval(input: {
  sessionId: string
  blockId: string
  tool: string
  title: string
  detail: string
  preview?: string
  environmentId: string
  cwd: string
}): Promise<ApprovalAnswer> {
  const request: ApprovalRequest = { ...input, id: nanoid(10), createdAt: Date.now() }
  return new Promise<ApprovalAnswer>((resolve) => {
    pending.set(request.id, { request, resolve })
    bus.emit({ type: 'approval.requested', request })
  })
}

/* ---------------- pattern matching ---------------- */

function patternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`)
}

export function matchesAny(value: string, patterns: string[]): boolean {
  return patterns.some((p) => patternToRegExp(p.trim()).test(value.trim()))
}

/**
 * Splits a compound shell command so an allowlist entry cannot be smuggled past
 * by chaining (`ls && rm -rf /`). Every segment must be allowed on its own.
 */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||;|\|/)
    .map((s) => s.trim())
    .filter(Boolean)
}

export interface PermissionDecision {
  mode: PermissionMode
  /** True when an allowlist entry short-circuits the prompt. */
  preapproved: boolean
}

export function decide(
  permissions: Permissions,
  tool: keyof Omit<Permissions, 'allowlist' | 'denylist'>,
  command?: string
): PermissionDecision {
  const mode = permissions[tool] ?? 'ask'
  if (command) {
    const segments = splitCommand(command)
    if (segments.some((s) => matchesAny(s, permissions.denylist))) {
      return { mode: 'deny', preapproved: false }
    }
    if (segments.length > 0 && segments.every((s) => matchesAny(s, permissions.allowlist))) {
      return { mode, preapproved: true }
    }
  }
  return { mode, preapproved: false }
}
