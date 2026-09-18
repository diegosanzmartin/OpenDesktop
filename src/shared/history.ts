import type { ChangedFile } from './types'

/**
 * What the history looks like to whoever is reading it.
 *
 * Shared because the pane that draws a commit and the code that parses one out
 * of git have to agree about what a commit is, and because a hash, a subject
 * and a list of parents is the same thing on both sides of the bridge.
 */
export interface Commit {
  hash: string
  short: string
  author: string
  at: number
  /** Parent hashes: two of them is a merge, which the graph draws differently. */
  parents: string[]
  subject: string
}

export interface CommitDetail {
  commit: Commit | null
  /** The files it touched, with the same letters the working-tree rows use. */
  files: ChangedFile[]
  /** The whole diff of the commit, which the pane shows per file. */
  diff: string
}

export interface BlameLine {
  hash: string
  short: string
  author: string
  at: number
  line: number
  text: string
}

/**
 * One commit's diff, cut down to one file.
 *
 * `git show` hands over the whole commit, which is the right request — one
 * round trip for a commit rather than one per file in it — and the pane shows
 * a file at a time, so the cutting happens here. A diff is delimited by its
 * own `diff --git` lines, which is what makes this safe to do with a split.
 */
export function onlyFile(diff: string, path: string): string {
  const parts = diff.split(/^diff --git /m).filter(Boolean)
  const mine = parts.find((part) => part.startsWith(`a/${path} `) || part.includes(` b/${path}\n`))
  return mine ? `diff --git ${mine}` : '(no textual diff for this file in this commit)'
}
