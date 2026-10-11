/**
 * A trigger message that sat in a session's queue long enough to be stale says so
 * when it is written (2026-10-10: a fire queued on 10-06 was written into a new CLI
 * process four days later, because the old one never took the line, and the session
 * acted on a pipeline state that was long gone).
 *
 * The note goes in at the moment the row is picked for a write (session-message-
 * queue.ts), not when the fire is built, because only then is the wait known. It is
 * one line right under the envelope's opening tag, rewritten on every later write so
 * it always names the latest wait, and a message that is not a trigger envelope is
 * never touched. The CLI keys the line by its uuid, so a process that already holds
 * the first copy still skips this one.
 */

import { LATE_FIRE_ADVICE } from '../../providers/trigger-envelope-core.js';
import { describeSpan } from '../cron/trigger-timing.js';

/** A trigger message older than this when written gets the note. */
export const STALE_TRIGGER_MESSAGE_MS = 60 * 60_000;

const TRIGGER_OPENING = '<walnut-message kind="trigger"';
const NOTE_PREFIX = 'Walnut note: this trigger message was queued at ';

/** The text to write instead, or null when it needs no note (not a trigger, or not stale). */
export function staleTriggerText(text: string, enqueuedAt: string, nowMs: number): string | null {
  if (!text.startsWith(TRIGGER_OPENING)) return null;
  const queuedMs = Date.parse(enqueuedAt);
  if (!Number.isFinite(queuedMs) || nowMs - queuedMs < STALE_TRIGGER_MESSAGE_MS) return null;
  const tagEnd = text.indexOf('\n');
  if (tagEnd === -1) return null;
  const note = `${NOTE_PREFIX}${new Date(queuedMs).toISOString()} and reaches you ${describeSpan(nowMs - queuedMs)} later, `
    + `so what it reports may be out of date. ${LATE_FIRE_ADVICE}`;
  const head = text.slice(0, tagEnd + 1);
  let rest = text.slice(tagEnd + 1);
  if (rest.startsWith(NOTE_PREFIX)) {
    const lineEnd = rest.indexOf('\n');
    rest = lineEnd === -1 ? '' : rest.slice(lineEnd + 1);
  }
  const next = `${head}${note}\n${rest}`;
  return next === text ? null : next;
}
