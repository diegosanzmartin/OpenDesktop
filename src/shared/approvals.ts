import type { ApprovalRequest } from './types'

/**
 * The question put to a person when the agent wants to do something.
 *
 * Phrased as the actual act — "overwrite config.ts", "run this command" —
 * rather than as the tool's name. Someone deciding in one second should be
 * reading what will happen, not translating a tool call into it.
 */
export function approvalQuestion(request: ApprovalRequest, agentName: string): string {
  const who = agentName || 'the agent'

  // The agent's own label goes on the line beneath (approvalDetail): it is free
  // text, often not a verb phrase, and "Allow X to negative test of…" reads broken.
  if (request.tool === 'bash') return `Allow ${who} to run this command?`

  // read/write/edit already read as an instruction: "Edit /path", "Create /path".
  const detail = request.detail?.trim()
  // An MCP detail is "<server>: <tool>", and a server name is free text, not a verb.
  if (request.tool === 'mcp' && detail) return `Allow ${who} to use ${detail}?`
  if (detail && /^[A-Za-z]+\s/.test(detail)) return `Allow ${who} to ${lowerFirst(detail)}?`

  return `Allow ${who} to use ${request.tool}?`
}

function lowerFirst(text: string): string {
  // Only the first letter, and only when it is not part of something like a
  // path or an acronym that means something in capitals.
  if (/^[A-Z][a-z]/.test(text)) return text.charAt(0).toLowerCase() + text.slice(1)
  return text
}

/** The line under the question: what the agent said it was doing. */
export function approvalDetail(request: ApprovalRequest): string {
  if (request.tool === 'bash') return request.summary?.trim() || request.title
  return request.detail
}
