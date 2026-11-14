/**
 * The stdin lines the session message queue sent out: rows the CLI itself
 * reported taking, rows put back while their line's fate is unknown, and the
 * uuid each removed row went out in (so a Retry goes out under the same one).
 * Same store and write chain as the rest of the queue (session-queue-store.ts);
 * callers import it from session-message-queue.ts.
 */

import { randomUUID } from 'node:crypto';
import { noteLineCarries } from '../providers/batch-uuid.js';
import { log } from '../logging/index.js';
import { fateOf, isPhoneMessageId, noteDelivered, setFate, STOP_PARKED_REASON } from './relay-fates.js';
import { compareEnqueueOrder, getStore, mutateStore, type QueuedMessage, type QueueStore } from './session-queue-store.js';
import { leadsWithNotice, markNoticeDelivering } from './sessions/instruction-notice-flight.js';

/**
 * Remove rows the CLI itself reported taking (or a Stop cancelling), whatever
 * their state: a row put back to pending while its delivery was unconfirmed
 * must not be delivered again once the CLI says it has it. `ran: false` (a
 * cancelled line): a resend of the row is a new line, not this one again.
 */
export async function removeTaken(sessionId: string, ids: string[], opts?: { ran?: boolean; rows?: QueuedMessage[]; preserveParked?: boolean; confirmedCancelled?: boolean }): Promise<QueuedMessage[]> {
  if (ids.length === 0) return [];
  const idSet = new Set(ids);
  const ran = opts?.ran !== false;
  const found = await mutateStore((s) => {
    const queue = s.queues[sessionId];
    if (!queue) return false;
    const matches = (m: QueuedMessage) => idSet.has(m.id)
      && !(m.status === 'parked' && (!ran && m.parkedReason === STOP_PARKED_REASON || opts?.preserveParked))
      && (!opts?.rows || opts.rows.some((r) => r.id === m.id && r.lineUuid === m.lineUuid));
    if (!ran && opts?.confirmedCancelled) {
      for (const m of queue) {
        if (m.status !== 'parked' || m.parkedReason !== STOP_PARKED_REASON || !idSet.has(m.id)
          || opts?.rows && !opts.rows.some((r) => r.id === m.id && r.lineUuid === m.lineUuid)) continue;
        // The CLI cancelled this UUID; an explicit Retry must be a new line.
        m.lineUuid = randomUUID();
        m.lineTries = 0;
        delete m.lineTracked;
        delete m.lineInDoubt;
      }
    }
    const gone = queue.filter(matches);
    s.queues[sessionId] = queue.filter((m) => !matches(m));
    for (const m of gone) {
      // A cancelled line never ran: sending its text again is a new line.
      if (ran) noteSettledLine(s, m);
      else {
        // Capture only an exact registered line, atomically with its removal.
        if (m.lineUuid && opts?.rows?.some((r) => r.id === m.id && r.lineUuid === m.lineUuid)) {
          const sessions = s.cancelled ??= {};
          const lines = sessions[sessionId] ??= {};
          const snapshot = lines[m.lineUuid] ??= { rows: [] };
          if (!snapshot.rows.some((r) => r.id === m.id)) snapshot.rows.push({ ...m });
        }
        if (fateOf(s, m.id) || isPhoneMessageId(m.id)) setFate(s, m.id, 'removed');
      }
    }
    if (ran) noteDelivered(s, gone);
    // Inside the lock: no other line gets a notice until this one is recorded as told.
    if (ran && gone.some((m) => leadsWithNotice(m.message))) markNoticeDelivering(sessionId);
    if (s.queues[sessionId].length === 0) delete s.queues[sessionId];
    if (gone.length === 0) return false;
    return gone;
  }, !ran, !ran);
  if (found === false) return [];
  log.session.debug('taken messages removed from queue', { sessionId, count: found.length });
  // The CLI took a line led by the instruction notice: the session has now been told its lines.
  const messages = ran ? found.map((m) => m.message) : [];
  if (messages.some(leadsWithNotice)) {
    const { noteInstructionNoticeDelivered } = await import('./sessions/instruction-notice.js');
    await noteInstructionNoticeDelivered(sessionId, messages);
  }
  return found;
}

/** Sessions with durable cancellation evidence; no history scan or delivery. */
export async function cancelledSessionIds(): Promise<string[]> {
  return Object.keys((await getStore()).cancelled ?? {});
}

/** Read cancelled rows without making them pending or starting delivery. */
export async function cancelledRows(sessionId: string, uuid?: string): Promise<QueuedMessage[]> {
  const lines = (await getStore()).cancelled?.[sessionId];
  const rows = uuid ? lines?.[uuid]?.rows ?? [] : Object.values(lines ?? {}).flatMap((line) => line.rows);
  return rows.map((r) => ({ ...r }));
}

/** Repair only the durable cancellation snapshot (or a still-present exact row), never a RAM claim. */
export async function repairCancelledTaken(sessionId: string, rows: QueuedMessage[], answered: boolean, _cancelledDelete: boolean, opts?: { pending?: boolean }): Promise<void> {
  const restored = await mutateStore((s) => {
    const queue = s.queues[sessionId] ?? [];
    const lines = s.cancelled?.[sessionId];
    const taken = new Set<string>();
    for (const requested of rows) {
      const snapshot = requested.lineUuid ? lines?.[requested.lineUuid] : undefined;
      const saved = snapshot?.rows.find((r) => r.id === requested.id && r.lineUuid === requested.lineUuid);
      const current = queue.find((m) => m.id === requested.id);
      // A reused id with another line belongs to its new delivery, not this cancellation.
      if (current && current.lineUuid !== requested.lineUuid) continue;
      const captured = saved ?? current;
      if (!captured) continue;
      if (answered) {
        if (current) queue.splice(queue.indexOf(current), 1);
        noteSettledLine(s, captured);
      } else if (opts?.pending) {
        // A dead holder never answered it: pending under its own uuid, in doubt, so the delivery asks again.
        const row = current ?? { ...captured };
        if (row.status !== 'parked') { row.status = 'pending'; if (row.lineUuid) row.lineInDoubt = true; }
        // In its enqueue place: an older line goes out before rows sent after it.
        if (!current) { const at = queue.findIndex((q) => compareEnqueueOrder(row, q) < 0); queue.splice(at < 0 ? queue.length : at, 0, row); }
      } else {
        if (!current) queue.push({ ...captured, status: 'processing' });
        else current.status = 'processing';
        if (captured.lineUuid) taken.add(captured.lineUuid);
      }
      // The exact cancelled row may say removed; the CLI's taken word outranks it.
      if (isPhoneMessageId(captured.id) || fateOf(s, captured.id)) setFate(s, captured.id, 'taken');
      if (snapshot) {
        snapshot.rows = snapshot.rows.filter((r) => r.id !== captured.id);
        if (!snapshot.rows.length) delete lines![requested.lineUuid!];
      }
    }
    if (queue.length) s.queues[sessionId] = queue;
    else delete s.queues[sessionId];
    if (lines && !Object.keys(lines).length) delete s.cancelled![sessionId];
    if (s.cancelled && !Object.keys(s.cancelled).length) delete s.cancelled;
    return [...taken].map((uuid) => ({ uuid, ids: queue.filter((r) => r.status === 'processing' && r.lineUuid === uuid).map((r) => r.id) }));
  }, true, true);
  for (const line of restored) noteLineCarries(sessionId, line.uuid, line.ids);
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
