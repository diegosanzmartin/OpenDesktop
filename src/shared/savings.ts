/**
 * What a session does to keep its context and its bill down.
 *
 * These were three modes — direct, rtk, shunt — and that was wrong, because
 * they are not alternatives. One filters the output of shell commands; the
 * other moves file reading onto a different model. Nothing about either makes
 * the other less useful, and a mode picker forced a choice that does not exist.
 *
 * So they are switches. Everything off is the app as it always was, and there
 * is no name for that state beyond "nothing on" — `Direct` is what the label
 * says, not a mode you select.
 *
 * - `rtk`   — rtk-ai/rtk. Commands go through `rtk`, which filters their output
 *             before anyone reads it.
 * - `shunt` — spotify/portal-ai-plugins/plugins/shunt. Large reads, boilerplate
 *             and planning are handed to another model chosen for the job, so
 *             the files never enter this conversation at all.
 *
 * The defaults live in the config; a session may override either one. An
 * absent key on a session means "whatever the app says", which is not the same
 * as `false` — that distinction is why this is `Partial<Savings>` on a session
 * and a whole `Savings` everywhere else.
 */
import type { AppConfig, Session } from './types'

export interface Savings {
  rtk: boolean
  shunt: boolean
}

export const NOTHING: Savings = { rtk: false, shunt: false }

/** What each switch is, for the settings page and the session menu. */
export const SWITCHES: { id: keyof Savings; label: string; blurb: string; requires?: string }[] = [
  {
    id: 'rtk',
    label: 'Filter command output',
    blurb: 'Commands run through rtk, which cuts their output before you read it.',
    requires: 'the rtk binary on the execution target'
  },
  {
    id: 'shunt',
    label: 'Delegate reading and planning',
    blurb:
      'Large files go to a cheaper model and only its answer comes back; a hard plan goes to a stronger one.'
  }
]

/** What the app used to store instead of two switches. Still read, never written. */
export type LegacyMode = 'direct' | 'rtk' | 'shunt'

function fromLegacy(mode: unknown): Partial<Savings> {
  if (mode === 'rtk') return { rtk: true }
  if (mode === 'shunt') return { shunt: true }
  if (mode === 'direct') return { rtk: false, shunt: false }
  return {}
}

/**
 * The switches in force for a session: its own choices over the app's, and the
 * single-mode setting either of them used to be, for anything already on disk.
 */
export function savingsOf(config: AppConfig | null | undefined, session?: Session | null): Savings {
  const app = { ...NOTHING, ...fromLegacy(config?.mode), ...(config?.savings ?? {}) }
  const own = { ...fromLegacy(session?.mode), ...(session?.savings ?? {}) }
  return { ...app, ...own }
}

/** True when this session decided for itself rather than following the app. */
export function overridesApp(config: AppConfig | null | undefined, session: Session): boolean {
  const app = savingsOf(config)
  const mine = savingsOf(config, session)
  return app.rtk !== mine.rtk || app.shunt !== mine.shunt
}

/** The one word the composer shows. Everything off is Direct. */
export function savingsLabel(savings: Savings): string {
  const on = (['rtk', 'shunt'] as const).filter((key) => savings[key])
  return on.length === 0 ? 'Direct' : on.join(' + ')
}
