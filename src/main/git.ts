import type { ChangedFile, RepoChanges } from '@shared/types'
import type { BlameLine, Commit, CommitDetail } from '@shared/history'
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

/**
 * Just the branch and whether anything is dirty, for the session list.
 *
 * Deliberately not `readChanges`: that runs three commands and counts every
 * line, which is far too much to do once per row. One command answers both
 * questions.
 */
export async function readBranchSummary(
  environmentId: string,
  cwd: string
): Promise<{ isRepo: boolean; branch: string; dirty: number }> {
  const runtime = getRuntime(environmentId)
  await runtime.connect()
  const res = await runtime.exec(
    'git rev-parse --abbrev-ref HEAD 2>/dev/null && git status --porcelain=v1 2>/dev/null | wc -l',
    { cwd, timeoutMs: 15_000 }
  )
  if (res.exitCode !== 0) return { isRepo: false, branch: '', dirty: 0 }
  const [branch, count] = res.stdout.trim().split('\n')
  if (!branch) return { isRepo: false, branch: '', dirty: 0 }
  return { isRepo: true, branch, dirty: Number((count ?? '').trim()) || 0 }
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

/* ---------------- history ---------------- */

/**
 * A history question that cannot be asked has no answer, rather than an error.
 *
 * A folder that is not there — deleted under a session, or never made because
 * the conversation never wrote anything — makes the runtime's exec reject
 * before git ever runs. The pane asking "what happened here" should get
 * "nothing" for that, the same as it does for a folder with no repository.
 */
async function quietly<T>(work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch {
    return fallback
  }
}

/**
 * What happened before now.
 *
 * The Changes pane answers "what is different from the last commit", which is
 * only useful while you are the one making the difference. In a conversation's
 * own folder the log *is* the conversation — one commit per turn, subject the
 * thing that was asked — and in a repository it is how you find out what the
 * agent did three turns ago, or what a file looked like before it touched it.
 *
 * Parsed from a format string with a separator no commit message contains,
 * rather than from the shape of `--graph` output: the graph is for looking at,
 * and a line of it is not a record anything can be asked about.
 */
const LOG_FIELDS = '%H%x1f%h%x1f%an%x1f%at%x1f%p%x1f%s'

function parseLog(out: string): Commit[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [hash, short, author, at, parents, ...rest] = line.split('\u001f')
      return {
        hash,
        short,
        author,
        at: Number(at) * 1000,
        parents: (parents ?? '').split(' ').filter(Boolean),
        subject: rest.join('\u001f')
      }
    })
    .filter((commit) => Boolean(commit.hash))
}

export async function readLog(
  environmentId: string,
  cwd: string,
  options?: { limit?: number; path?: string }
): Promise<Commit[]> {
  const runtime = getRuntime(environmentId)
  await runtime.connect()
  const limit = Math.min(options?.limit ?? 60, 400)
  // --follow only takes one path and only with a path, hence the two shapes.
  const scope = options?.path ? `--follow -- ${shellQuote(options.path)}` : ''
  const res = await quietly(
    () =>
      runtime.exec(
        `git log --no-color --max-count=${limit} --format=${shellQuote(LOG_FIELDS)} ${scope}`,
        { cwd, timeoutMs: 20_000, maxBytes: 400_000 }
      ),
    { stdout: '', stderr: '', exitCode: 1, truncated: false }
  )
  if (res.exitCode !== 0) return []
  return parseLog(res.stdout)
}

/**
 * One commit, in full: who, when, what it said, which files and the diff.
 *
 * `--numstat` and `--name-status` in one call because two round trips to a
 * remote host to describe one commit is two round trips more than it needs.
 */
export async function readCommit(
  environmentId: string,
  cwd: string,
  hash: string
): Promise<CommitDetail> {
  const runtime = getRuntime(environmentId)
  await runtime.connect()
  const safe = shellQuote(hash)

  /*
   * Four requests at once, and `--numstat` and `--name-status` have to be two
   * of them: given both, git honours the last one and drops the other, so
   * asking for counts and letters together silently returns only letters.
   * Measured that way — the file list came back with every count at zero.
   */
  const [head, counted, named, diff] = await Promise.all([
    runtime.exec(`git show --no-patch --format=${shellQuote(LOG_FIELDS)} ${safe}`, {
      cwd,
      timeoutMs: 15_000
    }),
    runtime.exec(`git show --numstat --format= ${safe}`, { cwd, timeoutMs: 20_000 }),
    runtime.exec(`git show --name-status --format= ${safe}`, { cwd, timeoutMs: 20_000 }),
    runtime.exec(`git show --no-color ${safe}`, { cwd, timeoutMs: 25_000, maxBytes: 600_000 })
  ])

  if (head.exitCode !== 0) return { commit: null, files: [], diff: '' }

  /*
   * `--numstat --name-status` prints both tables one after the other: the
   * counted one first, then the lettered one. Same paths in the same order, so
   * they are matched by path rather than by position.
   */
  const counts = new Map<string, { added: number; removed: number }>()
  for (const line of counted.stdout.split('\n')) {
    const numstat = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line)
    if (!numstat) continue
    counts.set(numstat[3], {
      added: numstat[1] === '-' ? 0 : Number(numstat[1]),
      removed: numstat[2] === '-' ? 0 : Number(numstat[2])
    })
  }

  const letters = new Map<string, string>()
  for (const line of named.stdout.split('\n')) {
    // `R100\told\tnew` for a rename: the path that exists now is the last one.
    const entry = /^([A-Z])\d*\t(.+)$/.exec(line)
    if (entry) letters.set(entry[2].split('\t').pop() ?? entry[2], entry[1])
  }

  const files: ChangedFile[] = [...counts.entries()].map(([path, count]) => ({
    path,
    status: letters.get(path) ?? 'M',
    added: count.added,
    removed: count.removed,
    staged: false,
    untracked: false
  }))

  return { commit: parseLog(head.stdout)[0] ?? null, files, diff: diff.stdout }
}

/** One file as one commit left it, for reading rather than diffing. */
export async function readFileAt(
  environmentId: string,
  cwd: string,
  hash: string,
  path: string
): Promise<string> {
  const runtime = getRuntime(environmentId)
  await runtime.connect()
  const res = await runtime.exec(
    `git show ${shellQuote(`${hash}:${path}`)} --no-color`,
    { cwd, timeoutMs: 20_000, maxBytes: 400_000 }
  )
  return res.exitCode === 0 ? res.stdout : `(${path} is not in ${hash.slice(0, 8)})`
}

/**
 * Who last touched each line, and when.
 *
 * The question a diff cannot answer: a diff says what changed now, blame says
 * when this line arrived and what the commit that brought it was for — which
 * in a conversation's own folder is the turn that asked for it.
 *
 * `--line-porcelain` repeats the commit header for every line, which is more
 * bytes and far less parsing than the compact form, and the bytes are local.
 */
export async function readBlame(
  environmentId: string,
  cwd: string,
  path: string,
  options?: { from?: number; lines?: number }
): Promise<BlameLine[]> {
  const runtime = getRuntime(environmentId)
  await runtime.connect()
  const range =
    options?.from && options?.lines ? `-L ${options.from},+${Math.min(options.lines, 500)}` : ''
  /*
   * No `--no-color` here, however consistent that would look: for blame it is
   * ambiguous — `--no-color-lines` and `--no-color-by-age` both match it — and
   * git answers the whole command with a usage message and a non-zero exit.
   * Porcelain output is not coloured anyway.
   */
  const res = await runtime.exec(
    `git blame --line-porcelain ${range} -- ${shellQuote(path)}`,
    { cwd, timeoutMs: 25_000, maxBytes: 800_000 }
  )
  if (res.exitCode !== 0) return []

  const out: BlameLine[] = []
  let current: Partial<BlameLine> = {}
  for (const line of res.stdout.split('\n')) {
    const header = /^([0-9a-f]{40})\s+\d+\s+(\d+)/.exec(line)
    if (header) {
      current = { hash: header[1], short: header[1].slice(0, 8), line: Number(header[2]) }
      continue
    }
    if (line.startsWith('author ')) current.author = line.slice(7)
    else if (line.startsWith('author-time ')) current.at = Number(line.slice(12)) * 1000
    else if (line.startsWith('\t')) {
      out.push({
        hash: current.hash ?? '',
        short: current.short ?? '',
        author: current.author ?? '',
        at: current.at ?? 0,
        line: current.line ?? out.length + 1,
        text: line.slice(1)
      })
    }
  }
  return out
}
