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
  /**
   * `why` is for a refusal that was not a person's: the denylist. An agent told
   * only "not permitted" cannot tell a policy from a broken tool, and what it
   * does next is try the same thing another way — so the rule that refused it is
   * named, and the sentence says who refused.
   */
  constructor(what: string, why?: string) {
    super(
      why
        ? `Refused by this machine's configuration (${why}): ${what}. Do not retry it and do not ` +
          `work around it; tell the user what you needed and why.`
        : `Denied by the user: ${what}. Do not retry this; tell the user what you needed and why.`
    )
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
  summary?: string
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
 * by chaining. Every segment has to stand on its own.
 *
 * `&` and a bare newline are separators too. Without them, `cat x & rm -rf ~`
 * was one segment that matched `cat *` and went through without asking.
 */
export function splitCommand(command: string): string[] {
  return command
    .split(/&&|\|\||;|\||&|\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Whether the command does something the text does not show.
 *
 * An allowlist entry like `echo *` is a statement about what `echo` does. It
 * stops being true the moment the line can run another program inside itself or
 * write over a file: `echo $(rm -rf ~)` and `echo x > ~/.zshrc` both matched
 * that pattern and were approved silently.
 *
 * These are not denied — a person may well want them. They just never skip the
 * prompt, because the prompt is the only place the real effect is visible.
 */
export function hasOpaqueShellSyntax(command: string): boolean {
  return (
    command.includes('$(') || // command substitution
    command.includes('`') || // the older spelling of the same thing
    command.includes('>') || // truncates or appends to a file
    command.includes('<(') || // process substitution
    command.includes('<<') // heredoc: the payload is not on this line
  )
}

/**
 * The segment of a command that the denylist refuses, or null.
 *
 * Shared by the agent's own bash calls and by the run button on a code block:
 * the button needs no approval prompt, since clicking it is the approval, but
 * the denylist is about things that should not run however they were asked for.
 */
export function deniedSegment(permissions: Permissions, command: string): string | null {
  return splitCommand(command).find((segment) => matchesAny(segment, permissions.denylist)) ?? null
}

/**
 * The same permissions, minus the questions.
 *
 * Auto-approve lifts `ask` to `allow` and does nothing else. It is not a
 * blanket "run anything": a tool the user set to `deny` stays denied, and the
 * denylist is checked before any mode is consulted, so a command nobody should
 * ever run still cannot run. What it removes is the prompt, not the policy —
 * which is also why it is a property of one session rather than an edit to the
 * config: a standing policy should not be changed by wanting to be left alone
 * for an afternoon.
 */
export function withoutPrompts(permissions: Permissions): Permissions {
  const lift = (mode: PermissionMode): PermissionMode => (mode === 'ask' ? 'allow' : mode)
  return {
    ...permissions,
    bash: lift(permissions.bash),
    edit: lift(permissions.edit),
    write: lift(permissions.write),
    read: lift(permissions.read),
    fetch: lift(permissions.fetch)
  }
}

export interface PermissionDecision {
  mode: PermissionMode
  /** True when an allowlist entry short-circuits the prompt. */
  preapproved: boolean
  /** The denylist pattern that refused it, when that is what happened. */
  deniedBy?: string
}

export function decide(
  permissions: Permissions,
  tool: keyof Omit<Permissions, 'allowlist' | 'denylist'>,
  command?: string
): PermissionDecision {
  const mode = permissions[tool] ?? 'ask'
  if (command) {
    const segments = splitCommand(command)
    const pattern = permissions.denylist.find((entry) =>
      segments.some((segment) => matchesAny(segment, [entry]))
    )
    if (pattern !== undefined) {
      return { mode: 'deny', preapproved: false, deniedBy: `denylist pattern "${pattern}"` }
    }
    if (
      segments.length > 0 &&
      !hasOpaqueShellSyntax(command) &&
      segments.every((s) => matchesAny(s, permissions.allowlist))
    ) {
      return { mode, preapproved: true }
    }
  }
  return { mode, preapproved: false }
}
