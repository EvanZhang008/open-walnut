/**
 * `plugins.walnut-rhythm` as Rhythm reads it. PURE.
 *
 * The manifest's configSchema carries the same defaults and ranges for the Settings
 * form, but a value typed into config.yaml by hand never passed through that form, so
 * every number is clamped here too. A value out of range is pulled to the nearest
 * bound rather than rejected: a reminder that fires every 240 minutes is closer to
 * what someone who typed 500 wanted than no reminder at all.
 */

export interface RhythmConfig {
  reminderEveryMinutes: number
  awayResetMinutes: number
  snoozeMinutes: number
  /** The break a stand-up starts (Start break / Stand up now), counted down in the ring. */
  standBreakMinutes: number
  /** Raw `HH:MM-HH:MM`; '' disables. Parsed by clock.ts. */
  quietHours: string
  deferForNaturalPauseMinutes: number
  focusMinutes: number
  breakMinutes: number
  longBreakMinutes: number
  longBreakEvery: number
  focusQuietsWalnut: boolean
  mirrorMacosFocus: boolean
  macosFocusShortcuts: boolean
}

interface IntField { key: string; field: keyof RhythmConfig; def: number; min: number; max: number }

const INT_FIELDS: IntField[] = [
  { key: 'reminder_every_minutes', field: 'reminderEveryMinutes', def: 60, min: 15, max: 240 },
  { key: 'away_reset_minutes', field: 'awayResetMinutes', def: 5, min: 2, max: 60 },
  { key: 'snooze_minutes', field: 'snoozeMinutes', def: 10, min: 1, max: 120 },
  { key: 'stand_break_minutes', field: 'standBreakMinutes', def: 10, min: 1, max: 60 },
  { key: 'defer_for_natural_pause_minutes', field: 'deferForNaturalPauseMinutes', def: 5, min: 0, max: 30 },
  { key: 'focus_minutes', field: 'focusMinutes', def: 25, min: 5, max: 180 },
  { key: 'break_minutes', field: 'breakMinutes', def: 5, min: 1, max: 60 },
  { key: 'long_break_minutes', field: 'longBreakMinutes', def: 15, min: 1, max: 120 },
  { key: 'long_break_every', field: 'longBreakEvery', def: 4, min: 1, max: 12 },
]

const BOOL_FIELDS: Array<{ key: string; field: keyof RhythmConfig; def: boolean }> = [
  { key: 'focus_quiets_walnut', field: 'focusQuietsWalnut', def: true },
  { key: 'mirror_macos_focus', field: 'mirrorMacosFocus', def: true },
  { key: 'macos_focus_shortcuts', field: 'macosFocusShortcuts', def: false },
]

export const DEFAULT_QUIET_HOURS = '22:00-08:00'

export function normalizeConfig(raw: unknown): RhythmConfig {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  for (const spec of INT_FIELDS) out[spec.field] = clampInt(source[spec.key], spec.def, spec.min, spec.max)
  for (const spec of BOOL_FIELDS) out[spec.field] = typeof source[spec.key] === 'boolean' ? source[spec.key] : spec.def
  const quiet = source.quiet_hours
  // Present-but-empty is meaningful (the user turned quiet hours off); absent means the default.
  out.quietHours = typeof quiet === 'string' ? quiet.trim() : DEFAULT_QUIET_HOURS
  return out as unknown as RhythmConfig
}

function clampInt(value: unknown, def: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(number)) return def
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Clamp a minutes argument an op received (focus length, snooze length). */
export function clampMinutes(value: unknown, def: number, min: number, max: number): number {
  return clampInt(value, def, min, max)
}
