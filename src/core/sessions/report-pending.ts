/**
 * Sessions whose turn-end self-report is still to come: its quiet timer is armed or the ask is
 * out (session-hooks/builtins.ts sets it). While it is, the task's status does not say "its turn
 * handed it back to you" (user-status.ts): the report is what says whether the turn left the user
 * anything to do (2026-10-27: a turn that only confirmed the plan after the user's answer read
 * Needs you everywhere for the four minutes until its report, and for good once the report said
 * done). The status sync (user-status-sync.ts) re-derives the task when this moves.
 */

/** Session id -> when its report became pending. */
const pending = new Map<string, number>();
let listener: ((sessionId: string) => void) | null = null;

/**
 * The longest a report counts as on its way: past the default quiet window (4 minutes) and a
 * normal ask, a report that has not come is not waited for, so a turn that asked the user
 * something in words reads Needs you again (the status sync's minute sweep re-derives it).
 */
export const REPORT_PENDING_MAX_MS = 6 * 60_000;

/** On: from now (a new turn end re-arms it, so the clock restarts); off: gone. */
export function setReportPending(sessionId: string, on: boolean, nowMs = Date.now()): void {
  if (!sessionId) return;
  const had = pending.has(sessionId);
  if (on) pending.set(sessionId, nowMs); else pending.delete(sessionId);
  if (pending.size > 2000) pending.clear();
  if (had !== on) listener?.(sessionId);
}

export function isReportPending(sessionId: string | null | undefined, nowMs = Date.now()): boolean {
  const since = sessionId ? pending.get(sessionId) : undefined;
  return since !== undefined && nowMs - since < REPORT_PENDING_MAX_MS;
}

/** The status sync's hook; one listener (null to stop). */
export function onReportPendingChange(fn: ((sessionId: string) => void) | null): void {
  listener = fn;
}

/** Test-only. */
export function __resetReportPending(): void {
  pending.clear();
}
