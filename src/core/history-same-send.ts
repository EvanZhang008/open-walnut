/**
 * One mid-turn send, seen from both sides of a seam between two reads of a transcript.
 *
 * A send that ran mid-turn is logged as an enqueue and, a few dozen lines later, as the
 * `queued_command` attachment where the CLI took it. Its row is `queue-<time>`, the time
 * being the enqueue's; a read holding only the take (a window starting between the two)
 * names it by the attachment's own time, which the CLI often writes 1 to 3 ms earlier
 * (history-parse.ts emitCutAwayTake). The older read on the other side holds only the
 * enqueue, as a send not yet taken. Keys (msgId, time, role) then differ, and joining the
 * two reads would show the message twice: these say they are one.
 */

/** The widest gap seen between a send's enqueue and its take's own timestamp, with margin. */
export const SAME_SEND_SKEW_MS = 5;

interface SendRow { msgId?: string; role?: string; timestamp?: string; text?: string }

/** Two `queue-` user rows of the same text within SAME_SEND_SKEW_MS: one send. */
export function isSameSend(a: SendRow, b: SendRow): boolean {
  if (a.role !== 'user' || b.role !== 'user') return false;
  if (!a.msgId?.startsWith('queue-') || !b.msgId?.startsWith('queue-')) return false;
  if (!a.text || a.text.trim() !== b.text?.trim() || !a.timestamp || !b.timestamp) return false;
  return Math.abs(Date.parse(a.timestamp) - Date.parse(b.timestamp)) <= SAME_SEND_SKEW_MS;
}

/** `older` without the rows that are a send `newer` already holds (newer's row is where it was taken). */
export function withoutHeldSends<T extends SendRow>(older: readonly T[], newer: readonly SendRow[]): T[] {
  const sends = newer.filter((m) => m.role === 'user' && m.msgId?.startsWith('queue-'));
  if (sends.length === 0) return older as T[];
  return older.filter((m) => !sends.some((h) => isSameSend(m, h)));
}
