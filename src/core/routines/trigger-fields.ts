/**
 * Field rules a trigger's create and its in-place update share (trigger_create,
 * trigger_update). Pure and free of node imports: the ops layer reads it in any
 * process.
 */

/**
 * The longest `description` a trigger takes. It is shown in full on the
 * Routines card and clamped to three lines in the task's trigger flyout, so it is
 * meant to be one or two sentences, not the script explained line by line.
 */
export const TRIGGER_DESCRIPTION_MAX = 600;

/**
 * `every` accepts a number of ms or a short duration ("30s", "5m", "1h"): an
 * agent writes the second, a form posts the first.
 */
export function parseEveryMs(raw: unknown): number | null {
  if (typeof raw === 'number' && Number.isFinite(raw)) return Math.floor(raw);
  const text = typeof raw === 'string' ? raw.trim().toLowerCase() : '';
  if (!text) return null;
  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/.exec(text);
  if (!match) return null;
  const n = Number(match[1]);
  if (!Number.isFinite(n)) return null;
  const unit = match[2] ?? 'ms';
  const factor = unit === 'ms' ? 1 : unit === 's' ? 1_000 : unit === 'm' ? 60_000 : unit === 'h' ? 3_600_000 : 86_400_000;
  return Math.floor(n * factor);
}
