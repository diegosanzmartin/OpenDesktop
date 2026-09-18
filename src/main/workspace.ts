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
import { join } from 'node:path'
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
 * Makes the folder if it is not there, and a repository inside it once.
 *
 * Lazily, at the first turn rather than when the session is created: most
 * conversations never write anything, and a directory per chat that was only
 * ever a question is litter.
 */
export async function ensureWorkspace(sessionId: string, path: string): Promise<void> {
  if (!isWorkspace(path)) return
  if (!existsSync(path)) mkdirSync(path, { recursive: true })
  if (existsSync(join(path, '.git'))) return

  const init = await git(['init', '--quiet', '--initial-branch=main'], path)
  if (!init.ok) {
    // No git on this machine, or it refused. The folder still works; only the
    // history is lost, and that is not worth failing a turn over.
    logLine('info', `workspace ${sessionId}: no history (${init.out.slice(0, 120)})`)
    return
  }
  await git(['config', 'user.name', 'OpenDesktop'], path)
  await git(['config', 'user.email', 'opendesktop@localhost'], path)
}

/**
 * Commits what the turn changed, if anything.
 *
 * Per turn rather than per write: a turn is the unit somebody asked for, and
 * committing each edit separately turns the log of a five-edit turn into five
 * entries nobody wrote a message for. The subject is what was asked, which is
 * the only description of the change that exists.
 */
export async function commitWorkspace(sessionId: string, path: string, asked: string): Promise<boolean> {
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
