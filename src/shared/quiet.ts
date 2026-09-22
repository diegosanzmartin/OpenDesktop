/**
 * What to do about a turn that has gone quiet.
 *
 * Separated from the runner because it is the whole argument, and an argument
 * is worth being able to read and to test. The runner owns the timers; this
 * owns the rule.
 *
 * The rule replaced a wall clock. A limit on how long a turn may take measures
 * the wrong thing: nearly all of a long turn's time is spent inside tools — a
 * test suite, a package install, a two-gigabyte download — and none of that is
 * a runaway. What a runaway consumes is steps and money, and those have
 * ceilings of their own. The one condition that means *broken* rather than
 * *slow* is nothing arriving at all.
 */

/** Warn this often while a turn is quiet, before any decision to stop. */
export const QUIET_WARN_MS = 90_000

/** Off means never stop for silence; the runner passes the configured value. */
export const DEFAULT_QUIET_CEILING_MS = 600_000

export type QuietVerdict =
  /** A tool is running, or an approval is in front of the user. Leave it. */
  | 'working'
  /** Quiet, but not long enough to act on, and nobody has been told yet. */
  | 'warn'
  /** Quiet, already said so once. Keep waiting without saying it again. */
  | 'wait'
  /** Quiet past the ceiling with nothing to wait for. End the turn. */
  | 'stop'

export function quietVerdict(input: {
  /** How long since this turn last showed any sign of life. */
  quietForMs: number
  /** Tools in flight, which includes one waiting to be approved. */
  toolsRunning: number
  /** `maxQuietMs`, or 0 for no ceiling. */
  ceilingMs: number
  /** Whether the warning has already gone out for this stretch of silence. */
  warned: boolean
}): QuietVerdict {
  /*
   * A running tool outranks the ceiling, and it has to. `pnpm smoke` takes
   * minutes and says nothing to the stream the whole time; an approval card
   * can sit there all afternoon. Killing either is killing the work — and in
   * the approval case, killing it precisely because it was waiting for the
   * person who is about to answer.
   */
  if (input.toolsRunning > 0) return 'working'
  if (input.ceilingMs > 0 && input.quietForMs >= input.ceilingMs) return 'stop'
  return input.warned ? 'wait' : 'warn'
}
