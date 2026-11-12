/**
 * The reasoning-effort registry, on its own with no imports: the history parser
 * reads it at run time, and every runtime import of the parser is part of its
 * version (scripts/history-parser-version.mjs), so it must not pull in types.ts.
 */

// ── Reasoning effort (maps to the `claude -p --effort <level>` CLI flag) ──
// The CLI accepts low/medium/high/xhigh/max (verified against binary 2.1.170:
// EFFORT_LEVELS = ['low','medium','high','xhigh','max']). When no --effort is
// passed the API resolves to 'high'. `xhigh` and `max` are honored only by a
// subset of models (see MODEL_EFFORT_FAMILY_DEFAULTS); the CLI silently
// downgrades an unsupported level to 'high', so we grey them out in the picker
// to keep the UI honest.
export type SessionEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export interface SessionEffortEntry {
  /** Picker / CLI value. */
  id: SessionEffort;
  /** Display label. */
  label: string;
  /** Dropdown / tooltip description. */
  description: string;
}
export const SESSION_EFFORTS: readonly SessionEffortEntry[] = [
  { id: 'low',    label: 'Low',    description: 'Quick, minimal reasoning' },
  { id: 'medium', label: 'Medium', description: 'Balanced speed & depth' },
  { id: 'high',   label: 'High',   description: 'Deep reasoning (API default)' },
  { id: 'xhigh',  label: 'X-High', description: 'Extended exploration (select models only)' },
  { id: 'max',    label: 'Max',    description: 'Deepest reasoning, no limit (select models only)' },
] as const;
/** Ordered effort ids — also the CLI-accepted values. */
export const SESSION_EFFORT_IDS: readonly SessionEffort[] = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
/** Set of valid effort ids — runtime allowlist validation. */
export const VALID_SESSION_EFFORT_IDS: ReadonlySet<string> = new Set(SESSION_EFFORT_IDS);
/** Effort level the API falls back to when no --effort flag is sent. */
export const DEFAULT_SESSION_EFFORT: SessionEffort = 'high';
