/**
 * Whether a path is inside a conversation's own folder.
 *
 * One definition, because two sides ask for different reasons and must agree:
 * the main process builds these paths and deletes them, and the transcript
 * decides from them whether a file is something to open or something to diff.
 *
 * Against the real root rather than a substring of it. The first version
 * looked for `.opendesktop/workspaces/` anywhere in the path, which is wrong
 * the moment the app's root is overridden — every install with
 * `OPENDESKTOP_HOME` set had the feature quietly switched off, including the
 * test that was meant to prove it worked.
 */
export function isInWorkspace(root: string | undefined, path: string | undefined): boolean {
  if (!root || !path) return false
  return path === root || path.startsWith(root.endsWith('/') ? root : `${root}/`)
}
