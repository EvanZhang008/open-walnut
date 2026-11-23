/**
 * The held notices' upkeep (held-notices.ts), on the server that opened their file:
 *  - boot: the file is read (held-notices-store.ts openStore), so what waited before the restart
 *    rides each session's next message;
 *  - every SWEEP_MS (the first lap one SWEEP_MS after boot, once the session store has settled):
 *      a notice past its age limit (HOLD_MAX_MS) is dropped, never one that holds a task's own
 *      note (held-notices-store.ts keptWhole): that waits for its target's next message however long;
 *      a session that is gone hands what waits for it to the session that took over (an engine
 *      switch's, an ACP id's replacement, the task's current session); with none, two laps in a
 *      row, it is dropped (an id that changes moves its notices at once: migrateSessionQueue);
 *      notices a message took and never said whether it carried them wait again.
 * A dropped NOTE (task_send wake=false: it has a message id) is recorded so (op_result reads it)
 * and its sending session is told, one notice per sender (flushDropTells): at the session its
 * task goes on with when that one is gone, kept on disk until it is told and tried again every lap
 * while telling fails (TELL_KEEP_MS at most); with no live session to take it, the note's fate says
 * so. That notice asks nothing either (outcome note-dropped): nobody waited on the note, so it
 * rides the sender's next message (DROP_TELL_KEY, never aged or capped out) rather than starting a turn.
 * What a gone session drops leaves a record its sender can read, but for Walnut's own status notices:
 * a note its fate; a tell (its sender's session gone too) the fates of the notes it told of; a
 * topic's fold its posts, back to the topic as unread (topic-delivery.ts returnFoldsUnread, done
 * before the drop and tried again next lap while it fails).
 *
 * A quiet note (quiet-notes.ts: a session's wake=false note, a script's no-reply note) never waits
 * past the cold hold's max (deliverDueQuietNotes, on the cold hold's lap, cold-hold.ts): once the
 * oldest held for a target waited COLD_HOLD_MAX_MS, every quiet note held for it goes in ONE message,
 * which wakes it once, when it can take one; its task complete, they are recorded not delivered and
 * their senders told.
 */
import { log } from '../../logging/index.js';
import {
  TELL_KEEP_MS, closeStore, expiredByAge, goesAlone, held, metaOf, oldestQuietAt, openStore, persist, pruneFates,
  setQuietWaitWhy, settleTells, storeLoading, storeOpened, taken, type DropTell, type Held,
} from './held-notices-store.js';
import {
  DROP_WHY, dropParts, holdFoldedNotice, moveHeldNotices, pendingHeldNotices, putBack, takeDropTells, tellUndeliverable,
} from './held-notices.js';
import { randomUUID } from 'node:crypto';
import { isAcpEngine } from '../agents/engine-registry.js';
import type { SessionRecord } from '../types.js';

const SWEEP_MS = 10 * 60_000;
/** A message that took notices and said nothing for this long did not carry them. */
const TAKEN_STALE_MS = 10 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Server boot (the leader): read the file, then sweep every SWEEP_MS. Idempotent. */
export async function startHeldNotices(): Promise<void> {
  await openStore();
  // Quiet notes a restart kept: the cold hold's lap delivers them by their own clock (deliverDueQuietNotes).
  if ([...held.keys()].some((sid) => oldestQuietAt(sid) !== null)) {
    void import('./cold-hold.js').then((m) => m.noteQuietHold()).catch(() => {});
  }
  if (timer) return;
  timer = setInterval(() => { void sweepHeldNotices(); }, SWEEP_MS);
  timer.unref?.();
}

/** Server stop: no more sweeps; resolves once what waits is on disk. */
export async function stopHeldNotices(): Promise<void> {
  if (timer) clearInterval(timer);
  timer = null;
  await closeStore();
}

/** The task each held part names (a quiet note names its target's), for a session whose record is gone. */
function tasksOf(sid: string): string[] {
  const out = new Set<string>();
  for (const v of held.get(sid)?.values() ?? []) for (const p of v.parts ?? []) { const t = metaOf(p).task; if (t) out.add(t); }
  return [...out];
}

/**
 * Where a session's held notices go now: `stay` (it is there, a switch of its task runs, or nothing
 * is known), `gone`, or the id of the session that goes on for it: the one an engine switch or an ACP
 * id's replacement names, else its task's current session.
 */
async function whereNow(sid: string): Promise<'stay' | 'gone' | { to: string }> {
  try {
    const { getSessionByClaudeId, getAcpIdentityReplacementTarget } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sid);
    if (rec && !rec.archived) return 'stay';
    const sw = await import('./engine-switch.js');
    // A switch or a move of its task runs: what waits goes with it when it is done.
    if (sw.switchingFrom(sid) || sw.movingFrom({ sessionId: sid }) || (rec?.taskId && sw.isSwitching(rec.taskId))) return 'stay';
    const named = rec ? rec.supersededBy ?? getAcpIdentityReplacementTarget(rec) ?? undefined : undefined;
    const { getTask } = await import('../task-manager.js');
    const tasks = rec?.taskId ? [rec.taskId] : tasksOf(sid);
    const current = await Promise.all(tasks.map(async (id) => (await getTask(id).catch(() => null))?.session_id ?? undefined));
    for (const next of [named, ...current]) {
      if (!next || next === sid) continue;
      const to = await getSessionByClaudeId(next);
      if (to && !to.archived) return { to: next };
    }
    return 'gone';
  } catch (err) {
    log.session.warn('held notices: could not read where a session stands; they stay', { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
    return 'stay';
  }
}

/**
 * Sessions a lap found gone, and when: only a second lap that finds one still gone drops what waits
 * for it, so a switch or a retry caught between archiving the old session and naming the new one
 * (SWEEP_MS apart at least) is never taken for gone.
 */
const goneSince = new Map<string, number>();

/** One lap. Returns how many notices were dropped and how many moved to a session that goes on. */
export async function sweepHeldNotices(now = Date.now()): Promise<{ dropped: number; moved: number }> {
  let dropped = 0;
  let moved = 0;
  let changed = false;
  for (const [token, t] of [...taken]) {
    if (now - t.at <= TAKEN_STALE_MS) continue;
    putBack(token);
    changed = true;
  }
  for (const sid of goneSince.keys()) if (!held.has(sid)) goneSince.delete(sid);
  for (const sid of [...held.keys()]) {
    const slot = held.get(sid);
    if (!slot) continue;
    for (const [key, v] of [...slot]) {
      if (!expiredByAge(v, now)) continue;
      slot.delete(key);
      dropParts(sid, v.parts ?? [], DROP_WHY.age, now);
      dropped++;
      changed = true;
    }
    if (!slot.size) { held.delete(sid); continue; }
    const where = await whereNow(sid);
    if (where === 'stay') { goneSince.delete(sid); continue; }
    if (where !== 'gone') {
      goneSince.delete(sid);
      moved += await moveHeldNotices(sid, where.to);
      continue;
    }
    // Gone on the first look: the next lap decides.
    if (!goneSince.has(sid)) { goneSince.set(sid, now); continue; }
    // Read again after the awaits: a send may have taken them meanwhile.
    const still = held.get(sid);
    if (!still?.size) { goneSince.delete(sid); continue; }
    // A topic's folded posts go back to the topic as unread before they go. A topic that could not
    // be written keeps its folds for the next lap; everything else goes now. What changed during
    // the return (a fold held meanwhile) waits for the next lap whole.
    const { tried, failed } = await topicFoldsReturned(sid, still);
    if (held.get(sid) !== still || topicFolds(still).some((p) => !tried.has(p))) continue;
    const keep = (v: Held) => (v.parts ?? []).some((p) => failed.has(metaOf(p).topic ?? ''));
    const go = [...still].filter(([, v]) => !keep(v));
    const kept = still.size - go.length;
    if (!kept) { goneSince.delete(sid); held.delete(sid); } else for (const [key] of go) still.delete(key);
    if (!go.length) continue;
    changed = true;
    for (const [, v] of go) dropParts(sid, v.parts ?? [], DROP_WHY.gone, now);
    dropped += go.length;
    log.session.info('held notices dropped: their session is gone', { sessionId: sid, keys: go.map(([key]) => key), keptForRetry: kept });
  }
  if (pruneFates(now)) changed = true;
  if (changed) await persist();
  await flushDropTells();
  return { dropped, moved };
}

/** The parts of `slot`'s notices that are a topic's fold (topics/topic-text.ts FoldPart). */
function topicFolds(slot: Map<string, Held>): unknown[] {
  return [...slot.values()].flatMap((v) => (v.parts ?? []).filter((p) => !!metaOf(p).topic));
}

/**
 * Give the topic folds among `slot`'s notices back to their topics as unread: `tried` are the parts
 * it handled, `failed` the topics that could not be written (their folds stay for the next lap).
 */
async function topicFoldsReturned(sid: string, slot: Map<string, Held>): Promise<{ tried: Set<unknown>; failed: Set<string> }> {
  const folds = topicFolds(slot);
  const tried = new Set(folds);
  if (!folds.length) return { tried, failed: new Set() };
  try {
    const { returnFoldsUnread } = await import('../topics/topic-delivery.js');
    return { tried, failed: await returnFoldsUnread(folds) };
  } catch (err) {
    log.session.warn('held notices: a gone session\'s topic posts could not go back unread; kept, tried again next lap', {
      sessionId: sid, error: err instanceof Error ? err.message : String(err),
    });
    return { tried, failed: new Set(folds.map((p) => metaOf(p).topic ?? '')) };
  }
}

/** The key a sender's tells wait under: their parts are `whole`, so no age limit or cap drops them. */
export const DROP_TELL_KEY = 'note-dropped';

/**
 * Where a sender is told now: its own session while that is there, else the session its task goes
 * on with (the sender's record names the task, or the note did); null when no live session can take
 * it. Throws when the stores cannot be read (the tell is tried again).
 */
async function tellWhere(t: DropTell): Promise<string | null> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(t.callerSid);
  if (rec && !rec.archived) return t.callerSid;
  const { getTask } = await import('../task-manager.js');
  for (const taskId of new Set([rec?.taskId, t.fromTask])) {
    if (!taskId) continue;
    const next = (await getTask(taskId).catch(() => null))?.session_id;
    const to = next && next !== t.callerSid ? await getSessionByClaudeId(next) : null;
    if (next && to && !to.archived) return next;
  }
  return null;
}

/** The words of one sender's tell: the notes of its that were dropped. */
async function tellText(list: readonly DropTell[]): Promise<string> {
  const [{ callerItemLine }, { buildWalnutMessage }] = await Promise.all([
    import('./caller-notice.js'), import('../peers/walnut-message-tag.js'),
  ]);
  return buildWalnutMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: 'note-dropped', note: 'automated Walnut status notice: not a request' },
    body: [
      `${list.length === 1 ? 'A note' : `${list.length} notes`} you sent with wake=false waited to ride the target's next message and ${list.length === 1 ? 'was' : 'were'} dropped before reaching it, so ${list.length === 1 ? 'it was' : 'they were'} NOT delivered:`,
      ...list.map(callerItemLine),
      'If one still matters, send it again with task_send (without wake=false it starts a turn), or task_start that task.',
    ].join('\n'),
  });
}

/**
 * Tell each sender, in one notice, the notes of its that were dropped unread. The notice is held for
 * the sender's next message (it asks nothing) as a `whole` part under DROP_TELL_KEY, in the same file
 * and the same write that takes the tell off the queue, so no age limit or cap drops it. A tell no
 * live session can take is written on its note's fate (tellUndeliverable); one that failed for an
 * error waits for the next try (the next drop, or the next lap), until TELL_KEEP_MS. Never throws.
 */
export async function flushDropTells(now = Date.now()): Promise<number> {
  const batch = takeDropTells();
  if (!batch.length) return 0;
  const untold: DropTell[] = [];
  let told = 0;
  const bySession = new Map<string, DropTell[]>();
  for (const t of batch) {
    try {
      const where = await tellWhere(t);
      if (!where) { tellUndeliverable(t, 'no live session of it or of its task can take the notice', now); continue; }
      bySession.set(where, [...(bySession.get(where) ?? []), t]);
    } catch (err) {
      log.session.warn('held notices: where to tell a dropped note\'s sender could not be read; tried again later', { messageId: t.mid, error: err instanceof Error ? err.message : String(err) });
      untold.push(t);
    }
  }
  for (const [sid, list] of bySession) {
    try {
      const text = await tellText(list);
      // It names the notes it tells of: dropped in turn (this session gone too), their fates say so.
      const notes = list.map((t) => ({
        callerSid: t.callerSid, reason: t.reason, taskId: t.taskId, ...(t.mid ? { mid: t.mid } : {}), ...(t.fromTask ? { fromTask: t.fromTask } : {}),
      }));
      const task = list.find((t) => t.fromTask)?.fromTask;
      void holdFoldedNotice<{ at: number; text: string; whole: true; told: typeof notes; task?: string }>(sid, DROP_TELL_KEY,
        { at: now, text, whole: true, told: notes, ...(task ? { task } : {}) },
        (parts) => parts.map((p) => p.text).join('\n\n'), { now });
      told++;
    } catch (err) {
      log.session.warn('held notices: a dropped note\'s sender could not be told; tried again later', { callerSid: sid, error: err instanceof Error ? err.message : String(err) });
      untold.push(...list);
    }
  }
  const again: DropTell[] = [];
  for (const t of untold) {
    const next = { ...t, tries: t.tries + 1 };
    if (now - t.at > TELL_KEEP_MS) tellUndeliverable(next, `telling it failed for ${TELL_KEEP_MS / 86_400_000} days`, now);
    else again.push(next);
  }
  settleTells(batch, again);
  await persist();
  return told;
}

// ── quiet notes past the max hold ──

/** The source a quiet note's own delivery goes under: Walnut's, never a person's input. */
export const HELD_NOTES_SOURCE = 'held-notes';

/**
 * Why a quiet note to a stopped session waits (2026-11-23). Starting a stopped session for notes
 * whose senders said they need no reply costs a full run of it (its whole context read again), and
 * nothing is waiting on them; held, they are never lost (on disk, a task's note never ages out) and
 * ride the session's next message, which a run of the task starts with. Its task completing drops
 * them with their senders told; until then op_result's held_note says this.
 */
export const STOPPED_WAIT_WHY = 'its target\'s session is stopped, and a note that asked for no reply does not start it: '
  + 'it rides that session\'s next message (the task\'s next run); send it again without wake=false to have it read now';
/** Why a quiet note to a task that waits on the user waits, when a quiet turn cannot carry it. */
export const NEED_ACTION_WAIT_WHY = 'its task waits on the user and its session cannot take a quiet turn now, and a normal turn would move '
  + 'the task on the user\'s board: it rides that session\'s next message';
/** Why a quiet note to a snoozed task waits, when a quiet turn cannot carry it (src/core/snooze.ts). */
export const SNOOZED_WAIT_WHY = 'its task is snoozed and its session cannot take a quiet turn now, and a normal turn would put it '
  + 'back on the user\'s board before the snooze ends: it rides that session\'s next message, or goes once the snooze ends';
const RUNNING_WAIT_WHY = 'its target is running a turn: it rides that turn\'s next message, or goes on its own once the turn ends';
const ORG_OFF_WAIT_WHY = 'the org is off, and its target (CEO or a VP) takes no background message: it rides its next message';

/** At most this many targets get their quiet notes in one lap: after a restart, many wakes spread over minutes. */
export const QUIET_DELIVERIES_PER_LAP = 3;
/** A target found unable to take them (or whose delivery failed) is looked at again after this. */
const QUIET_RETRY_MS = SWEEP_MS;
const quietRetryAt = new Map<string, number>();

type QuietVerdict =
  /** `heldForUser`: why a normal turn may not carry them (the task asks the user, or is snoozed): only a quiet turn may. */
  | { act: 'deliver'; rec: SessionRecord; heldForUser?: string }
  | { act: 'complete' }
  /** `soon`: looked at again the next lap (a turn that runs ends soon). */
  | { act: 'wait'; why: string; soon?: true }
  /** Gone, archived or replaced: the held-notices lap moves what waits, or drops it told (whereNow). */
  | { act: 'leave' };

/** What to do with the quiet notes held for `sid` now that they waited their max hold. */
async function quietVerdict(sid: string): Promise<QuietVerdict> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(sid);
  if (!rec || rec.archived || rec.supersededBy) return { act: 'leave' };
  const sw = await import('./engine-switch.js');
  if (sw.switchingFrom(sid) || sw.movingFrom({ sessionId: sid }) || (rec.taskId && sw.isSwitching(rec.taskId))) {
    return { act: 'wait', why: 'its target\'s task is switching engine or moving: it goes with the session that carries on' };
  }
  const { turnRunning } = await import('./cold-hold.js');
  if (await turnRunning(sid, rec.process_status)) return { act: 'wait', why: RUNNING_WAIT_WHY, soon: true };
  const { getTask } = await import('../task-manager.js');
  const task = rec.taskId ? await getTask(rec.taskId).catch(() => null) : null;
  if (task?.phase === 'COMPLETE') return { act: 'complete' };
  // With the org off, CEO and the VPs take no background message (org/org-enabled.ts).
  const { isOrgEnabled, isOrgNode } = await import('../org/org-enabled.js');
  if (isOrgNode(task) && !(await isOrgEnabled())) return { act: 'wait', why: ORG_OFF_WAIT_WHY };
  // A router's session takes only a person's words (router/delivery-scope.ts): the notes ride one.
  if (rec.profile?.areaId && rec.profile.areaRole === 'router') return { act: 'wait', why: 'its target takes only a person\'s words: it rides the next one' };
  // Idle by its record and alive by the runner (a record not yet fixed after its process died reads
  // stopped, never resumed for this). A host's session: its host reports its status.
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  if (rec.process_status === 'idle' && (rec.host || sessionRunner.holdsLiveSession(sid))) {
    // What the user sees (the derived status, user-status.ts) decides, and a snooze holds it off his board.
    const { snoozedUntil } = await import('../snooze.js');
    const heldForUser = task?.user_status?.state === 'needs' ? NEED_ACTION_WAIT_WHY : task && snoozedUntil(task) ? SNOOZED_WAIT_WHY : undefined;
    return { act: 'deliver', rec, ...(heldForUser ? { heldForUser } : {}) };
  }
  return { act: 'wait', why: STOPPED_WAIT_WHY };
}

/**
 * Can a quiet turn carry the notes (sessions/quiet-turn.ts: it moves no phase, marks nothing unread,
 * runs no turn-end hook)? A Claude CLI judged here, between turns, with no prompt open, no other
 * quiet turn and nothing else in its queue (a row in line with it drops the quiet row).
 */
async function quietCarries(rec: SessionRecord, sid: string): Promise<boolean> {
  if (rec.lane || rec.provider === 'embedded' || isAcpEngine(rec.engine) || rec.pendingPermission) return false;
  const [{ judgedHereRecords }, { quietTurnKind }, { getQueue }, { isColdHold }] = await Promise.all([
    import('./judge-of.js'), import('./quiet-turn.js'), import('../session-message-queue.js'), import('./cold-hold.js'),
  ]);
  if (!judgedHereRecords([rec]).length || quietTurnKind(sid)) return false;
  return !(await getQueue(sid)).some((m) => m.status === 'pending' || m.status === 'processing' || isColdHold(m));
}

/** The words the delivery carries behind the notes. */
function deliveryNote(minutes: number): string {
  return `The notes above asked for no reply and waited ${minutes} minutes for this session's next message. None came, `
    + 'so Walnut delivers them now, together, in one message. Nothing waits on an answer.';
}

let quietListening = false;

/**
 * A quiet line whose quiet turn ended before it went out (another send, a turn the CLI began by
 * itself, its time ran out) is a normal row now (quiet-turn.ts KEPT_QUIET_ROW_PREFIX): asked to go
 * as one. A restart's (its quiet turn forgotten) goes with the runner's boot recovery of pending rows.
 */
async function listenQuietEnds(): Promise<void> {
  if (quietListening) return;
  quietListening = true;
  const qt = await import('./quiet-turn.js');
  qt.addQuietTurnEndListener((end) => {
    if (end.delivered || !end.rowId || !qt.isKeptQuietRowId(end.rowId)) return;
    void (async () => {
      const { getQueue } = await import('../session-message-queue.js');
      if (!(await getQueue(end.sessionId)).some((m) => m.id === end.rowId && m.status === 'pending')) return;
      const { bus, EventNames } = await import('../event-bus.js');
      bus.emit(EventNames.SESSION_SEND, { sessionId: end.sessionId, message: '' }, ['session-runner'], { source: HELD_NOTES_SOURCE });
      log.session.info('held quiet notes: their quiet turn ended before the line went out; it goes as a normal message', { sessionId: end.sessionId, why: end.why });
    })().catch((err) => log.session.warn('held quiet notes: a quiet line could not be sent on as a normal one', { sessionId: end.sessionId, error: err instanceof Error ? err.message : String(err) }));
  });
}

/**
 * Deliver what waits for `sid` in ONE stored row that carries them, taken out of the hold first (in
 * the same tick as the look that found a quiet note there, so a message sent meanwhile cannot take
 * them and leave an empty wake) and marked told once that row is on disk. As a quiet turn's line
 * when one can carry it (no rider in front of it; never dropped, past its quiet turn a normal row),
 * else as a normal message. A failed send puts them back. 'none': a message carried them already.
 */
async function deliverQuiet(sid: string, rec: SessionRecord, quiet: boolean, minutes: number): Promise<'sent' | 'none'> {
  const [{ sendMessageToSession }, { buildWalnutNote }, qt] = await Promise.all([
    import('../session-message-queue.js'), import('../peers/walnut-message-tag.js'), import('./quiet-turn.js'),
  ]);
  if (quiet) await listenQuietEnds();
  if (oldestQuietAt(sid) === null) return 'none';
  const notes = await pendingHeldNotices(sid);
  if (!notes) return 'none';
  const body = `${notes.text}\n\n${buildWalnutNote(deliveryNote(minutes))}`;
  const rowId = quiet ? `${qt.KEPT_QUIET_ROW_PREFIX}held-notes-${randomUUID()}` : undefined;
  try {
    if (rowId) qt.beginQuietTurn(sid, 'held-notes', HELD_NOTES_SOURCE, Date.now(), rowId);
    const row = await sendMessageToSession(sid, body, {
      source: HELD_NOTES_SOURCE, ...(rec.taskId ? { taskId: rec.taskId } : {}),
      // Notices that ask nothing would ride again: this one goes (sessions/wake-policy.ts rowRides).
      wakeReason: `quiet notes held for the session's next message waited ${minutes} minutes`,
      ...(rowId ? { messageId: rowId, bare: true, hinted: true } : {}),
    });
    // Off the file before the lap goes on: a crash after the row is stored never sends them twice.
    await notes.markTold(row.id);
    return 'sent';
  } catch (err) {
    notes.release();
    if (rowId && qt.quietTurnRow(sid) === rowId) qt.endQuietTurn(sid, 'send-failed');
    throw err;
  }
}

/**
 * One look at the quiet notes held for each target (the cold hold's lap, every minute while any is
 * held). Only a session's or a script's note counts (goesAlone): Walnut's own wake=false notices
 * only ride. A target whose oldest such note waited COLD_HOLD_MAX_MS (by the note's own `at`, kept on
 * disk, so a restart keeps the clock):
 *  - can take a message (idle, its process alive): every notice held for it goes in ONE message,
 *    through the normal send path (session-message-queue.ts sendMessageToSession: queued, stored,
 *    retried like any), under HELD_NOTES_SOURCE (no person's input): it wakes once. As a quiet
 *    turn when one can carry it (quiet-turn.ts: the task's phase, unread mark and board do not move;
 *    its line is never dropped, and goes as a normal one if its quiet turn ends first); else as a
 *    normal message, but for a task that waits on the user (NEED_ACTION), whose notes then ride its
 *    next message (NEED_ACTION_WAIT_WHY);
 *  - runs a turn: not woken; the notes ride that turn's next message, or the first lap after it ends;
 *  - its task is COMPLETE: not woken; its notes are recorded not delivered (DROP_WHY.complete) and
 *    each sending session is told (dropParts, the drop-tell path);
 *  - is stopped (no live process): not started (STOPPED_WAIT_WHY); the org off for CEO or a VP: not woken;
 *  - is gone or replaced: the held-notices lap moves or drops what waits (whereNow).
 * What still waits says why on its notes (op_result's held_note) and is looked at again in
 * QUIET_RETRY_MS. At most QUIET_DELIVERIES_PER_LAP targets are sent to per lap. Resolves to how many
 * targets still hold such notes (the lap runs while any does). Only on the server, which keeps the file.
 */
export async function deliverDueQuietNotes(now = Date.now()): Promise<number> {
  if (!storeOpened()) return 0;
  const loading = storeLoading();
  if (loading) await loading;
  const { COLD_HOLD_MAX_MS } = await import('./cold-hold.js');
  const minutes = Math.round(COLD_HOLD_MAX_MS / 60_000);
  let changed = false;
  let sent = 0;
  for (const sid of [...held.keys()]) {
    const oldest = oldestQuietAt(sid);
    if (oldest === null) { quietRetryAt.delete(sid); continue; }
    if (now - oldest < COLD_HOLD_MAX_MS || (quietRetryAt.get(sid) ?? 0) > now) continue;
    if (sent >= QUIET_DELIVERIES_PER_LAP) break;
    try {
      const v = await quietVerdict(sid);
      if (v.act === 'leave' || v.act === 'wait') {
        setQuietWaitWhy(sid, v.act === 'wait' ? v.why : null);
        if (!(v.act === 'wait' && v.soon)) quietRetryAt.set(sid, now + QUIET_RETRY_MS);
        continue;
      }
      if (v.act === 'complete') {
        // Read again after the awaits: a message may have carried them meanwhile. Walnut's own
        // notices among them stay: they ride, with their own age limit.
        const slot = held.get(sid);
        for (const [key, h] of [...(slot ?? [])]) {
          if (!(h.parts ?? []).some((p) => goesAlone(key, p))) continue;
          slot!.delete(key);
          dropParts(sid, h.parts ?? [], DROP_WHY.complete, now);
          changed = true;
        }
        if (slot && !slot.size) held.delete(sid);
        log.session.info('held quiet notes not delivered: their target\'s task is complete', { sessionId: sid });
        continue;
      }
      const quiet = await quietCarries(v.rec, sid);
      if (!quiet && v.heldForUser) {
        setQuietWaitWhy(sid, v.heldForUser);
        quietRetryAt.set(sid, now + QUIET_RETRY_MS);
        continue;
      }
      setQuietWaitWhy(sid, null);
      if (await deliverQuiet(sid, v.rec, quiet, minutes) === 'sent') {
        sent++;
        log.session.info('held quiet notes delivered on their own: the oldest waited the max hold', { sessionId: sid, waitedMs: now - oldest, quiet });
      }
    } catch (err) {
      quietRetryAt.set(sid, now + QUIET_RETRY_MS);
      log.session.warn('held quiet notes: delivery failed; tried again later', { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (changed) await persist();
  let holding = 0;
  for (const sid of held.keys()) if (oldestQuietAt(sid) !== null) holding++;
  return holding;
}

/** Test seam: forget the delivery retries. */
export function _resetQuietDelivery(): void {
  quietRetryAt.clear();
}
