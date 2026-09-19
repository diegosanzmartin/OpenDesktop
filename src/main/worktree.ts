/**
 * A branch of its own, for a conversation on somebody's real repository.
 *
 * The other two halves of working on one repository at once — telling an agent
 * that another task has changed the file it just saved, and telling the person
 * which conversations are in the same files — are both warnings. They make a
 * collision visible; they do not make it impossible. Two agents editing the
 * same checkout still edit the same checkout, and a third of the way through a
 * refactor somebody's test run picks up half of somebody else's.
 *
 * `git worktree` is the answer git already has: a second checkout of the same
 * repository, on its own branch, sharing one object database. No clone, no
 * second remote, no copy of the history. Each conversation gets one on request
 * and works there in complete isolation; what it did is a branch, which is a
 * thing the person already knows how to read, merge or throw away.
 *
 * Three deliberate limits:
 *
 *  - **On request, never by default.** A worktree does not have the
 *    dependencies installed — no `node_modules`, no `.venv`, no `.env` — and
 *    it starts from HEAD, so uncommitted work in the main checkout is not
 *    there. That is the right trade for a day of parallel refactoring and the
 *    wrong one for a question about a file.
 *
 *  - **The branch outlives the conversation.** Removing the checkout is free;
 *    removing the branch is losing work. Deleting a conversation takes its
 *    worktree away and leaves the branch, after committing anything still
 *    uncommitted in it, so nothing this app made is ever silently discarded.
 *
 *  - **Nothing is merged for anybody.** What to do with the branch is the
 *    question this app is least qualified to answer.
 */
import { join } from 'node:path'
import { homedir } from 'node:os'
import type {
  Session,
  WorktreeInfo,
  WorktreeOffer,
  WorktreeRemoval,
  WorktreeStatus
} from '@shared/types'
import { getRuntime, shellQuote } from './runtime'
import { logLine } from './log'

const ROOT = process.env.OPENDESKTOP_HOME

/** Beside the conversations' own folders, under the app's own directory. */
export const LOCAL_WORKTREES_DIR = ROOT
  ? join(ROOT, 'local', 'worktrees')
  : join(homedir(), '.opendesktop', 'worktrees')

async function worktreesDir(environmentId: string): Promise<string> {
  const runtime = getRuntime(environmentId)
  if (runtime.kind === 'local') return LOCAL_WORKTREES_DIR
  // A remote host has its own home, and the path has to exist over there.
  return join(await runtime.homeDir(), '.opendesktop', 'worktrees')
}

async function run(
  environmentId: string,
  cwd: string,
  command: string
): Promise<{ ok: boolean; out: string }> {
  const runtime = getRuntime(environmentId)
  await runtime.connect()
  try {
    const result = await runtime.exec(command, { cwd, timeoutMs: 60_000 })
    return { ok: result.exitCode === 0, out: `${result.stdout}${result.stderr}`.trim() }
  } catch (err) {
    return { ok: false, out: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * A branch name somebody can read in `git branch` a week later.
 *
 * The conversation's title, which is what they will remember it by, plus
 * enough of its id to keep two chats about the same thing apart. Under
 * `opendesktop/` so every branch this app made can be found, and listed, and
 * deleted, with one pattern.
 */
export function branchNameFor(sessionId: string, title: string): string {
  const slug = title
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
    .replace(/-+$/, '')
  return `opendesktop/${slug || 'chat'}-${sessionId.slice(0, 6).toLowerCase()}`
}

/**
 * Whether this conversation could have a branch of its own, and from what.
 *
 * Everything here is a reason it would not work rather than a policy: no
 * repository to cut from, no commit to cut at, or a folder that is already the
 * app's own and has nobody else in it.
 */
export async function worktreeOffer(session: Session): Promise<WorktreeOffer> {
  if (session.worktree) {
    return { eligible: false, reason: 'it already has one', repoRoot: session.worktree.repoRoot, branch: session.worktree.branch }
  }

  const probe = await run(
    session.environmentId,
    session.cwd,
    'git rev-parse --show-toplevel && git rev-parse --verify HEAD'
  )
  if (!probe.ok) {
    return { eligible: false, reason: 'this folder is not a repository with any commits in it' }
  }
  const [repoRoot] = probe.out.trim().split('\n')
  if (!repoRoot) return { eligible: false, reason: 'this folder is not a repository' }

  return { eligible: true, repoRoot, branch: branchNameFor(session.id, session.title) }
}

export interface WorktreeResult {
  worktree?: WorktreeInfo
  path?: string
  error?: string
}

/**
 * Cuts one, at HEAD.
 *
 * At HEAD and not at the working tree: a worktree is a checkout, and there is
 * no such thing as copying somebody's uncommitted edits into one. Said plainly
 * where the button is, because it is the surprise.
 */
export async function createWorktree(session: Session): Promise<WorktreeResult> {
  const offer = await worktreeOffer(session)
  if (!offer.eligible || !offer.repoRoot || !offer.branch) {
    return { error: offer.reason ?? 'no repository here' }
  }

  const base = await run(session.environmentId, session.cwd, 'git rev-parse HEAD')
  const path = join(await worktreesDir(session.environmentId), session.id)

  const made = await run(
    session.environmentId,
    offer.repoRoot,
    `mkdir -p ${shellQuote(join(path, '..'))} && git worktree add -b ${shellQuote(offer.branch)} ${shellQuote(path)} HEAD`
  )
  if (!made.ok) {
    logLine('info', `worktree ${session.id}: refused (${made.out.slice(0, 160)})`)
    return { error: made.out.split('\n').slice(-2).join(' ').slice(0, 200) || 'git refused' }
  }

  logLine('info', `worktree ${session.id}: ${offer.branch} at ${path}`)
  return {
    path,
    worktree: {
      repoRoot: offer.repoRoot,
      branch: offer.branch,
      base: base.out.trim().slice(0, 40),
      createdAt: Date.now()
    }
  }
}

export async function worktreeStatus(session: Session): Promise<WorktreeStatus | null> {
  if (!session.worktree) return null
  const res = await run(
    session.environmentId,
    session.cwd,
    `git rev-list --count ${shellQuote(session.worktree.base)}..HEAD 2>/dev/null; git status --porcelain=v1 2>/dev/null | wc -l`
  )
  if (!res.ok) return null
  const [ahead, dirty] = res.out.trim().split('\n')
  return { ahead: Number((ahead ?? '').trim()) || 0, dirty: Number((dirty ?? '').trim()) || 0 }
}

/**
 * Puts the conversation back in the repository and takes the checkout away.
 *
 * Anything uncommitted is committed to the branch first. The alternative is
 * `--force`, which throws away work an agent did on somebody's instruction,
 * and that is not a thing to do quietly in a cleanup path. If the commit fails
 * — no identity configured, most likely — the checkout is left exactly where
 * it is and the reason is returned, because a directory somebody has to delete
 * by hand is a much smaller problem than work that is gone.
 */
export async function removeWorktree(session: Session): Promise<WorktreeRemoval> {
  const info = session.worktree
  if (!info) return {}

  const path = join(await worktreesDir(session.environmentId), session.id)
  let committed = false

  const dirty = await run(session.environmentId, path, 'git status --porcelain=v1')
  if (dirty.ok && dirty.out) {
    const subject = `Left over from "${session.title.replace(/\s+/g, ' ').trim().slice(0, 60)}"`
    const saved = await run(
      session.environmentId,
      path,
      `git add -A && git commit --quiet -m ${shellQuote(subject)}`
    )
    if (!saved.ok) {
      logLine('info', `worktree ${session.id}: kept, nothing committed (${saved.out.slice(0, 160)})`)
      return {
        branch: info.branch,
        error: `${path} still has uncommitted changes and they could not be committed, so it was left alone.`
      }
    }
    committed = true
  }

  const gone = await run(
    session.environmentId,
    info.repoRoot,
    `git worktree remove ${shellQuote(path)}; git worktree prune`
  )
  if (!gone.ok) {
    return { branch: info.branch, committed, error: gone.out.slice(0, 200) }
  }

  logLine('info', `worktree ${session.id}: removed, ${info.branch} kept`)
  return { cwd: info.repoRoot, committed, branch: info.branch }
}
