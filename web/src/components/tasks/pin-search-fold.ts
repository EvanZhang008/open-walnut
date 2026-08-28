/**
 * Stale-done-pin folding for SEARCH mode.
 *
 * Completed tasks keep their pin membership (2026-08-26: completion no longer
 * unpins) and the tiers display done pins during search so a query match in
 * Focus/Satellite stays findable. In practice the client asks the server for
 * 80 loose semantic matches, so on a broad query nearly every pin "matches"
 * and the first screen becomes a wall of struck-through history.
 *
 * Policy (2026-08-28): during search the tiers directly show a done pin only
 * while its completion is FRESH (≤30 days); older ones fold into a one-line
 * count with an expand toggle. They remain fully findable — the ranked task
 * list below still carries them (now liveness-ranked server-side).
 */

interface DoneDatedTask {
  id: string;
  status?: string;
  phase?: string;
  completed_at?: string;
  updated_at?: string;
}

export const STALE_DONE_PIN_DAYS = 30;
const DAY_MS = 86_400_000;

export function isStaleDonePin(task: DoneDatedTask, now: number = Date.now()): boolean {
  const done = task.phase === 'COMPLETE' || task.status === 'done';
  if (!done) return false;
  const stamp = Date.parse(task.completed_at ?? task.updated_at ?? '');
  // No parseable date → treat as stale: an undated done task is old history,
  // not something completed moments ago.
  if (Number.isNaN(stamp)) return true;
  return now - stamp > STALE_DONE_PIN_DAYS * DAY_MS;
}

/** Ids of pinned tasks whose done-ness is old enough to fold during search. */
export function staleDonePinIds(tasks: readonly DoneDatedTask[], now: number = Date.now()): Set<string> {
  const ids = new Set<string>();
  for (const task of tasks) {
    if (isStaleDonePin(task, now)) ids.add(task.id);
  }
  return ids;
}
