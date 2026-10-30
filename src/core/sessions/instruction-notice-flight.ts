/**
 * Instruction notices on their way into a session (instruction-notice.ts). Sync and
 * import-free, so the queue can mark one inside its own lock.
 *
 * 2026-10-30: Main got the same notice twice 4 s apart. Its first line carried the
 * notice frozen at 07:27; the CLI was dead, so that line waited 9 minutes for a
 * resume, the 60 s claim that stood for "already attached" lapsed, and the next
 * batch got the notice again. What counts now is the queue itself (a live row
 * carries the notice) and, for the moment between a delivery and its told record,
 * this mark.
 */

const delivering = new Map<string, number>();
/** A mark outlives a lost record write by this much at most. */
const DELIVERING_MS = 30_000;

export const NOTICE_OUTCOME_ATTR = 'outcome="task-routing-policy"';
export const NOTICE_OPENING = `<walnut-message kind="notification" from="Walnut" ${NOTICE_OUTCOME_ATTR}`;

export function leadsWithNotice(text: string): boolean {
  return text.trimStart().startsWith(NOTICE_OPENING);
}

/** A line led by a notice left the queue for the CLI: told, as soon as the record is written. */
export function markNoticeDelivering(sessionId: string): void {
  delivering.set(sessionId, Date.now());
}

export function clearNoticeDelivering(sessionId: string): void {
  delivering.delete(sessionId);
}

export function noticeDelivering(sessionId: string): boolean {
  const at = delivering.get(sessionId);
  if (at === undefined) return false;
  if (Date.now() - at < DELIVERING_MS) return true;
  delivering.delete(sessionId);
  return false;
}

const toldGen = new Map<string, number>();

/** Bumped whenever a session is recorded as told: a notice looked up before that is stale. */
export function noticeToldGeneration(sessionId: string): number {
  return toldGen.get(sessionId) ?? 0;
}

export function bumpNoticeTold(sessionId: string): void {
  toldGen.set(sessionId, noticeToldGeneration(sessionId) + 1);
  if (toldGen.size > 5_000) toldGen.delete(toldGen.keys().next().value as string);
}

/** A row still on its way (pending or written, not parked) already carries a notice. */
export function noticeInFlight(rows: ReadonlyArray<{ status: string; message: string }>): boolean {
  return rows.some((m) => (m.status === 'pending' || m.status === 'processing') && leadsWithNotice(m.message));
}
