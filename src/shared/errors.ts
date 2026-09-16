/**
 * Saying what actually went wrong.
 *
 * This exists because of a real half-hour: two parallel agents died in the same
 * second and all anyone could see, in the chat and in a toast, was
 *
 *     Failed to process successful response
 *
 * which is the AI SDK's wrapper for "the HTTP call succeeded and then something
 * went wrong reading it". The something is on `error.cause`, and we were
 * throwing it away — so the one piece of information that mattered was the one
 * piece nobody had. The fix is not cleverness, it is following the chain.
 *
 * Provider errors also carry a status code, a URL and sometimes the response
 * body, all of which say more than the message does. They are included, with
 * two rules: nothing that could be a credential survives, and the whole thing
 * stays short enough to read in a toast.
 */

const MAX_LENGTH = 700
const MAX_DEPTH = 6
const MAX_BODY = 240

/**
 * Redacts anything shaped like a key.
 *
 * A provider's error body can quote the request that caused it, and this text
 * goes to a log file, a transcript and a window. The app's whole arrangement
 * with secrets is that they stay in the keychain and never reach the renderer;
 * an error message is not an exception to that.
 */
export function scrubSecrets(text: string): string {
  return text
    .replace(/\b(sk|pk|key|tok|ghp|gho|xoxb|xoxp)[-_][A-Za-z0-9_-]{8,}/gi, '$1-•••')
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer •••')
    .replace(/("?(?:api[-_]?key|authorization|password|passphrase|token)"?\s*[:=]\s*"?)([^"\s,}]{6,})/gi,
      '$1•••'
    )
}

interface ProviderShape {
  message?: unknown
  statusCode?: unknown
  url?: unknown
  responseBody?: unknown
  cause?: unknown
  name?: unknown
}

/** The URL without its query string: a path says where, a query can say who. */
function safeUrl(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null
  try {
    const parsed = new URL(value)
    return `${parsed.origin}${parsed.pathname}`
  } catch {
    return value.split('?')[0]
  }
}

/**
 * One line naming the failure and everything under it.
 *
 * `outer ← inner ← innermost`, because the useful one is usually the last: the
 * wrapper says an HTTP response could not be processed, and the cause says the
 * body was empty.
 */
export function describeError(error: unknown): string {
  const parts: string[] = []
  const seen = new Set<unknown>()
  let current: unknown = error

  for (let depth = 0; depth < MAX_DEPTH && current && !seen.has(current); depth++) {
    seen.add(current)
    const shaped = current as ProviderShape

    const message =
      typeof shaped.message === 'string' && shaped.message.trim()
        ? shaped.message.trim()
        : typeof current === 'string'
          ? current
          : ''

    const detail: string[] = []
    if (typeof shaped.statusCode === 'number') detail.push(`HTTP ${shaped.statusCode}`)
    const url = safeUrl(shaped.url)
    if (url) detail.push(url)
    if (typeof shaped.responseBody === 'string' && shaped.responseBody.trim()) {
      const body = shaped.responseBody.trim().replace(/\s+/g, ' ')
      detail.push(`body: ${body.length > MAX_BODY ? `${body.slice(0, MAX_BODY)}…` : body}`)
    }

    const line = [message, detail.length > 0 ? `(${detail.join(', ')})` : '']
      .filter(Boolean)
      .join(' ')
    // A cause whose message repeats its parent's adds nothing but noise.
    if (line && parts[parts.length - 1] !== line) parts.push(line)

    current = shaped.cause
  }

  if (parts.length === 0) return scrubSecrets(String(error ?? 'unknown error'))
  const joined = scrubSecrets(parts.join(' ← '))
  return joined.length > MAX_LENGTH ? `${joined.slice(0, MAX_LENGTH)}…` : joined
}

/** Whether this was the user pressing Stop rather than something breaking. */
export function isAbort(error: unknown, signalled: boolean): boolean {
  if (signalled) return true
  const name = (error as { name?: unknown })?.name
  if (name === 'AbortError' || name === 'TimeoutError') return true
  return /\babort(ed)?\b/i.test(describeError(error))
}
