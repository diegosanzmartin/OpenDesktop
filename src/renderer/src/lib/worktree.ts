import type { Session } from '@shared/types'
import { isInWorkspace } from '@shared/workspace'
import { useStore } from '../state/store'

/**
 * Turning a checkout of one's own on and off, from the three places that offer
 * it: the session menu, the line that says who else is in this file, and the
 * folder chip in the composer.
 *
 * Here rather than in a component because the answer to "did it work" is a
 * toast either way, and three copies of that is three chances to word the
 * failure differently.
 */
export async function giveWorktree(session: Session): Promise<void> {
  const { pushToast } = useStore.getState()
  const made = await window.opendesktop.sessions.worktree.create(session.id)
  if (made.error) {
    pushToast('warn', made.error)
    return
  }
  pushToast(
    'info',
    'This conversation now works on a branch of its own, cut from the last commit. Its dependencies are not installed there.'
  )
}

export async function returnFromWorktree(session: Session): Promise<void> {
  const { pushToast } = useStore.getState()
  const gone = await window.opendesktop.sessions.worktree.remove(session.id)
  if (gone.error) {
    pushToast('warn', gone.error)
    return
  }
  if (gone.branch) {
    pushToast(
      'info',
      `Back in the repository. ${gone.branch} is still there${gone.committed ? ', with what was left uncommitted' : ''}.`
    )
  }
}

/**
 * Whether offering one makes sense at all, without asking git.
 *
 * A conversation's own folder has nobody else in it, and one that already has
 * a checkout is not being offered another. Everything else — no repository, no
 * commit to cut at — is git's answer, and comes back as the reason a toast
 * says it did not work.
 */
export function couldHaveWorktree(session: Session, workspacesRoot: string): boolean {
  return !session.worktree && !isInWorkspace(workspacesRoot, session.cwd)
}
