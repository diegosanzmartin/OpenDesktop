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

export function parseDocument<T = Record<string, unknown>>(text: string): Document<Partial<T>> {
  const match = FENCE.exec(text)
  if (!match) return { data: {}, body: text.trim() }
  let data: Partial<T> = {}
  try {
    data = (parseYaml(match[1]) as Partial<T>) ?? {}
  } catch {
    // A malformed header should not lose the body.
  }
  return { data, body: text.slice(match[0].length).trim() }
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
