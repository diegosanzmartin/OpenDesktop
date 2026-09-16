/**
 * Naming an agent in a sentence: `@Infrastructure`.
 *
 * The same matcher runs on both sides — the main process, to tell the manager
 * which agent the user meant, and the renderer, to draw the name as that
 * agent's chip. If they disagreed, the transcript would highlight one thing and
 * the model would be told another.
 */

export interface MentionTarget {
  id: string
  name: string
}

/** How an agent is written in a message: its name, or its id if the name has spaces. */
export function mentionToken(agent: MentionTarget): string {
  return /\s/.test(agent.name) ? `@${agent.id}` : `@${agent.name}`
}

function normalise(value: string): string {
  return value.toLowerCase().replace(/[\s_-]/g, '')
}

/** `@` followed by a name — not inside a word, so an email address is not a mention. */
const MENTION = /(^|[^\w@/])@([\w-]{1,64})/g

export interface Mention {
  /** Where the `@` sits, so the renderer can slice the text around it. */
  start: number
  end: number
  text: string
  agentId?: string
}

export function scanMentions(text: string, agents: MentionTarget[]): Mention[] {
  const out: Mention[] = []
  for (const match of text.matchAll(MENTION)) {
    const lead = match[1] ?? ''
    const start = (match.index ?? 0) + lead.length
    const word = match[2]
    const agent = agents.find(
      (candidate) => normalise(candidate.id) === normalise(word) || normalise(candidate.name) === normalise(word)
    )
    out.push({ start, end: start + word.length + 1, text: `@${word}`, agentId: agent?.id })
  }
  return out
}

/** The agents named in a message, in the order they were named, without repeats. */
export function mentionedAgents(text: string, agents: MentionTarget[]): string[] {
  const seen = new Set<string>()
  for (const mention of scanMentions(text, agents)) {
    if (mention.agentId) seen.add(mention.agentId)
  }
  return [...seen]
}

/**
 * The message broken into plain runs and mentions, for rendering. Only mentions
 * that resolve to a real agent are split out: an unmatched `@word` is ordinary
 * prose and drawing it as a chip would claim an agent exists that does not.
 */
export function splitMentions(
  text: string,
  agents: MentionTarget[]
): { text: string; agentId?: string }[] {
  const found = scanMentions(text, agents).filter((mention) => mention.agentId)
  if (found.length === 0) return [{ text }]

  const parts: { text: string; agentId?: string }[] = []
  let last = 0
  for (const mention of found) {
    if (mention.start > last) parts.push({ text: text.slice(last, mention.start) })
    parts.push({ text: mention.text, agentId: mention.agentId })
    last = mention.end
  }
  if (last < text.length) parts.push({ text: text.slice(last) })
  return parts
}
