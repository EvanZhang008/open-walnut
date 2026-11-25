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
 * is told (held-notices-sweep.ts); that tell is kept on disk until it is delivered. A quiet note
 * (quiet-notes.ts) never waits past COLD_HOLD_MAX_MS for a target that can take a message: it then
 * goes on its own (held-notices-sweep.ts deliverDueQuietNotes).
 */
import {
  DROP_TELL_KEY, FOLD_PARTS_MAX, HOLD_MAX_MS, QUIET_NOTE_KEY, expiredByAge, goesAlone, fateOf, held, heldTellOf, metaOf, oldestQuietAt, persist, queueTell,
  quietWaitWhyOf, recordFate, setFolded, setPushedOutHandler, slotOf, storeLoading, taken, takeTells, waitingNote, mergeOlder,
  clearNow, type DropTell, type Held, type PartMeta, type TellKind,
} from './held-notices-store.js';
import { log } from '../../logging/index.js';
import { callerItemLine } from './caller-notice.js';
import { buildWalnutMessage } from '../peers/walnut-message-tag.js';
import { clause } from '../../utils/format.js';

export { FOLD_PARTS_MAX, HOLD_MAX_MS, type DropTell };

/** Why a note left the hold unread (the sender's notice and op_result say it). */
export const DROP_WHY = {
  age: `it waited ${HOLD_MAX_MS / 86_400_000} days and its target sent no message in that time`,
  gone: 'its target session is gone (it was removed or closed with nothing taking over)',
  pushed: `${FOLD_PARTS_MAX} newer notes from you waited for the same target, and only the newest ${FOLD_PARTS_MAX} are kept`,
  complete: 'not delivered: its task was complete, so its session was not woken for a note that asked for no reply',
  /** A sender's tell (its parts name the notes they `told` of) whose sender's own task is complete. */
  tellComplete: 'its sender\'s task was complete, so its session was not woken for Walnut\'s notice about the note',
} as const;

let tellTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * A sender that cannot be told about its note: said on the note's fate (op_result's held_note reads
 * it) and logged with the note, never handed to a session that is gone as if it were told. A tell
 * that its note still waits (`waiting`) marks the note not told instead (`waitUntold`, its
 * `waitTold` cleared): op_result says so and why, and a lap a max hold later tells it again (its
 * sender's task may have a live session by then), or never (`final`: its sender's task is complete).
 */
export function tellUndeliverable(
  t: Pick<DropTell, 'callerSid' | 'mid' | 'reason'> & Partial<DropTell>, why: string, now = Date.now(), final = false,
): void {
  log.session.warn(t.kind === 'waiting' ? 'held notices: the sender of a note that still waits could not be told' : 'held notices: the sender of a dropped note could not be told', {
    messageId: t.mid, note: t.reason, callerSid: t.callerSid, taskId: t.taskId, fromTaskId: t.fromTask, tries: t.tries, kind: t.kind ?? 'dropped', why,
  });
  if (!t.mid) return;
  if (t.kind === 'waiting') {
    const w = waitingNote(t.mid);
    if (!w) return;
    const m = metaOf(w.part);
    delete m.waitTold;
    m.waitUntold = { at: now, why, ...(final ? { final: true } : {}) };
    void persist();
    return;
  }
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
    queueTell({
      kind: 'dropped', callerSid: m.from, op: 'task_send', taskId: m.task ?? '', reason: `${noteLabel(m)}: ${why}`,
      at: now, tries: 0, mid: m.mid, ...(m.fromTask ? { fromTask: m.fromTask } : {}),
    });
    queued = true;
  }
  if (queued) flushTellsSoon();
  // A tell that such a note still waits is stale now: the drop's own tell says what became of it.
  forgetWaitingTells(parts.map((p) => metaOf(p).mid).filter((x): x is string => !!x));
}

/** The rider outcome of each kind of tell (wake-policy.ts NOTICE_RIDES, history-walnut-riders.ts, iOS). */
export const TELL_OUTCOME: Record<TellKind, string> = { dropped: 'note-dropped', waiting: 'note-held' };

/** What a held tell names of each note (PartMeta.told). */
type ToldItem = NonNullable<PartMeta['told']>[number];

/**
 * The words of one sender's tell: one notice for its notes that were dropped, one for those that
 * still wait past the max hold (`holdMinutes`). Re-rendered from the part's `told` when one of
 * them leaves it (forgetWaitingTells).
 */
export function renderTell(list: readonly ToldItem[], holdMinutes: number): string {
  const notice = (kind: TellKind, lines: string[]) => buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: TELL_OUTCOME[kind], note: 'automated Walnut status notice: not a request' },
    body: lines.join('\n'),
  });
  const line = (t: ToldItem) => callerItemLine({ callerSid: t.callerSid, op: t.op ?? 'task_send', taskId: t.taskId, reason: t.reason });
  const dropped = list.filter((t) => (t.kind ?? 'dropped') === 'dropped');
  const waiting = list.filter((t) => t.kind === 'waiting');
  const out: string[] = [];
  if (dropped.length) {
    const one = dropped.length === 1;
    out.push(notice('dropped', [
      `${one ? 'A note' : `${dropped.length} notes`} you sent with wake=false waited to ride the target's next message and ${one ? 'was' : 'were'} dropped before reaching it, so ${one ? 'it was' : 'they were'} NOT delivered:`,
      ...dropped.map(line),
      'If one still matters, send it again with task_send (without wake=false it starts a turn), or task_start that task.',
    ]));
  }
  if (waiting.length) {
    const one = waiting.length === 1;
    out.push(notice('waiting', [
      `${one ? 'A note' : `${waiting.length} notes`} you sent with wake=false waited past the ${holdMinutes}-minute max hold without reaching ${one ? 'its target' : 'their targets'}:`,
      ...waiting.map(line),
    ]));
  }
  return out.join('\n\n');
}

/**
 * Notes that rode a message or were dropped: a held tell that says they still wait is stale. Each
 * leaves its tell's `told`; the tell is rendered again without it, or goes when nothing is left. A
 * tell a send took (`taken`) is on its way and left alone. Returns whether a tell changed.
 */
export function forgetWaitingTells(mids: readonly string[]): boolean {
  if (!mids.length) return false;
  const gone = new Set(mids);
  let changed = false;
  for (const [sid, slot] of held) {
    const h = slot.get(DROP_TELL_KEY);
    if (!h?.parts) continue;
    let touched = false;
    const parts: unknown[] = [];
    for (const p of h.parts) {
      const m = metaOf(p) as PartMeta & { text?: string; minutes?: number };
      const told = m.told ?? [];
      const keep = told.filter((t) => !(t && t.kind === 'waiting' && t.mid && gone.has(t.mid)));
      if (keep.length === told.length) { parts.push(p); continue; }
      touched = true;
      if (!keep.length) continue;
      m.told = keep;
      m.text = renderTell(keep, m.minutes ?? 60);
      parts.push(p);
    }
    if (!touched) continue;
    changed = true;
    if (!parts.length) {
      slot.delete(DROP_TELL_KEY);
      if (!slot.size) held.delete(sid);
      continue;
    }
    h.parts = parts;
    h.text = h.render ? h.render(parts, h.dropped ?? 0) : parts.map((p) => (metaOf(p) as { text?: string }).text ?? '').join('\n\n');
  }
  return changed;
}

/** How a tell names a note: its title (or message id) and when it was sent. */
function noteLabel(m: PartMeta): string {
  const sent = typeof m.at === 'number' ? new Date(m.at).toISOString().slice(0, 16).replace('T', ' ') : '';
  const what = m.title ? `"${m.title.replace(/\s+/g, ' ').trim().slice(0, 120)}"` : `message ${m.mid}`;
  return `${what}${sent ? `, sent ${sent} UTC` : ''}`;
}

/** Batched: one notice per sender for what one sweep, one lap or one burst queued. */
function flushTellsSoon(): void {
  if (tellTimer) return;
  tellTimer = setTimeout(() => {
    tellTimer = null;
    void import('./held-notices-sweep.js').then((m) => m.flushDropTells()).catch(() => {});
  }, 1_000);
  tellTimer.unref?.();
}

/**
 * Tell the sender of each quiet note held for `sid` that waited since `waitedSince` or longer that it
 * is not delivered yet, and why (`cause`, held-notices-sweep.ts QUIET_WAITS): once per note (the
 * part is marked `waitTold`, written with the tell in the same file write). The note stays held: it
 * is still delivered later, or dropped with its own tell. `target`: how the tell names the target.
 * A note not told the last time (waitUntold) is told again only if that was before `untoldRetryBefore`.
 * Returns how many senders' notes were marked (the caller writes the file).
 */
export function tellStillWaiting(
  sid: string, cause: string, waitedSince: number, target: string, now = Date.now(), untoldRetryBefore = waitedSince,
): number {
  let marked = 0;
  for (const [key, v] of held.get(sid) ?? []) {
    if (!key.startsWith(QUIET_NOTE_KEY)) continue;
    for (const p of v.parts ?? []) {
      const m = metaOf(p);
      // A script's note has no session to tell; Walnut's own never go alone.
      if (!goesAlone(key, p) || !m.mid || !m.from || m.waitTold !== undefined || (m.at ?? v.at) > waitedSince) continue;
      // Not told the last time (no live session took it): tried again once a max hold went by.
      if (m.waitUntold && (m.waitUntold.final || m.waitUntold.at > untoldRetryBefore)) continue;
      m.waitTold = now;
      delete m.waitUntold;
      queueTell({
        kind: 'waiting', callerSid: m.from, op: 'task_send', taskId: m.task ?? '',
        reason: `${noteLabel(m)}: ${stillWaitingWords(cause, target)}`,
        at: now, tries: 0, mid: m.mid, ...(m.fromTask ? { fromTask: m.fromTask } : {}),
      });
      marked++;
    }
  }
  if (marked) {
    log.session.info('held quiet notes: their senders are told they still wait', { sessionId: sid, notes: marked, cause });
    flushTellsSoon();
  }
  return marked;
}

/** The words a sender reads about a note of its that still waits past its max hold. */
export function stillWaitingWords(cause: string, target: string): string {
  return `not delivered yet: ${clause(cause)}. It stays held and rides ${target}'s next message; `
    + 'send it again without wake=false (or task_start that task) to have it read now.';
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
  text: string; release: () => void; markTold: (row?: string) => Promise<void>;
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
    // Resolves once they are off the file (a caller that must not send them twice after a crash awaits it).
    markTold: async (row) => {
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
      // Their senders' tells that they still wait are stale now.
      forgetWaitingTells(mids);
      await persist();
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
  /** Its sender's tell about it: told it still waits (and when), or that tell, or the drop's, still on its way (and why). */
  sender_told?: string;
}> {
  const loading = storeLoading();
  if (loading) await loading;
  const waiting = waitingNote(mid);
  if (waiting) {
    const { waitTold: told, waitUntold: untold } = metaOf(waiting.part);
    const tell = await tellState(mid);
    return {
      message_id: mid, state: 'waiting', at: new Date(waiting.at).toISOString(), session_id: waiting.sid,
      ...(waiting.key.startsWith(QUIET_NOTE_KEY) ? {
        why: goesAlone(waiting.key, waiting.part) ? await quietWaitWhy(waiting.sid) : 'Walnut\'s own notice: it rides its target\'s next message and wakes nothing',
      } : {}),
      ...(tell ? { sender_told: tell }
        : typeof told === 'number' ? { sender_told: `told at ${new Date(told).toISOString()} that it is not delivered yet` }
          : untold ? { sender_told: untold.final ? `not told (${new Date(untold.at).toISOString()}): ${untold.why}`
            : `not told yet (tried ${new Date(untold.at).toISOString()}: ${untold.why}); tried again a max hold later` } : {}),
    };
  }
  const f = fateOf(mid);
  if (f) {
    const tell = await tellState(mid);
    return {
      message_id: mid, state: f.state, at: new Date(f.at).toISOString(), session_id: f.sid,
      ...(f.why ? { why: f.why } : {}), ...(f.row ? { row: f.row } : {}), ...(tell ? { sender_told: tell } : {}),
    };
  }
  return { message_id: mid, state: 'unknown' };
}

/** A tell about this note still held for its sender: where it waits, and why. */
async function tellState(mid: string): Promise<string | undefined> {
  const t = heldTellOf(mid);
  if (!t) return undefined;
  return `not yet: Walnut's notice that it ${t.kind === 'waiting' ? 'is not delivered yet' : 'was dropped'} waits for session ${t.sid}: ${await quietWaitWhy(t.sid)}`;
}

/** Why a quiet note still waits: the lap's last word on its target, else when it goes at the latest. */
async function quietWaitWhy(sid: string): Promise<string> {
  const said = quietWaitWhyOf(sid);
  if (said) return said;
  const { COLD_HOLD_MAX_MS } = await import('./cold-hold.js');
  const oldest = oldestQuietAt(sid) ?? Date.now();
  return `it rides its target's next message, or goes on its own at ${new Date(oldest + COLD_HOLD_MAX_MS).toISOString()}`;
}

/** Test seam: forget every held notice (and the file, when this process opened it). */
export function _clearHeldNotices(): void {
  clearNow();
  if (tellTimer) clearTimeout(tellTimer);
  tellTimer = null;
}
