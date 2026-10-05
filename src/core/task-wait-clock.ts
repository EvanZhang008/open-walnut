/**
 * Reading the clock a caller puts on a park (`wait_until` on task_update and
 * trigger_create): an ISO datetime, or a duration from now.
 *
 * A park sends no letter. The 2026-10-04 receipt (one inbox letter per park a
 * session made) was removed on 2026-10-05: every re-park after a trigger fire
 * wrote another one, so the user's inbox filled with "Waiting:" notices that
 * asked nothing of them. The task's Waiting state and the session's own last
 * message already say where the work went.
 */

const UNIT_MS: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/**
 * A wait clock from a caller: an ISO datetime, or a duration from now ("90m",
 * "6h", "3d"). `""` = no clock. `undefined` = the caller named none (the store
 * then applies the default). Throws on anything else, and on a time not in the
 * future, so a bad clock is refused before anything is written.
 */
export function parseWaitUntil(raw: unknown, nowMs: number = Date.now()): string | '' | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'string' && typeof raw !== 'number') {
    throw new Error('wait_until must be an ISO datetime or a duration like "6h" / "3d"');
  }
  const text = typeof raw === 'string' ? raw.trim() : String(raw);
  if (text === '') return '';
  // A bare number (ms) or a number with a unit is a duration; anything else must be a date.
  const duration = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d)?$/i.exec(text);
  const atMs = duration
    ? nowMs + Math.floor(Number(duration[1]) * UNIT_MS[(duration[2] ?? 'ms').toLowerCase()])
    : Date.parse(text);
  if (!Number.isFinite(atMs)) {
    throw new Error(`wait_until "${text}" is neither an ISO datetime nor a duration like "6h" / "3d"`);
  }
  if (atMs <= nowMs) {
    throw new Error(`wait_until "${text}" is not in the future`);
  }
  return new Date(atMs).toISOString();
}
