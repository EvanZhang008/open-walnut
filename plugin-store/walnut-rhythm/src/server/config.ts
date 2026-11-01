/**
 * `plugins.walnut-rhythm` as Rhythm reads it. PURE.
 *
 * The manifest's configSchema carries the same defaults and ranges for the Settings
 * form, but a value typed into config.yaml by hand never passed through that form, so
 * every number is clamped here too. A value out of range is pulled to the nearest
 * bound rather than rejected: a 180 minute block is closer to what someone who typed
 * 500 wanted than no block at all.
 *
 * Keys an older Rhythm read (the stand-up reminder's interval, snooze, quiet hours) may
 * still be in config.yaml; they are ignored.
 */

export interface RhythmConfig {
  focusMinutes: number
  breakMinutes: number
  longBreakMinutes: number
  longBreakEvery: number
  focusQuietsWalnut: boolean
  mirrorMacosFocus: boolean
  macosFocusShortcuts: boolean
  /** Raw folder path for focus music; '' means the plugin's own `focus-music` folder. */
  musicFolder: string
  /** Starting a focus block from a Start button also starts the music on that device. */
  musicWithFocus: boolean
}

interface IntField { key: string; field: keyof RhythmConfig; def: number; min: number; max: number }

/** What a Start form offers, and what the settings keep. */
export const FOCUS_RANGE = { min: 5, max: 180 }
export const BREAK_RANGE = { min: 1, max: 60 }

const INT_FIELDS: IntField[] = [
  { key: 'focus_minutes', field: 'focusMinutes', def: 25, ...FOCUS_RANGE },
  { key: 'break_minutes', field: 'breakMinutes', def: 5, ...BREAK_RANGE },
  { key: 'long_break_minutes', field: 'longBreakMinutes', def: 15, min: 1, max: 120 },
  { key: 'long_break_every', field: 'longBreakEvery', def: 4, min: 1, max: 12 },
]

const BOOL_FIELDS: Array<{ key: string; field: keyof RhythmConfig; def: boolean }> = [
  { key: 'focus_quiets_walnut', field: 'focusQuietsWalnut', def: true },
  { key: 'mirror_macos_focus', field: 'mirrorMacosFocus', def: true },
  { key: 'macos_focus_shortcuts', field: 'macosFocusShortcuts', def: false },
  { key: 'music_with_focus', field: 'musicWithFocus', def: true },
]

export function normalizeConfig(raw: unknown): RhythmConfig {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw as Record<string, unknown> : {}
  const out: Record<string, unknown> = {}
  for (const spec of INT_FIELDS) out[spec.field] = clampInt(source[spec.key], spec.def, spec.min, spec.max)
  for (const spec of BOOL_FIELDS) out[spec.field] = typeof source[spec.key] === 'boolean' ? source[spec.key] : spec.def
  out.musicFolder = typeof source.music_folder === 'string' ? source.music_folder.trim() : ''
  return out as unknown as RhythmConfig
}

function clampInt(value: unknown, def: number, min: number, max: number): number {
  const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN
  if (!Number.isFinite(number)) return def
  return Math.min(max, Math.max(min, Math.round(number)))
}

/** Clamp a minutes argument an op received (the focus length). */
export function clampMinutes(value: unknown, def: number, min: number, max: number): number {
  return clampInt(value, def, min, max)
}
