import type { ChangedFile, RepoChanges } from '@shared/types'
import { getRuntime, shellQuote } from './runtime'

/**
 * Reads the working tree for the Changes pane. Everything goes through the
 * session's runtime, so a remote session reports the remote repository.
 */
const EMPTY: RepoChanges = {
  isRepo: false,
  root: '',
  branch: '',
  files: [],
  added: 0,
  removed: 0
}

/** `git status --porcelain` status codes, rendered as the letter the UI shows. */
function label(code: string): string {
  const trimmed = code.trim()
  if (trimmed === '??') return 'U'
  return trimmed[0] ?? 'M'
}

export async function readChanges(environmentId: string, cwd: string): Promise<RepoChanges> {
  const runtime = getRuntime(environmentId)
  await runtime.connect()

  const probe = await runtime.exec(
    `git rev-parse --show-toplevel 2>/dev/null && git rev-parse --abbrev-ref HEAD 2>/dev/null`,
    { cwd, timeoutMs: 15_000 }
  )
  if (probe.exitCode !== 0) return EMPTY

  const [root, branch] = probe.stdout.trim().split('\n')
  if (!root) return EMPTY

  // -z keeps paths with spaces or quotes intact; numstat gives the counts.
  const [statusRes, numstatRes, untrackedRes] = await Promise.all([
    runtime.exec('git status --porcelain=v1 -z', { cwd, timeoutMs: 20_000 }),
    runtime.exec('git diff HEAD --numstat -z', { cwd, timeoutMs: 20_000 }),
    runtime.exec('git ls-files --others --exclude-standard -z', { cwd, timeoutMs: 20_000 })
  ])

  const counts = new Map<string, { added: number; removed: number }>()
  const numstat = numstatRes.stdout.split('\0').filter(Boolean)
  for (let i = 0; i < numstat.length; i++) {
    const parts = numstat[i].split('\t')
    if (parts.length < 3) continue
    const [added, removed, path] = parts
    counts.set(path, {
      // "-" means binary.
      added: added === '-' ? 0 : Number(added) || 0,
      removed: removed === '-' ? 0 : Number(removed) || 0
    })
  }

  const files: ChangedFile[] = []
  const seen = new Set<string>()
  for (const entry of statusRes.stdout.split('\0')) {
    if (!entry) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path || seen.has(path)) continue
    seen.add(path)
    const count = counts.get(path) ?? { added: 0, removed: 0 }
    files.push({
      path,
      status: label(code),
      added: count.added,
      removed: count.removed,
      staged: code[0] !== ' ' && code[0] !== '?'
    })
  }

  // Untracked files have no diff, so count their lines to make the panel useful.
  const untracked = untrackedRes.stdout.split('\0').filter(Boolean)
  if (untracked.length > 0 && untracked.length <= 40) {
    const command = untracked.map((p) => `wc -l < ${shellQuote(p)} 2>/dev/null || echo 0`).join('; ')
    const wc = await runtime.exec(command, { cwd, timeoutMs: 20_000 })
    const lines = wc.stdout.trim().split('\n')
    untracked.forEach((path, index) => {
      const file = files.find((f) => f.path === path)
      if (file) file.added = Number(lines[index]?.trim()) || 0
    })
  }

  files.sort((a, b) => a.path.localeCompare(b.path))
  return {
    isRepo: true,
    root,
    branch: branch || 'HEAD',
    files,
    added: files.reduce((sum, f) => sum + f.added, 0),
    removed: files.reduce((sum, f) => sum + f.removed, 0)
  }
}

/** The unified diff for one file, for the expanded row in the Changes pane. */
export async function readFileDiff(
  environmentId: string,
  cwd: string,
  path: string,
  untracked: boolean
): Promise<string> {
  const runtime = getRuntime(environmentId)
  await runtime.connect()
  const command = untracked
    ? `git diff --no-index --no-color -- /dev/null ${shellQuote(path)} 2>/dev/null || true`
    : `git diff HEAD --no-color -- ${shellQuote(path)}`
  const res = await runtime.exec(command, { cwd, timeoutMs: 20_000, maxBytes: 400_000 })
  return res.stdout || '(no textual diff)'
}
