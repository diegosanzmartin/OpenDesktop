import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Skill } from '@shared/types'
import { CONFIG_DIR } from './config'
import { parseDocument } from './frontmatter'

/**
 * Skills are directories holding a SKILL.md — the layout these folders use,
 * so a skill can be copied between the two without editing. The frontmatter
 * carries the name and the description; the body is the instructions that get
 * put in front of the model when the skill is invoked.
 */
export const SKILLS_DIR = join(CONFIG_DIR, 'skills')
const CLAUDE_SKILLS_DIR = join(homedir(), '.claude', 'skills')

interface SkillFrontmatter {
  name: string
  description: string
}

function readSkillDir(root: string, id: string): Skill | null {
  const dir = join(root, id)
  const file = join(dir, 'SKILL.md')
  if (!existsSync(file)) return null
  try {
    const { data, body } = parseDocument<SkillFrontmatter>(readFileSync(file, 'utf8'))
    const extras = readdirSync(dir).filter((entry) => entry !== 'SKILL.md')
    return {
      id,
      name: data.name?.trim() || id,
      description: data.description?.trim() ?? '',
      path: dir,
      files: extras,
      instructions: body
    }
  } catch {
    return null
  }
}

export function listSkills(): Skill[] {
  mkdirSync(SKILLS_DIR, { recursive: true })
  const out: Skill[] = []
  for (const entry of readdirSync(SKILLS_DIR)) {
    if (entry.startsWith('.') || entry === '_sync') continue
    if (!statSync(join(SKILLS_DIR, entry)).isDirectory()) continue
    const skill = readSkillDir(SKILLS_DIR, entry)
    if (skill) out.push(skill)
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function getSkill(id: string): Skill | null {
  return readSkillDir(SKILLS_DIR, id)
}

export function deleteSkill(id: string): void {
  const dir = join(SKILLS_DIR, id)
  if (existsSync(dir)) rmSync(dir, { recursive: true })
}

/** Skills available to import, with a flag for the ones already here. */
export function importableSkills(dir = CLAUDE_SKILLS_DIR): (Skill & { alreadyHere: boolean })[] {
  if (!existsSync(dir)) return []
  const here = new Set(listSkills().map((skill) => skill.id))
  const out: (Skill & { alreadyHere: boolean })[] = []
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.') || entry === '_sync') continue
    if (!statSync(join(dir, entry)).isDirectory()) continue
    const skill = readSkillDir(dir, entry)
    if (skill) out.push({ ...skill, alreadyHere: here.has(skill.id) })
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function importSkills(ids: string[], dir = CLAUDE_SKILLS_DIR): number {
  mkdirSync(SKILLS_DIR, { recursive: true })
  let imported = 0
  for (const id of ids) {
    const source = join(dir, id)
    if (!existsSync(join(source, 'SKILL.md'))) continue
    // The whole directory: a skill's references and scripts travel with it.
    cpSync(source, join(SKILLS_DIR, id), { recursive: true })
    imported++
  }
  return imported
}

/**
 * Replaces `/skill-name` mentions with the skill's instructions.
 *
 * The mention itself is left in the visible message — the user typed it and
 * should see it — while the model is handed the full text, which is how a slash
 * command is meant to behave.
 */
export function expandSkills(text: string): { prompt: string; used: string[] } {
  const skills = listSkills()
  if (skills.length === 0) return { prompt: text, used: [] }

  const used: string[] = []
  for (const skill of skills) {
    const mention = new RegExp(`(^|\\s)/${skill.id}(?=\\s|$)`, 'm')
    if (mention.test(text)) used.push(skill.id)
  }
  if (used.length === 0) return { prompt: text, used: [] }

  const blocks = used.map((id) => {
    const skill = skills.find((s) => s.id === id)!
    return `<skill name="${skill.name}" id="${skill.id}" path="${skill.path}">\n${skill.instructions}\n</skill>`
  })

  return {
    prompt: `${blocks.join('\n\n')}\n\nThe skills above were invoked by the user for this request. Follow them.\n\n${text}`,
    used
  }
}
