/**
 * Taking a turn back.
 *
 * A conversation is two transcripts — the one a person reads and the one the
 * model is sent — and rewinding has to cut both at the same place or the next
 * turn is answered from a memory of something the chat no longer shows. The
 * cut point comes from the mark recorded when the turn started
 * (`history.markTurn`), because nothing else can connect the two: one user
 * message can be followed by a dozen model messages with no boundary in them.
 *
 * What comes back is what was typed, so the composer can be refilled and the
 * message edited and sent again. That is the whole point: not "delete this",
 * but "let me put that differently".
 */
import type { Attachment, Message } from '@shared/types'
import * as history from './history'
import * as store from './store'
import { isRunning } from './agent/runner'

export interface Rewound {
  ok: true
  /** What the message said, to go back into the composer. */
  text: string
  /** What was attached to it, so it can be sent again unchanged. */
  attachments: Attachment[]
  /** Messages taken off the end, for the caller to report. */
  removed: number
}

export interface Refused {
  ok: false
  reason: string
}

/**
 * The user message a rewind should land on.
 *
 * Rewinding an answer means rewinding the question that produced it: the point
 * of the action is to change what was asked. So an assistant or system message
 * resolves backwards to the nearest thing a person typed.
 */
function targetOf(messages: Message[], messageId: string): number {
  const at = messages.findIndex((message) => message.id === messageId)
  if (at === -1) return -1
  for (let index = at; index >= 0; index--) {
    if (messages[index].role === 'user') return index
  }
  return -1
}

export function rewind(sessionId: string, messageId: string): Rewound | Refused {
  // While a turn is in flight there is nothing coherent to cut back to: tools
  // are running, blocks are open, and the model transcript is mid-write.
  if (isRunning(sessionId)) {
    return { ok: false, reason: 'The model is working. Stop it first, then rewind.' }
  }

  const messages = store.listMessages(sessionId)
  const index = targetOf(messages, messageId)
  if (index === -1) return { ok: false, reason: 'Nothing to rewind to.' }

  const target = messages[index]
  const mark = history.markOf(sessionId, target.id)
  if (mark === null) {
    return {
      ok: false,
      reason:
        'This turn has no recorded boundary in the model transcript — it is either older than ' +
        'the last summary, or from before rewind existed. Rewinding it would cut the wrong place.'
    }
  }

  const text = target.parts
    .filter((part) => part.type === 'text')
    .map((part) => part.text ?? '')
    .join('')
  const attachments = target.attachments ?? []

  const removed = store.truncateFrom(sessionId, index)
  history.truncateHistory(sessionId, mark)
  // A rewind undoes the answer too, so a session that ended in error or was
  // handed back to a person is neither of those things any more.
  store.updateSession(sessionId, {
    status: 'idle',
    blockedReason: undefined,
    contextTokens: history.estimateTokens(history.getHistory(sessionId))
  })

  return { ok: true, text, attachments, removed: removed.length }
}

/**
 * A copy of the conversation as it was at that point, leaving this one alone.
 *
 * The other half of rewind: same cut, but on a duplicate, for when the answer
 * you have is worth keeping and you want to try a different question as well.
 */
export function forkFrom(
  sessionId: string,
  messageId: string
): { ok: true; sessionId: string } | Refused {
  const messages = store.listMessages(sessionId)
  const index = messages.findIndex((message) => message.id === messageId)
  if (index === -1) return { ok: false, reason: 'Nothing to fork from.' }

  // Everything up to and including the message forked from: the copy is the
  // conversation as it stood when you read that.
  const keep = index + 1

  const copy = store.forkSession(sessionId)
  if (!copy) return { ok: false, reason: 'The session could not be copied.' }

  if (keep < messages.length) store.truncateFrom(copy.id, keep)
  /*
   * The model transcript of the copy is cut to the *next* turn's mark when
   * there is one, so the fork keeps the answer it was forked from. With no
   * mark to go on the transcript is left whole: a fork carrying one turn too
   * many is a curiosity, one carrying a transcript cut in the wrong place is a
   * 400 from the provider.
   */
  const next = messages
    .slice(keep)
    .map((message) => history.markOf(sessionId, message.id))
    .find((at): at is number => at !== null)
  if (next !== undefined) history.truncateHistory(copy.id, next)

  return { ok: true, sessionId: copy.id }
}
