import { writeFileSync } from 'node:fs'
import { transcriptMarkdown } from '@shared/export'
import * as store from './store'

/** Writes a stored conversation to `path` as Markdown. */
export function exportSession(sessionId: string, path: string): void {
  const session = store.getSession(sessionId)
  if (!session) throw new Error(`unknown session ${sessionId}`)
  writeFileSync(path, transcriptMarkdown(session, store.listMessages(sessionId), store.listBlocks(sessionId)), 'utf8')
}
