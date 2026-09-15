import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'

/**
 * The `---` YAML header used by the agent and skill files. Adopting the
 * same shape is what makes those files importable without conversion.
 */
export interface Document<T> {
  data: T
  body: string
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Recovers a header that strict YAML rejects.
 *
 * Skill and agent descriptions are prose, and prose contains colons — "Defines
 * the mandatory rule: never override…" is not valid unquoted YAML, yet files
 * like that are common and other tools read them. Rather than drop the whole
 * header and lose the name as well, take each `key: value` line verbatim.
 * Nested maps are not recoverable this way, but a file that needs them is a
 * file that parsed cleanly in the first place.
 */
function lenientParse(header: string): Record<string, string> {
  const out: Record<string, string> = {}
  let key: string | null = null

  for (const line of header.split('\n')) {
    const match = /^([A-Za-z_][\w-]*):[ \t]?(.*)$/.exec(line)
    if (match && !/^\s/.test(line)) {
      key = match[1]
      out[key] = match[2].trim()
    } else if (key && line.trim()) {
      // A wrapped value continues the previous key.
      out[key] = `${out[key]} ${line.trim()}`.trim()
    }
  }

  for (const [name, value] of Object.entries(out)) {
    out[name] = value.replace(/^["']|["']$/g, '')
  }
  return out
}

export function parseDocument<T = Record<string, unknown>>(
  text: string
): Document<Partial<T>> & { lenient: boolean } {
  const match = FENCE.exec(text)
  if (!match) return { data: {}, body: text.trim(), lenient: false }

  let data: Partial<T> = {}
  let lenient = false
  try {
    data = (parseYaml(match[1]) as Partial<T>) ?? {}
  } catch {
    data = lenientParse(match[1]) as Partial<T>
    lenient = true
  }
  return { data, body: text.slice(match[0].length).trim(), lenient }
}

export function stringifyDocument(data: Record<string, unknown>, body: string): string {
  const clean: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue
    if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) continue
    clean[key] = value
  }
  return `---\n${stringifyYaml(clean).trim()}\n---\n\n${body.trim()}\n`
}
