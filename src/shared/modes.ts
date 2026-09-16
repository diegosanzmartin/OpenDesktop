/**
 * How much of what a tool produces reaches the model.
 *
 * Every mode runs the same agent with the same tools against the same
 * environment; what changes is the size of what comes back. `direct` is the
 * app as it has always worked. The other two are ports of two existing
 * projects, kept under their own names because that is what someone searching
 * for them will type:
 *
 * - `rtk`   — rtk-ai/rtk. Commands go through `rtk`, which filters their output
 *             before anyone reads it.
 * - `shunt` — spotify/portal-ai-plugins/plugins/shunt. Large reads and
 *             boilerplate are handed to a cheaper model, so the files never
 *             enter this conversation at all.
 *
 * A mode is a property of a session, not of the app: a chat that is reading
 * code wants a different trade than one that is editing it.
 */
export type SessionMode = 'direct' | 'rtk' | 'shunt'

export const DEFAULT_MODE: SessionMode = 'direct'

export interface ModeInfo {
  id: SessionMode
  label: string
  /** One line, shown beside the picker. */
  blurb: string
  /** What it needs to work at all, named in the UI when it is missing. */
  requires?: string
}

export const MODES: ModeInfo[] = [
  {
    id: 'direct',
    label: 'Direct',
    blurb: 'Tool output reaches the model as it is.'
  },
  {
    id: 'rtk',
    label: 'rtk',
    blurb: 'Commands run through rtk, which filters their output first.',
    requires: 'the rtk binary on the execution target'
  },
  {
    id: 'shunt',
    label: 'shunt',
    blurb: 'Large reads and boilerplate go to a cheaper model.',
    requires: 'a second model to delegate to'
  }
]

export function isSessionMode(value: unknown): value is SessionMode {
  return value === 'direct' || value === 'rtk' || value === 'shunt'
}

export function modeInfo(mode: SessionMode | undefined): ModeInfo {
  return MODES.find((entry) => entry.id === mode) ?? MODES[0]
}

export function modeLabel(mode: SessionMode | undefined): string {
  return modeInfo(mode).label
}
