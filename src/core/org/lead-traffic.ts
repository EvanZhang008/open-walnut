/**
 * Who last wrote to whom between tasks, so a lead's team note (team-note.ts) does not repeat what a
 * worker already told the lead itself. 2026-11-01: after notes were paced hourly, the Walnut lead
 * still got 23 notes in 4 hours, every one sent at once for "Waiting on you", and almost every wait
 * was a worker that had just sent the lead its land request: the note rode, or followed, the very
 * message that said so.
 *
 * A task's message to another (a peer note or a reply: the envelope's `from-task`, or the Walnut
 * notice that hands over a request's answer, `about-task` with `request`) is stamped here when it
 * is queued into the receiver's session. A worker waiting on its lead told the lead itself when its
 * newest message to the lead is newer than the lead's newest message to it: the lead has read the
 * wait in the worker's own words. A wait after the lead wrote back, with nothing new from the
 * worker, is news again.
 *
 * In memory only: after a restart nothing is known, and every wait is told as before.
 */

const lastSent = new Map<string, number>();
const MAX_PAIRS = 5_000;

const OPEN = /^\s*<walnut-message\b[^>]*>/;
const attr = (open: string, name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(open)?.[1] ?? '';

/** The task that sent this queued text, when it is one task's message to another. */
export function senderTaskOf(enqueued: string): string | null {
  const open = OPEN.exec(enqueued)?.[0];
  if (!open) return null;
  const kind = attr(open, 'kind');
  if (kind === 'peer-note' || kind === 'reply') return attr(open, 'from-task') || null;
  // The request fallback: the target's last message, handed to the asker by Walnut.
  if (kind === 'notification' && attr(open, 'request')) return attr(open, 'about-task') || null;
  return null;
}

function key(from: string, to: string): string {
  return `${from}>${to}`;
}

/** Stamp one task's message to another. */
export function noteSent(fromTaskId: string, toTaskId: string, atMs = Date.now()): void {
  if (!fromTaskId || !toTaskId || fromTaskId === toTaskId) return;
  const k = key(fromTaskId, toTaskId);
  lastSent.delete(k);
  lastSent.set(k, atMs);
  // Oldest first in insertion order: drop the oldest pairs past the cap.
  while (lastSent.size > MAX_PAIRS) lastSent.delete(lastSent.keys().next().value!);
}

/** A message queued into a task's session: stamp it when it is another task's. Never throws. */
export async function noteQueuedMessage(sessionId: string, enqueued: string, atMs = Date.now()): Promise<void> {
  try {
    const from = senderTaskOf(enqueued);
    if (!from) return;
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const to = (await getSessionByClaudeId(sessionId))?.taskId;
    if (to) noteSent(from, to, atMs);
  } catch {
    // Not knowing only means the wait is told, as before.
  }
}

/** The worker's newest message to the lead is newer than the lead's to it. */
export function workerToldLead(workerTaskId: string, leadTaskId: string): boolean {
  const up = lastSent.get(key(workerTaskId, leadTaskId));
  if (up === undefined) return false;
  return up > (lastSent.get(key(leadTaskId, workerTaskId)) ?? -Infinity);
}

/** Tests: forget every stamp. */
export function _resetLeadTrafficForTesting(): void {
  lastSent.clear();
}
