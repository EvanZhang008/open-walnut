/**
 * A background notice never starts a turn of its own (2026-10-30, the Walnut lead, the user agreeing:
 * about half of the lead's turns were an agent-ack to a notice that only said something moved).
 *
 * A notice that asks nothing of the session (a request past its deadline that stays open, its
 * reminder at twice the deadline) waits here and rides in front of the session's next message
 * (session-message-queue.ts sendMessageToSession), like the place note and the status push. Never
 * written into a running turn either: a line that reached the CLI as its turn ended started a turn
 * of its own (2026-10-30: two of Main's agent-ack turns were deadline notices 0.3 s after its last
 * words). What needs the session to act still wakes it: a reply it waits for, a request to it, an
 * error, a completed subtask to check. Two more ride here (2026-11-12): a subtask's completion
 * its reply already told (subtask-notices.ts), and a note that asks nothing (quiet-notes.ts),
 * folded per sender (holdFoldedNotice).
 *
 * Kept on disk as well as in memory (held-notices-store.ts, 2026-11-21: a restart dropped three
 * notes a lead held for a task): a restart keeps what waits, and the server opens the file at boot.
 * A task's own note (a part marked `whole`, held-notices-store.ts keptWhole) is never cut, never
 * pushed out by newer ones and never expired by age: only its target being gone with no session
 * going on for it drops it. A note that is dropped (a script's by its age limit or the cap, any by
 * its session gone) is recorded so (op_result reads it by its message id) and its sending session
 * is told (held-notices-sweep.ts); that tell is kept on disk until it is delivered.
 */
import {
  FOLD_PARTS_MAX, HOLD_MAX_MS, expiredByAge, fateOf, held, metaOf, persist, queueTell, recordFate, setFolded,
  setPushedOutHandler, slotOf, storeLoading, taken, takeTells, waitingNote, mergeOlder, clearNow, type DropTell, type Held,
} from './held-notices-store.js';
import { log } from '../../logging/index.js';

export { FOLD_PARTS_MAX, HOLD_MAX_MS, type DropTell };

/** Why a note left the hold unread (the sender's notice and op_result say it). */
export const DROP_WHY = {
  age: `it waited ${HOLD_MAX_MS / 86_400_000} days and its target sent no message in that time`,
  gone: 'its target session is gone (it was removed or closed with nothing taking over)',
  pushed: `${FOLD_PARTS_MAX} newer notes from you waited for the same target, and only the newest ${FOLD_PARTS_MAX} are kept`,
} as const;

let tellTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A sender that cannot be told its note was dropped: said on the note's fate (op_result's held_note
 * reads it) and logged with the note, never handed to a session that is gone as if it were told.
 */
export function tellUndeliverable(t: Pick<DropTell, 'callerSid' | 'mid' | 'reason'> & Partial<DropTell>, why: string, now = Date.now()): void {
  log.session.warn('held notices: the sender of a dropped note could not be told', {
    messageId: t.mid, note: t.reason, callerSid: t.callerSid, taskId: t.taskId, fromTaskId: t.fromTask, tries: t.tries, why,
  });
  if (!t.mid) return;
  const prev = fateOf(t.mid);
  recordFate(t.mid, {
    state: 'dropped', at: now, sid: prev?.sid ?? '',
    why: `${prev?.why ?? 'it was dropped before reaching its target'}; its sender was not told either: ${why}`,
  });
}

/**
 * Record each dropped part that is a note (it has a message id), and queue its sender's notice (kept
 * on disk until told). A dropped tell (a part naming the notes it `told` of: its sender's session is
 * gone too) is written on each of those notes' fates instead.
 */
export function dropParts(sid: string, parts: readonly unknown[], why: string, now = Date.now()): void {
  let queued = false;
  for (const p of parts) {
    const m = metaOf(p);
    if (!m.mid) {
      for (const t of Array.isArray(m.told) ? m.told : []) if (t && typeof t === 'object') tellUndeliverable(t, `the notice that would tell it was dropped too, as ${why}`, now);
      continue;
    }
    recordFate(m.mid, { state: 'dropped', at: now, sid, why });
    void import('./delivery-ledger.js').then((l) => l.recordDelivery({ step: 'dropped', id: m.mid, sessionId: sid, why })).catch(() => {});
    log.session.info('held note dropped unread', { messageId: m.mid, sessionId: sid, fromSessionId: m.from, taskId: m.task, why });
    if (!m.from) continue;
    const sent = typeof m.at === 'number' ? new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') : '';
    const what = m.title ? `"${m.title.replace(/\s+/g, ' ').trim().slice(0, 120)}"` : `message ${m.mid}`;
    queueTell({
      callerSid: m.from, op: 'task_send', taskId: m.task ?? '', reason: `${what}${sent ? `, sent ${sent} UTC` : ''}: ${why}`,
      at: now, tries: 0, mid: m.mid, ...(m.fromTask ? { fromTask: m.fromTask } : {}),
    });
    queued = true;
  }
  if (queued && !tellTimer) {
    // Batched: one notice per sender for what one sweep or one burst dropped.
    tellTimer = setTimeout(() => {
      tellTimer = null;
      void import('./held-notices-sweep.js').then((m) => m.flushDropTells()).catch(() => {});
    }, 1_000);
    tellTimer.unref?.();
  }
}

/** Take the dropped notes' notices waiting to be told (settleTells says how it went). */
export function takeDropTells(): DropTell[] {
  return takeTells();
}

setPushedOutHandler((sid, parts) => dropParts(sid, parts, DROP_WHY.pushed));

/**
 * Hold `text` for the session's next message; a newer notice with the same key replaces it.
 * `whileOpen`: request ids; the notice is dropped unsent once none of them is open any more.
 * Held in memory at once; the promise resolves once it is on disk too (true), or that write failed (false).
 */
export function holdNotice(
  sessionId: string, key: string, text: string, opts: { now?: number; whileOpen?: readonly string[] } = {},
): Promise<boolean> {
  slotOf(sessionId).set(key, { text, at: opts.now ?? Date.now(), ...(opts.whileOpen?.length ? { whileOpen: [...opts.whileOpen] } : {}) });
  return persist();
}

/**
 * Hold one more part of a folded notice: every part held under `key` reads as ONE notice,
 * `render(parts)`, oldest part first (2026-11-12, the org reflection: the load watchdog sent one
 * note per paused process, three in the same minute, each waking the session). A part that would
 * go past FOLD_PARTS_MAX pushes the oldest out that is not a task's own note (keptWhole). A part
 * whose message id (`mid`) is already held, delivered or dropped is a replay, and is not held again.
 * Resolves true once it is on disk (persist), false when that write failed (it still waits in memory).
 */
export function holdFoldedNotice<P>(
  sessionId: string, key: string, part: P, render: (parts: P[], dropped: number) => string, opts: { now?: number } = {},
): Promise<boolean> {
  const mid = metaOf(part).mid;
  if (mid && noteKnown(mid)) return Promise.resolve(true);
  const slot = slotOf(sessionId);
  const prev = slot.get(key);
  // Its age is its newest part's: a part added late is not dropped with the old ones.
  const out = setFolded(slot, key, [...(prev?.parts ?? []), part], prev?.dropped ?? 0,
    render as Held['render'], opts.now ?? Date.now(), prev && !prev.render ? prev.text : undefined);
  if (out.length) dropParts(sessionId, out, DROP_WHY.pushed);
  return persist();
}

/** Whether a note with this message id waits, rode a message, or was dropped (a replay holds nothing). */
export function noteKnown(mid: string): boolean {
  return !!fateOf(mid) || !!waitingNote(mid);
}

/** What waits for a session's next message, read without taking it (tests, the send's answer). */
export function heldNoticeKeys(sessionId: string): string[] {
  return [...(held.get(sessionId)?.keys() ?? [])];
}

/** The requests a notice waiting for this session names (`whileOpen`): their notice is not read yet. */
export async function heldRequestIds(sessionId: string): Promise<Set<string>> {
  // What waited before a restart counts too.
  const loading = storeLoading();
  if (loading) await loading;
  const out = new Set<string>();
  for (const v of held.get(sessionId)?.values() ?? []) for (const id of v.whileOpen ?? []) out.add(id);
  return out;
}

/** Whether any of these requests is still unanswered (pending, or past its deadline and open). */
async function anyRequestOpen(ids: readonly string[]): Promise<boolean> {
  const { getSessionRequest } = await import('../session-requests.js');
  for (const id of ids) {
    const row = await getSessionRequest(id).catch(() => null);
    if (row && (row.status === 'pending' || row.status === 'expired')) return true;
  }
  return false;
}

let nextToken = 1;

/**
 * The notices waiting for a session's next message, taken out of the hold (so two sends at once
 * never both carry them), or null. `markTold(row)` says the stored message `row` carries them;
 * `release` puts back what it did not carry. Until one is called they stay in the file, so a
 * restart in between sends them again rather than losing them: at least once, never lost. The
 * same holds after markTold until its write is on disk, and for a send that held them past the
 * sweep's lap (held-notices-sweep.ts puts them back): either may carry them twice, rarely.
 * "Delivered" means stored in a row of the session's queue; a row withdrawn later still reads so.
 */
export async function pendingHeldNotices(sessionId: string, now = Date.now()): Promise<{
  text: string; release: () => void; markTold: (row?: string) => void;
} | null> {
  // The first send after boot carries what waited before the restart.
  const loading = storeLoading();
  if (loading) await loading;
  const slot = held.get(sessionId);
  if (!slot) return null;
  held.delete(sessionId);
  const token = nextToken++;
  const t = { sid: sessionId, at: now, entries: [...slot] };
  taken.set(token, t);
  const keep: Array<[string, Held]> = [];
  let dropped = false;
  for (const [k, v] of t.entries) {
    if (expiredByAge(v, now)) { dropParts(sessionId, v.parts ?? [], DROP_WHY.age, now); dropped = true; continue; }
    // A notice its own news overtook (the request got its reply) is dropped, never sent stale.
    if (v.whileOpen?.length && !(await anyRequestOpen(v.whileOpen).catch(() => true))) { dropped = true; continue; }
    keep.push([k, v]);
  }
  t.entries = keep;
  if (!keep.length) {
    taken.delete(token);
    if (dropped) void persist();
    return null;
  }
  let settled = false;
  return {
    text: keep.map(([, v]) => v.text).join('\n\n'),
    release: () => {
      if (settled) return;
      settled = true;
      putBack(token);
      void persist();
    },
    markTold: (row) => {
      if (settled) return;
      settled = true;
      // Put back meanwhile (held-notices-sweep.ts: a message that said nothing for minutes): they
      // wait again and their fate is recorded when they ride.
      if (!taken.delete(token)) return;
      const at = Date.now();
      const mids: string[] = [];
      for (const [, v] of keep) {
        for (const p of v.parts ?? []) {
          const mid = metaOf(p).mid;
          if (mid) { recordFate(mid, { state: 'delivered', at, sid: sessionId, ...(row ? { row } : {}) }); mids.push(mid); }
        }
      }
      // The delivery ledger: these notes are where the row that carries them is (sessions/delivery-ledger.ts).
      if (mids.length) void import('./delivery-ledger.js').then((l) => l.recordDelivery({ step: 'carried', ...(row ? { id: row } : {}), sessionId, ids: mids })).catch(() => {});
      void persist();
    },
  };
}

/** Put what a message took back in the hold; a newer notice of the same key that came meanwhile wins. */
export function putBack(token: number): void {
  const t = taken.get(token);
  if (!t) return;
  taken.delete(token);
  const cur = slotOf(t.sid);
  for (const [k, v] of t.entries) {
    const out = mergeOlder(cur, k, v);
    if (out.length) dropParts(t.sid, out, DROP_WHY.pushed);
  }
}

/**
 * What waits for `fromSid` waits for `toSid` now: its session's id changed (session-queue-park.ts
 * migrateSessionQueue, where the queue moves too) or another session took over from it (an engine
 * switch, held-notices-sweep.ts). Resolves to how many notices moved, once they are on disk.
 */
export async function moveHeldNotices(fromSid: string, toSid: string): Promise<number> {
  if (!fromSid || !toSid || fromSid === toSid) return 0;
  const loading = storeLoading();
  if (loading) await loading;
  // What a message of the old id took goes back under the new one if that message did not carry it.
  for (const t of taken.values()) if (t.sid === fromSid) t.sid = toSid;
  const slot = held.get(fromSid);
  if (!slot?.size) return 0;
  held.delete(fromSid);
  const dest = slotOf(toSid);
  for (const [k, v] of slot) {
    const out = mergeOlder(dest, k, v);
    if (out.length) dropParts(toSid, out, DROP_WHY.pushed);
  }
  log.session.info('held notices moved to the session that goes on', { fromSessionId: fromSid, toSessionId: toSid, keys: [...slot.keys()] });
  await persist();
  return slot.size;
}

/** Where a note stands now, by its message id (op_result): waiting, delivered, dropped, or unknown here. */
export async function heldNoteState(mid: string): Promise<{
  message_id: string; state: 'waiting' | 'delivered' | 'dropped' | 'unknown'; at?: string; session_id?: string; why?: string; row?: string;
}> {
  const loading = storeLoading();
  if (loading) await loading;
  const waiting = waitingNote(mid);
  if (waiting) return { message_id: mid, state: 'waiting', at: new Date(waiting.at).toISOString(), session_id: waiting.sid };
  const f = fateOf(mid);
  if (f) {
    return {
      message_id: mid, state: f.state, at: new Date(f.at).toISOString(), session_id: f.sid,
      ...(f.why ? { why: f.why } : {}), ...(f.row ? { row: f.row } : {}),
    };
  }
  return { message_id: mid, state: 'unknown' };
}

/** Test seam: forget every held notice (and the file, when this process opened it). */
export function _clearHeldNotices(): void {
  clearNow();
  if (tellTimer) clearTimeout(tellTimer);
  tellTimer = null;
}
