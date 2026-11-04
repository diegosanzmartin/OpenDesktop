import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AppConfig } from '@shared/types'
import { deniedSegment, hasOpaqueShellSyntax, matchesAny, splitCommand } from './approvals'
import { DATA_DIR, loadConfig, saveConfig } from './config'

/**
 * Learning from what a person approves by hand.
 *
 * "It asks too much" is usually the same few commands approved over and over.
 * After the third approval of the same pattern, the app offers to put it on the
 * allowlist — a deterministic rule the person reads and accepts, not something
 * the app decides for them. Never for commands that remove, move, push or
 * reach out, whatever the count.
 */

const AFTER = 3
const FILE = (): string => join(DATA_DIR, 'learned-approvals.json')

// Programs no count of approvals turns into "never ask again".
const NEVER = new Set([
  'rm', 'rmdir', 'mv', 'cp', 'dd', 'chmod', 'chown', 'ln', 'truncate', 'shred',
  'sudo', 'su', 'doas', 'kill', 'pkill', 'killall', 'shutdown', 'reboot', 'launchctl',
  'curl', 'wget', 'ssh', 'scp', 'sftp', 'rsync', 'nc', 'telnet', 'ftp',
  'terraform', 'kubectl', 'helm', 'gcloud', 'aws', 'az', 'gh',
  'bash', 'sh', 'zsh', 'eval', 'exec', 'xargs', 'env', 'nohup', 'osascript'
])
// Interpreters and runners: offered only for one script or tool (`node test.js *`, `npx tsc *`),
// never bare or with a flag first: `node *` is `node -e` too, permission to run any code at all.
const INTERPRETERS = new Set(['node', 'python', 'python3', 'perl', 'ruby', 'php', 'deno', 'bun', 'lua', 'awk', 'gawk', 'npx', 'pnpx', 'bunx', 'docker', 'podman'])
// Subcommands that run whatever comes after them: `npm exec`, `pnpm dlx`, `docker run`.
const RUNS_ANYTHING = new Set(['exec', 'dlx', 'x', 'node', 'run', 'compose', 'build'])
// Package managers whose `run` only runs the project's own scripts.
const SCRIPT_RUNNERS = new Set(['npm', 'pnpm', 'yarn', 'bun'])
const GIT_NEVER = new Set(['push', 'reset', 'rebase', 'clean', 'branch', 'tag', 'remote', 'checkout', 'switch', 'restore', 'rm', 'mv', 'filter-branch', 'gc', 'prune'])

/** The allowlist pattern a person would write for this command, or null when none should be offered. */
export function approvalPattern(command: string): string | null {
  if (hasOpaqueShellSyntax(command)) return null
  const segments = splitCommand(command).filter((segment) => !/^cd(?:\s|$)/.test(segment))
  if (segments.length !== 1) return null
  const [first, second] = segments[0].split(/\s+/)
  // `FOO=1 rm …` runs rm, and `/bin/rm` is rm: neither may slip past NEVER under another name.
  if (!first || /^[A-Za-z_]\w*=/.test(first) || /['"`$\\]/.test(first)) return null
  const program = first.replace(/^.*\//, '')
  if (NEVER.has(program)) return null
  // git's first word is what it does; `git -c … log` would otherwise offer `git *`, push included.
  if (program === 'git' && (!second || second.startsWith('-') || GIT_NEVER.has(second))) return null
  const keepsSecond = second !== undefined && !second.startsWith('-') && !/['"`$]/.test(second)
  if (INTERPRETERS.has(program) && !keepsSecond) return null
  if (keepsSecond && RUNS_ANYTHING.has(second) && !(second === 'run' && SCRIPT_RUNNERS.has(program))) return null
  // A space before `*`: `make *` covers `make` and `make test`, not `makefoo`.
  return keepsSecond ? `${first} ${second} *` : `${first} *`
}

interface Learned {
  patterns: Record<string, { count: number; example: string; lastAt: number }>
  dismissed: string[]
}

function load(): Learned {
  try {
    if (existsSync(FILE())) return JSON.parse(readFileSync(FILE(), 'utf8')) as Learned
  } catch {
    // A file that does not parse starts the count again; it is a convenience, not a record.
  }
  return { patterns: {}, dismissed: [] }
}

function save(learned: Learned): void {
  writeFileSync(FILE(), JSON.stringify(learned, null, 2), 'utf8')
}

/** A person approved a call by hand. */
export function recordApproval(request: { tool: string; command?: string }): void {
  if (request.tool !== 'bash' || !request.command) return
  const pattern = approvalPattern(request.command)
  if (!pattern) return
  const learned = load()
  const seen = learned.patterns[pattern] ?? { count: 0, example: request.command, lastAt: 0 }
  learned.patterns[pattern] = { count: seen.count + 1, example: request.command, lastAt: Date.now() }
  save(learned)
}

export interface Suggestion {
  pattern: string
  count: number
  example: string
}

/** Patterns approved often enough to offer, that nothing already allows or denies. */
export function suggestions(config: AppConfig): Suggestion[] {
  const learned = load()
  return Object.entries(learned.patterns)
    .filter(([pattern, seen]) => seen.count >= AFTER && !learned.dismissed.includes(pattern))
    .filter(([pattern, seen]) => !config.permissions.allowlist.includes(pattern) && !matchesAny(seen.example, config.permissions.allowlist))
    .filter(([, seen]) => deniedSegment(config.permissions, seen.example) === null)
    .map(([pattern, seen]) => ({ pattern, count: seen.count, example: seen.example }))
    .sort((a, b) => b.count - a.count)
}

export function acceptSuggestion(pattern: string): void {
  const config = loadConfig()
  if (config.permissions.allowlist.includes(pattern)) return
  saveConfig({ ...config, permissions: { ...config.permissions, allowlist: [...config.permissions.allowlist, pattern] } })
}

export function dismissSuggestion(pattern: string): void {
  const learned = load()
  if (!learned.dismissed.includes(pattern)) learned.dismissed.push(pattern)
  save(learned)
}
