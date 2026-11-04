import type { Block, Message, Session } from './types'

/**
 * A conversation as Markdown, to hand over, archive or read in review.
 *
 * Who said what in order, the commands with their output, the edits as diffs
 * and what failed. The model's reasoning is left out: it is working, not the
 * record. Long output is cut, since a file someone opens to read is not a log.
 */

const OUTPUT_LINES = 40

function fence(language: string, text: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length))
  const ticks = '`'.repeat(longest + 1)
  return `${ticks}${language}\n${text}\n${ticks}`
}

function cut(text: string): string {
  const lines = text.replace(/\s+$/, '').split('\n')
  if (lines.length <= OUTPUT_LINES) return lines.join('\n')
  return `${lines.slice(0, OUTPUT_LINES).join('\n')}\n… ${lines.length - OUTPUT_LINES} more lines`
}

function blockMarkdown(block: Block): string {
  const out: string[] = []
  const command = typeof block.input.command === 'string' ? block.input.command : null
  const path = typeof block.input.path === 'string' ? block.input.path : null
  if (block.tool === 'bash' || block.tool === 'verify') {
    out.push(fence('sh', command ?? block.title))
    if (block.output.trim()) out.push(fence('', cut(block.output)))
  } else if (block.tool === 'edit' || block.tool === 'write') {
    const happened = block.status !== 'error' && block.status !== 'canceled'
    const verb = block.tool === 'edit' ? (happened ? 'Edited' : "Couldn't edit") : happened ? 'Wrote' : "Couldn't write"
    out.push(`**${verb}** \`${path ?? block.title}\``)
    if (block.output.trim()) out.push(fence(/^[-+@]/m.test(block.output) ? 'diff' : '', cut(block.output)))
  } else {
    out.push(`**${block.tool}** ${path ? `\`${path}\`` : block.title}`)
  }
  if (block.error) out.push(`> ${block.error.replace(/\n/g, '\n> ')}`)
  return out.join('\n\n')
}

export function transcriptMarkdown(session: Session, messages: Message[], blocks: Block[]): string {
  const byId = new Map(blocks.map((block) => [block.id, block]))
  const when = new Date(session.createdAt ?? Date.now()).toISOString().slice(0, 16).replace('T', ' ')
  const out: string[] = [
    `# ${session.title || 'Conversation'}`,
    `\`${session.cwd}\` · ${session.model} · ${when} UTC`
  ]
  for (const message of messages) {
    const parts: string[] = []
    for (const part of message.parts) {
      if (part.type === 'text' && part.text?.trim()) parts.push(part.text.trim())
      else if (part.type === 'error' && part.text?.trim()) parts.push(`> **Error:** ${part.text.trim()}`)
      else if (part.type === 'block' && part.blockId) {
        const block = byId.get(part.blockId)
        if (block) parts.push(blockMarkdown(block))
      }
    }
    if (parts.length === 0) continue
    out.push(`## ${message.role === 'user' ? 'You' : 'Agent'}`, ...parts)
  }
  return `${out.join('\n\n')}\n`
}
