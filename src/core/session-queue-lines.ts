/**
 * The stdin lines the session message queue sent out: rows the CLI itself
 * reported taking, rows put back while their line's fate is unknown, and the
 * uuid each removed row went out in (so a Retry goes out under the same one).
 * Same store and write chain as the rest of the queue (session-queue-store.ts);
 * callers import it from session-message-queue.ts.
 */

import { randomUUID } from 'node:crypto';
import { log } from '../logging/index.js';
import { fateOf, isPhoneMessageId, noteDelivered, setFate } from './relay-fates.js';
import { getStore, mutateStore, type QueuedMessage, type QueueStore } from './session-queue-store.js';
import { leadsWithNotice, markNoticeDelivering } from './sessions/instruction-notice-flight.js';

/**
 * Remove rows the CLI itself reported taking (or a Stop cancelling), whatever
 * their state: a row put back to pending while its delivery was unconfirmed
 * must not be delivered again once the CLI says it has it. `ran: false` (a
 * cancelled line): a resend of the row is a new line, not this one again.
 */
export async function removeTaken(sessionId: string, ids: string[], opts?: { ran?: boolean }): Promise<void> {
  if (ids.length === 0) return;
  const idSet = new Set(ids);
  const ran = opts?.ran !== false;
  const found = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return false;
    const gone = queue.filter((m) => idSet.has(m.id));
    s.queues[sessionId] = queue.filter((m) => !idSet.has(m.id));
    for (const m of gone) {
      // A cancelled line never ran: sending its text again is a new line.
      if (ran) noteSettledLine(s, m);
      // A relayed phone message: ran here, or will never run anywhere (relay-fates.ts).
      else if (fateOf(s, m.id) || isPhoneMessageId(m.id)) setFate(s, m.id, 'removed');
    }
    if (ran) noteDelivered(s, gone);
    // Inside the lock: no other line gets a notice until this one is recorded as told.
    if (ran && gone.some((m) => leadsWithNotice(m.message))) markNoticeDelivering(sessionId);
    if (s.queues[sessionId].length === 0) delete s.queues[sessionId];
    if (gone.length === 0) return false;
    return ran ? gone.map((m) => m.message) : [];
  });
  if (found === false) return;
  log.session.debug('taken messages removed from queue', { sessionId, count: ids.length });
  // The CLI took a line led by the instruction notice: the session has now been told its lines.
  if (found.some(leadsWithNotice)) {
    const { noteInstructionNoticeDelivered } = await import('./sessions/instruction-notice.js');
    await noteInstructionNoticeDelivered(sessionId, found);
  }
}

/**
 * Undo a markProcessing whose line was never written (a delivery held back
 * before the write): the rows are pending again exactly as before, so their
 * next delivery is a first one, not a resend the daemon must be asked about.
 */
export async function unmarkUnwritten(messages: QueuedMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await mutateStore((s) => {
    for (const m of messages) {
      const row = s.queues[m.sessionId]?.find((q) => q.id === m.id);
      if (row?.status !== 'processing') continue;
      row.status = 'pending';
      const tries = (row.lineTries ?? 1) - 1;
      if (tries > 0) { row.lineTries = tries; continue; }
      delete row.lineTries;
      delete row.lineUuid;
      delete row.lineTracked;
    }
  });
}

/**
 * Put rows still in the queue back to pending, and nothing else: unlike
 * revertToPending it never re-inserts a missing row, because a row whose line
 * may be in a CLI is missing exactly when the CLI said it took it (removeTaken).
 * The rows are marked `lineInDoubt`: only a resend under their uuid delivers them.
 */
export async function revertIfQueued(messages: QueuedMessage[]): Promise<void> {
  if (messages.length === 0) return;
  await mutateStore((s) => {
    for (const m of messages) {
      const row = s.queues[m.sessionId]?.find((q) => q.id === m.id);
      if (row?.status !== 'processing') continue;
      row.status = 'pending';
      if (row.lineUuid) row.lineInDoubt = true;
    }
  });
}

/**
 * A CLI took these rows' line and stopped before answering it (line-answer-v1):
 * the rows still in the queue go back to pending ONCE, under a new uuid (the
 * CLI skips a uuid its transcript already holds, and acks it `completed`
 * without running it), so the next delivery sends them again as a first send.
 * A row already sent again this way is left as it is and returned in
 * `exhausted`, for the caller to park and tell the sender. Never re-inserts a
 * missing row (the CLI's word removed it).
 */
export async function requeueUnanswered(messages: QueuedMessage[], uuid?: string): Promise<{ resent: QueuedMessage[]; exhausted: QueuedMessage[] }> {
  if (messages.length === 0) return { resent: [], exhausted: [] };
  return mutateStore((s) => {
    const resent: QueuedMessage[] = [];
    const exhausted: QueuedMessage[] = [];
    // One line in, one line out: the rows of the line keep going together.
    const fresh = randomUUID();
    for (const m of messages) {
      const row = s.queues[m.sessionId]?.find((q) => q.id === m.id);
      if (!row || row.status === 'parked') continue;
      // A row that went out in another line since (a Retry) is not this line's any more.
      if (uuid && row.lineUuid && row.lineUuid !== uuid) continue;
      if (row.unansweredResent) { exhausted.push({ ...row }); continue; }
      row.status = 'pending';
      row.lineUuid = fresh;
      row.lineTries = 0;
      row.unansweredResent = true;
      delete row.lineTracked;
      delete row.lineInDoubt;
      resent.push({ ...row });
    }
    return { resent, exhausted };
  });
}

// ── Lines that settled ──
//
// A row leaves the queue once its line ran. If the user (or the phone) sends
// it again, the new row must go out under the SAME uuid so the CLI skips it.
// Kept in the queue file, so a Retry after a server restart still finds it.
// Bounded: the file is read and written whole on every queue change, and a
// Retry follows its failure closely.

const MAX_SETTLED_LINES = 256;

export function noteSettledLine(s: QueueStore, m: QueuedMessage): void {
  if (!m.lineUuid) return;
  const settled = s.settled ?? (s.settled = {});
  delete settled[m.id];
  settled[m.id] = m.lineUuid;
  const ids = Object.keys(settled);
  for (let i = 0; i < ids.length - MAX_SETTLED_LINES; i++) delete settled[ids[i]];
}

/** The uuid of the line a removed row went out in. */
export async function settledLineUuid(messageId: string): Promise<string | undefined> {
  return (await getStore()).settled?.[messageId];
}
