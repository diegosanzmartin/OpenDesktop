/**
 * A folder of its own for a conversation that is not about a repository.
 *
 * Plenty of what this app gets asked is not "change this code": it is a
 * question, an investigation, a report. Those still write files — an export, a
 * summary, a PDF — and until now they wrote them into the home directory,
 * because that is what the local environment's working directory defaults to.
 * A `.mobileconfig` in `~`, then another, then a `report.md`, and no way to
 * tell which conversation left which.
 *
 * So a session with no folder chosen gets one: `~/.opendesktop/workspaces/<id>`,
 * made when it first needs it, tracked in git so the fifth draft of a report
 * can be compared with the first, and deleted with the conversation.
 *
 * One repository per conversation, deliberately, rather than one shared by all
 * of them. A shared repository is the collision problem again with a lock file
 * in the middle: two sessions committing at once is `index.lock` contention and
 * a history nobody can read, and it would make "delete the conversation and
 * its files" a surgical operation instead of removing a directory.
 */
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { isInWorkspace } from '@shared/workspace'
import { logLine } from './log'

const ROOT = process.env.OPENDESKTOP_HOME

/** Beside the models and the runtime, under the app's own directory. */
export const WORKSPACES_DIR = ROOT
  ? join(ROOT, 'local', 'workspaces')
  : join(homedir(), '.opendesktop', 'workspaces')

export function workspacePath(sessionId: string): string {
  return join(WORKSPACES_DIR, sessionId)
}

/**
 * Makes the directory, now, when the conversation is created.
 *
 * The repository still waits for the first turn — a `.git` per chat that was
 * only ever a question is litter — but the *directory* cannot wait, because
 * the interface reads it long before any turn: the Files pane listed it on the
 * way in and got `ENOENT: scandir` thrown at the user. A directory is one
 * inode and it goes when the conversation does.
 */
export function makeWorkspaceDir(sessionId: string): string {
  const path = workspacePath(sessionId)
  mkdirSync(path, { recursive: true })
  return path
}

/**
 * A path is a workspace because of where it is, so nothing has to be stored
 * alongside the session to remember it.
 */
export function isWorkspace(path: string | undefined): boolean {
  return isInWorkspace(WORKSPACES_DIR, path)
}

/** The one belonging to this session, rather than any workspace at all. */
export function isOwnWorkspace(sessionId: string, path: string | undefined): boolean {
  return Boolean(path && path === workspacePath(sessionId))
}

function git(args: string[], cwd: string): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: 15_000, maxBuffer: 2_000_000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() })
    })
  })
}

/**
 * Whether this directory, or anything above it, is already a repository.
 *
 * Walked by hand rather than asked of `git rev-parse`, because the answer has
 * to be "no" for a directory that is not in a repository *and* for one that
 * does not exist yet, and rev-parse cannot be run in a directory that is not
 * there.
 */
export function repositoryAbove(path: string): string | null {
  let at = path
  for (;;) {
    if (existsSync(join(at, '.git'))) return at
    const up = dirname(at)
    if (up === at) return null
    at = up
  }
}

/**
 * Directories a repository must never be created in.
 *
 * A `git init` in the home directory is a repository that tracks everything
 * somebody owns, and the first `git add -A` after it is a mistake that takes a
 * while to undo. The same goes for a filesystem root and for the parents of a
 * home directory, none of which anybody means by "my project folder".
 */
export function tooBigToTrack(path: string): boolean {
  const home = homedir()
  if (path === '/' || dirname(path) === path) return true
  if (path === home) return true
  // A parent of the home directory: /Users, /home, / and so on.
  return home.startsWith(`${path}/`)
}

export interface HistoryOutcome {
  /** True when this call created the repository. */
  created: boolean
  /** Why not, when it did not and that is worth saying. */
  skipped?: string
}

/**
 * Makes sure the session's folder has a history, whatever folder it is.
 *
 * Two cases, one rule. A conversation's own folder is made here and made a
 * repository, lazily at the first turn rather than when the session was
 * created: most conversations never write anything, and a directory per chat
 * that was only ever a question is litter.
 *
 * A folder somebody chose is left alone unless it is in no repository at all —
 * then it gets one, so the Changes pane always has something to read and
 * yesterday's version of a file still exists. Never when a repository is
 * already above it: a `.git` inside a checkout is a second repository nobody
 * asked for, tracking files the outer one already tracks.
 */
export async function ensureHistory(sessionId: string, path: string): Promise<HistoryOutcome> {
  const own = isWorkspace(path)
  if (own && !existsSync(path)) mkdirSync(path, { recursive: true })
  if (!existsSync(path)) return { created: false, skipped: 'the folder is not there' }

  const above = repositoryAbove(path)
  if (above) return { created: false, skipped: above === path ? 'already a repository' : `inside ${above}` }
  if (!own && tooBigToTrack(path)) {
    logLine('info', `history ${sessionId}: ${path} is too broad to put a repository in`)
    return { created: false, skipped: 'too broad to track' }
  }

  const init = await git(['init', '--quiet', '--initial-branch=main'], path)
  if (!init.ok) {
    // No git on this machine, or it refused. The folder still works; only the
    // history is lost, and that is not worth failing a turn over.
    logLine('info', `history ${sessionId}: none (${init.out.slice(0, 120)})`)
    return { created: false, skipped: init.out.slice(0, 120) || 'git refused' }
  }
  if (own) {
    // A conversation's own repository commits as the app, since nobody else
    // is going to. A folder somebody chose keeps their identity.
    await git(['config', 'user.name', 'OpenDesktop'], path)
    await git(['config', 'user.email', 'opendesktop@localhost'], path)
  }
  logLine('info', `history ${sessionId}: started a repository in ${path}`)
  return { created: true }
}

/** The old name, kept for the one caller that only ever means its own folder. */
export const ensureWorkspace = ensureHistory

/**
 * Commits what the turn changed, if anything.
 *
 * Per turn rather than per write: a turn is the unit somebody asked for, and
 * committing each edit separately turns the log of a five-edit turn into five
 * entries nobody wrote a message for. The subject is what was asked, which is
 * the only description of the change that exists.
 */
export async function commitWorkspace(sessionId: string, path: string, asked: string): Promise<boolean> {
  /*
   * Only its own folder. A repository somebody chose is theirs: committing
   * into it on their behalf would put this app's idea of a unit of work into
   * a history they write themselves, and nobody asked for that.
   */
  if (!isWorkspace(path) || !existsSync(join(path, '.git'))) return false

  const status = await git(['status', '--porcelain'], path)
  if (!status.ok || !status.out) return false

  const subject = asked.replace(/\s+/g, ' ').trim().slice(0, 72) || 'Changes in this conversation'
  await git(['add', '-A'], path)
  const done = await git(['commit', '--quiet', '-m', subject], path)
  if (!done.ok) logLine('info', `workspace ${sessionId}: nothing committed (${done.out.slice(0, 120)})`)
  return done.ok
}

export interface WorkspaceSummary {
  path: string
  files: number
  bytes: number
}

/** What deleting the conversation would take with it. */
export function summariseWorkspace(sessionId: string): WorkspaceSummary | null {
  const path = workspacePath(sessionId)
  if (!existsSync(path)) return null
  let files = 0
  let bytes = 0
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === '.git') continue
      const full = join(dir, name)
      try {
        const stat = statSync(full)
        if (stat.isDirectory()) walk(full)
        else {
          files++
          bytes += stat.size
        }
      } catch {
        /* vanished mid-walk */
      }
    }
  }
  walk(path)
  return { path, files, bytes }
}

/**
 * Removes it, with the conversation.
 *
 * Only ever the one named after this session: a session pointed at somebody's
 * repository has a path that is not in here, and deleting a chat must never be
 * a way to lose work that was not made by it.
 */
export function removeWorkspace(sessionId: string): void {
  const path = workspacePath(sessionId)
  if (!isWorkspace(path) || !existsSync(path)) return
  rmSync(path, { recursive: true, force: true })
  logLine('info', `workspace ${sessionId}: removed with the conversation`)
}
