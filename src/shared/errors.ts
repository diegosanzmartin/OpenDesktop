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
 * Values this process resolved from a keychain, a file or the environment, so
 * they can be recognised wherever they turn up.
 *
 * The shapes below catch a key that looks like a key. This catches the app's
 * own keys whatever they look like, which matters because a command's output is
 * not a place they can be predicted: `env`, `curl -v`, a framework printing its
 * config, a stack trace quoting a header. Values only, never their names — the
 * name is what makes the redaction readable.
 */
const known = new Set<string>()
const MIN_SECRET = 8

export function rememberSecret(value: string): void {
  if (typeof value === 'string' && value.trim().length >= MIN_SECRET) known.add(value.trim())
}

/** For the tests, and for a config reload: what was true is not necessarily still. */
export function forgetSecrets(): void {
  known.clear()
}

export function secretCount(): number {
  return known.size
}

/** The values themselves, for the one caller that has to compare rather than redact. */
export function knownSecretValues(): string[] {
  return [...known]
}

function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Redacts anything shaped like a key, and anything known to be one.
 *
 * A provider's error body can quote the request that caused it, and a shell
 * command will happily print the whole environment; this text goes to a log
 * file, a transcript, a window and the model. The app's whole arrangement with
 * secrets is that they stay in the keychain and never reach the renderer;
 * neither an error message nor a tool result is an exception to that.
 */
export function scrubSecrets(text: string): string {
  let out = text
  for (const secret of known) {
    if (!out.includes(secret)) continue
    out = out.replace(new RegExp(escapeForRegExp(secret), 'g'), '•••')
  }
  return out
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
