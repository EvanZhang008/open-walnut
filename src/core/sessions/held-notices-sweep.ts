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
 * rides the sender's next message (DROP_TELL_KEY, never aged or capped out) rather than starting a
 * turn, and goes on its own like a quiet note once it waited the max hold (deliverDueQuietNotes).
 * What a gone session drops leaves a record its sender can read, but for Walnut's own status notices:
 * a note its fate; a tell (its sender's session gone too) the fates of the notes it told of; a
 * topic's fold its posts, back to the topic as unread (topic-delivery.ts returnFoldsUnread, done
 * before the drop and tried again next lap while it fails).
 *
 * A quiet note (quiet-notes.ts: a session's wake=false note, a script's no-reply note) never waits
 * past the cold hold's max (deliverDueQuietNotes, on the cold hold's lap, cold-hold.ts): once the
 * oldest held for a target waited COLD_HOLD_MAX_MS, every quiet note held for it goes in ONE message,
 * which wakes it once, when it can take one; its task complete, they are recorded not delivered and
 * their senders told. One that waits on for a reason that does not clear by itself (QUIET_WAITS: a
 * stopped session, the org off, ...) tells its sender once that it is not delivered yet, and why
 * (2026-11-24, the user: never a message lost, and its sender always told: two notes waited 6 h
 * and 16 h for stopped sessions, their senders never told). It stays held all the same.
 */
import { log } from '../../logging/index.js';
import {
  DROP_TELL_KEY, TELL_KEEP_MS, closeStore, expiredByAge, goesAlone, held, keptWhole, metaOf, oldestQuietAt, openStore, persist, pruneFates,
  setQuietWaitWhy, settleTells, storeLoading, storeOpened, taken, waitingNote, type DropTell, type Held, type TellKind,
} from './held-notices-store.js';
import {
  DROP_WHY, TELL_OUTCOME, dropParts, holdFoldedNotice, moveHeldNotices, pendingHeldNotices, putBack, renderTell, takeDropTells, tellStillWaiting,
  tellUndeliverable,
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
    if (where === 'stay') {
      goneSince.delete(sid);
      const n = await dropRidersOfComplete(sid, now);
      if (n > 0) { dropped += n; changed = true; }
      continue;
    }
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

/**
 * Walnut's own notices (those that only ride: a title-topic or status notice, a subtask's
 * completion its reply told, a request's reminder; goesAlone is false) held for a session whose task is
 * complete, once they waited the cold hold's max: dropped, recorded so (DROP_WHY.complete), as the
 * quiet notes of such a target are (lookAtQuiet). Before, they waited out the 3-day age limit
 * (2026-11-25 audit: a title-topic notice held 13.6 hours for a completed task, neither carried nor
 * dropped). A task reopened before then gets them on its next message. Returns how many went.
 */
async function dropRidersOfComplete(sid: string, now: number): Promise<number> {
  const { COLD_HOLD_MAX_MS } = await import('./cold-hold.js');
  const due = (slot: Map<string, Held> | undefined) => [...(slot ?? [])]
    // A topic's folded posts are left to the gone-session path, which returns them to the topic unread.
    // A task's own words (keptWhole) wait for their target's next message, as the age limit leaves them.
    .filter(([key, v]) => now - v.at >= COLD_HOLD_MAX_MS && !(v.parts ?? []).some((p) => goesAlone(key, p) || !!metaOf(p).topic || keptWhole(p)));
  if (due(held.get(sid)).length === 0) return 0;
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sid);
    if (!rec?.taskId) return 0;
    const { getTask } = await import('../task-manager.js');
    if ((await getTask(rec.taskId).catch(() => null))?.phase !== 'COMPLETE') return 0;
  } catch {
    return 0;
  }
  // Read again after the awaits: a message may have carried them meanwhile.
  const slot = held.get(sid);
  const go = due(slot);
  for (const [key, v] of go) {
    slot!.delete(key);
    dropParts(sid, v.parts ?? [], DROP_WHY.complete, now);
  }
  if (slot && !slot.size) held.delete(sid);
  if (go.length > 0) log.session.info('held notices dropped: their target\'s task is complete', { sessionId: sid, keys: go.map(([key]) => key) });
  return go.length;
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

export { DROP_TELL_KEY };

/**
 * Where a sender is told now: its own session while that is there, else the session its task goes
 * on with (the sender's record names the task, or the note did); else why not (`final`: its task is
 * complete, so it is never tried again). Throws when the stores cannot be read (tried again).
 */
async function tellWhere(t: DropTell): Promise<string | { why: string; final: boolean }> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(t.callerSid);
  const { getTask } = await import('../task-manager.js');
  const own = rec?.taskId ?? t.fromTask;
  // A sender whose task is complete reads nothing more: recorded once, never looped on.
  if (own && (await getTask(own).catch(() => null))?.phase === 'COMPLETE') return { why: 'its task is complete', final: true };
  if (rec && !rec.archived) return t.callerSid;
  for (const taskId of new Set([rec?.taskId, t.fromTask])) {
    if (!taskId) continue;
    const next = (await getTask(taskId).catch(() => null))?.session_id;
    const to = next && next !== t.callerSid ? await getSessionByClaudeId(next) : null;
    if (next && to && !to.archived) return next;
  }
  return { why: 'no live session of it or of its task can take the notice', final: false };
}

export { TELL_OUTCOME };

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
    // Delivered or dropped since it was queued: "not delivered yet" is no longer so (a drop has its own tell).
    if (t.kind === 'waiting' && (!t.mid || !waitingNote(t.mid))) continue;
    try {
      const where = await tellWhere(t);
      if (typeof where !== 'string') { tellUndeliverable(t, where.why, now, where.final); continue; }
      bySession.set(where, [...(bySession.get(where) ?? []), t]);
    } catch (err) {
      log.session.warn('held notices: where to tell a dropped note\'s sender could not be read; tried again later', { messageId: t.mid, error: err instanceof Error ? err.message : String(err) });
      untold.push(t);
    }
  }
  const minutes = bySession.size ? Math.round((await import('./cold-hold.js')).COLD_HOLD_MAX_MS / 60_000) : 0;
  for (const [sid, all] of bySession) {
    // Read again after the awaits: a note delivered or dropped meanwhile is not told "not delivered yet".
    const list = all.filter((t) => t.kind !== 'waiting' || (!!t.mid && !!waitingNote(t.mid)));
    if (!list.length) continue;
    try {
      // It names the notes it tells of: dropped in turn (this session gone too), their fates say so.
      const notes = list.map((t) => ({
        callerSid: t.callerSid, op: t.op, reason: t.reason, taskId: t.taskId, kind: t.kind ?? 'dropped' as TellKind,
        ...(t.mid ? { mid: t.mid } : {}), ...(t.fromTask ? { fromTask: t.fromTask } : {}),
      }));
      const text = renderTell(notes, minutes);
      const task = list.find((t) => t.fromTask)?.fromTask;
      // `minutes`: kept to render it again when one of its notes leaves it (held-notices.ts forgetWaitingTells).
      void holdFoldedNotice<{ at: number; text: string; whole: true; told: typeof notes; minutes: number; task?: string }>(sid, DROP_TELL_KEY,
        { at: now, text, whole: true, told: notes, minutes, ...(task ? { task } : {}) },
        (parts) => parts.map((p) => p.text).join('\n\n'), { now });
      told++;
      // It goes on its own once it waited the max hold, like a quiet note (goesAlone): the cold hold's lap.
      if (storeOpened()) void import('./cold-hold.js').then((m) => m.noteQuietHold()).catch(() => {});
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

/** One reason the quiet lap leaves quiet notes waiting past their max hold. */
interface QuietWait {
  /** What holds them (the sender's tell says it). */
  cause: string;
  /** What becomes of them meanwhile (op_result's held_note says `cause: then`). */
  then: string;
  /**
   * After how many max holds (COLD_HOLD_MAX_MS) of a note's wait its sender is told it is not
   * delivered yet (tellStillWaiting), or null: the wait clears by itself soon, and the note goes.
   */
  tellAfter: number | null;
  /** Looked at again the next lap, not QUIET_RETRY_MS later (a turn that runs ends soon). */
  soon?: true;
}

/**
 * Every reason the quiet lap leaves a quiet note waiting (QuietVerdict 'wait', and a delivery a
 * task that holds them for the user refuses). A new reason names whether its note's sender is told
 * after the max hold or why it clears by itself (tests/core/sessions/quiet-wait-reasons.test.ts).
 */
export const QUIET_WAITS = {
  /** A turn ends: the notes ride its next message, or go the first lap after it; one that does not end for hours tells. */
  running: {
    cause: 'its target is running a turn', then: 'it rides that turn\'s next message, or goes on its own once the turn ends',
    // A turn ends by itself; one of hours (or a status left reading running) is told after three max holds.
    tellAfter: 3, soon: true,
  },
  /** A switch or a move ends in minutes; one that lasts another max hold is told like a stopped session. */
  switching: {
    cause: 'its target\'s task is switching engine or moving', then: 'it goes with the session that carries on', tellAfter: 2,
  },
  /**
   * Starting a stopped session for notes whose senders said they need no reply costs a full run of
   * it (its whole context read again), and nothing is waiting on them (2026-11-23); held, they are
   * never lost (on disk, a task's note never ages out) and ride the session's next message, which a
   * run of the task starts with. Its task completing drops them with their senders told.
   */
  stopped: {
    cause: 'its target\'s session is stopped, and a note that asked for no reply does not start it',
    then: 'it rides that session\'s next message (the task\'s next run); send it again without wake=false to have it read now',
    tellAfter: 1,
  },
  /** With the org off, CEO and the VPs take no background message (org/org-enabled.ts). */
  orgOff: {
    cause: 'the org is off, and its target (CEO or a VP) takes no background message', then: 'it rides its next message', tellAfter: 1,
  },
  /** A router's session takes only a person's words (router/delivery-scope.ts). */
  router: { cause: 'its target takes only a person\'s words', then: 'it rides the next one', tellAfter: 1 },
  /** The task waits on the user and no quiet turn can carry them: a normal turn would move it on his board. */
  needAction: {
    cause: 'its task waits on the user and its session cannot take a quiet turn now, and a normal turn would move the task on the user\'s board',
    then: 'it rides that session\'s next message', tellAfter: 1,
  },
  /**
   * Only Walnut's tells to this session about its own notes wait (DROP_TELL_KEY), and no quiet turn
   * can carry them: a normal turn would move the task's phase and board for Walnut's own notice
   * (wake-policy.ts). They ride its next message; nobody is further to tell (op_result shows them
   * on each note's sender_told).
   */
  tellNoQuietTurn: {
    cause: 'only Walnut\'s notices to it about its own notes wait, and no quiet turn can carry them now',
    then: 'they ride its next message', tellAfter: null,
  },
  /** Reading its stores or storing the message failed: tried again every lap, its senders told once a max hold of failures went by. */
  failing: {
    cause: 'delivery to its target keeps failing', then: 'Walnut tries it again every few minutes', tellAfter: 1,
  },
  /** The task is snoozed (src/core/snooze.ts) and no quiet turn can carry them. */
  snoozed: {
    cause: 'its task is snoozed and its session cannot take a quiet turn now, and a normal turn would put it back on the user\'s board before the snooze ends',
    then: 'it rides that session\'s next message, or goes once the snooze ends', tellAfter: 1,
  },
} as const satisfies Record<string, QuietWait>;
export type QuietWaitKind = keyof typeof QUIET_WAITS;

/** What op_result's held_note says of a note that waits for this reason. */
export function waitWhy(kind: QuietWaitKind): string {
  return `${QUIET_WAITS[kind].cause}: ${QUIET_WAITS[kind].then}`;
}
export const STOPPED_WAIT_WHY = waitWhy('stopped');
export const NEED_ACTION_WAIT_WHY = waitWhy('needAction');
export const SNOOZED_WAIT_WHY = waitWhy('snoozed');

/** At most this many targets get their quiet notes in one lap: after a restart, many wakes spread over minutes. */
export const QUIET_DELIVERIES_PER_LAP = 3;
/** A target found unable to take them (or whose delivery failed) is looked at again after this. */
const QUIET_RETRY_MS = SWEEP_MS;
const quietRetryAt = new Map<string, number>();
/** When a target's look or delivery first failed, in a row: past a max hold its senders are told (QUIET_WAITS.failing). */
const failingSince = new Map<string, number>();

type QuietVerdict =
  /** `heldForUser`: why a normal turn may not carry them (the task asks the user, or is snoozed): only a quiet turn may. */
  | { act: 'deliver'; rec: SessionRecord; target: string; heldForUser?: 'needAction' | 'snoozed' }
  | { act: 'complete' }
  /** `target`: how a sender's tell names it. */
  | { act: 'wait'; wait: QuietWaitKind; target: string }
  /** Gone, archived or replaced: the held-notices lap moves what waits, or drops it told (whereNow). */
  | { act: 'leave' };

/** How a sender's tell names the target: its task's title, else its task id, else its session. */
function targetName(sid: string, taskId: string | undefined, title: string | undefined): string {
  const t = title?.replace(/\s+/g, ' ').trim().slice(0, 80);
  return t ? `"${t}"` : taskId ? `task ${taskId}` : `session ${sid}`;
}

/** What to do with the quiet notes held for `sid` now that they waited their max hold. */
async function quietVerdict(sid: string): Promise<QuietVerdict> {
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const rec = await getSessionByClaudeId(sid);
  if (!rec || rec.archived || rec.supersededBy) return { act: 'leave' };
  const { getTask } = await import('../task-manager.js');
  const task = rec.taskId ? await getTask(rec.taskId).catch(() => null) : null;
  const target = targetName(sid, rec.taskId, task?.title);
  const sw = await import('./engine-switch.js');
  if (sw.switchingFrom(sid) || sw.movingFrom({ sessionId: sid }) || (rec.taskId && sw.isSwitching(rec.taskId))) {
    return { act: 'wait', wait: 'switching', target };
  }
  const { turnRunning } = await import('./cold-hold.js');
  if (await turnRunning(sid, rec.process_status)) return { act: 'wait', wait: 'running', target };
  if (task?.phase === 'COMPLETE') return { act: 'complete' };
  const { isOrgEnabled, isOrgNode } = await import('../org/org-enabled.js');
  if (isOrgNode(task) && !(await isOrgEnabled())) return { act: 'wait', wait: 'orgOff', target };
  if (rec.profile?.areaId && rec.profile.areaRole === 'router') return { act: 'wait', wait: 'router', target };
  // Idle by its record and alive by the runner (a record not yet fixed after its process died reads
  // stopped, never resumed for this). A host's session: its host reports its status.
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  if (rec.process_status === 'idle' && (rec.host || sessionRunner.holdsLiveSession(sid))) {
    // What the user sees (the derived status, user-status.ts) decides, and a snooze holds it off his board.
    const { snoozedUntil } = await import('../snooze.js');
    const heldForUser = task?.user_status?.state === 'needs' ? 'needAction' as const : task && snoozedUntil(task) ? 'snoozed' as const : undefined;
    return { act: 'deliver', rec, target, ...(heldForUser ? { heldForUser } : {}) };
  }
  return { act: 'wait', wait: 'stopped', target };
}

/**
 * The quiet notes held for `sid` wait on for `kind`: op_result says why, and each note that waited
 * its reason's tellAfter max holds tells its sender once (tellStillWaiting), unless `mayTell` is
 * false (a failure younger than a max hold). True when a note was marked told (the file is written).
 */
function waitOn(sid: string, kind: QuietWaitKind, target: string, now: number, maxHoldMs: number, mayTell = true): boolean {
  setQuietWaitWhy(sid, waitWhy(kind));
  const { cause, tellAfter } = QUIET_WAITS[kind] as QuietWait;
  if (tellAfter === null || !mayTell) return false;
  return tellStillWaiting(sid, cause, now - tellAfter * maxHoldMs, target, now, now - maxHoldMs) > 0;
}

/** Whether all that goes alone held for `sid` is Walnut's tells to it (DROP_TELL_KEY), no quiet note. */
function onlyTells(sid: string): boolean {
  for (const [key, v] of held.get(sid) ?? []) if (key !== DROP_TELL_KEY && (v.parts ?? []).some((p) => goesAlone(key, p))) return false;
  return true;
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
    // Walnut's tells only: never a normal turn of their own; the row stays queued and rides the next one.
    if (qt.isRidingQuietRowId(end.rowId)) {
      log.session.info('held tells: their quiet turn ended before the line went out; the row rides the session\'s next message', { sessionId: end.sessionId, why: end.why });
      return;
    }
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
  // Only Walnut's tells (read in the same tick as the take): a row that never goes alone past its quiet turn.
  const tells = onlyTells(sid);
  const notes = await pendingHeldNotices(sid);
  if (!notes) return 'none';
  const body = `${notes.text}\n\n${buildWalnutNote(deliveryNote(minutes))}`;
  const rowId = quiet ? `${tells ? qt.RIDING_QUIET_ROW_PREFIX : `${qt.KEPT_QUIET_ROW_PREFIX}held-notes-`}${randomUUID()}` : undefined;
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
 * One look at the quiet notes held for `sid`, due now: deliver, drop (task complete) or wait, as its
 * verdict says. `named`: the target's name for a tell, as soon as it is known. Throws when a store
 * cannot be read or the message cannot be stored (the caller retries it).
 */
async function lookAtQuiet(
  sid: string, now: number, minutes: number, maxHoldMs: number, named: (target: string) => void,
): Promise<{ changed: boolean; sent: boolean; quiet?: boolean }> {
  const v = await quietVerdict(sid);
  if (v.act === 'leave') {
    setQuietWaitWhy(sid, null);
    quietRetryAt.set(sid, now + QUIET_RETRY_MS);
    return { changed: false, sent: false };
  }
  if (v.act === 'wait') {
    named(v.target);
    const changed = waitOn(sid, v.wait, v.target, now, maxHoldMs);
    if (!(QUIET_WAITS[v.wait] as QuietWait).soon) quietRetryAt.set(sid, now + QUIET_RETRY_MS);
    return { changed, sent: false };
  }
  if (v.act === 'complete') {
    // Read again after the awaits: a message may have carried them meanwhile. Walnut's own
    // notices among them stay: they ride, with their own age limit.
    let changed = false;
    const slot = held.get(sid);
    for (const [key, h] of [...(slot ?? [])]) {
      if (!(h.parts ?? []).some((p) => goesAlone(key, p))) continue;
      slot!.delete(key);
      // A sender's tell held here (this session is the sender's): the notes it told of record it.
      dropParts(sid, h.parts ?? [], key === DROP_TELL_KEY ? DROP_WHY.tellComplete : DROP_WHY.complete, now);
      changed = true;
    }
    if (slot && !slot.size) held.delete(sid);
    log.session.info('held quiet notes not delivered: their target\'s task is complete', { sessionId: sid });
    return { changed, sent: false };
  }
  named(v.target);
  const quiet = await quietCarries(v.rec, sid);
  // A normal turn may not carry them: the task holds them for the user, or they are only Walnut's tells.
  const holdFor: QuietWaitKind | undefined = quiet ? undefined : v.heldForUser ?? (onlyTells(sid) ? 'tellNoQuietTurn' : undefined);
  if (holdFor) {
    const changed = waitOn(sid, holdFor, v.target, now, maxHoldMs);
    quietRetryAt.set(sid, now + QUIET_RETRY_MS);
    return { changed, sent: false };
  }
  setQuietWaitWhy(sid, null);
  return { changed: false, sent: await deliverQuiet(sid, v.rec, quiet, minutes) === 'sent', quiet };
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
 * What still waits says why on its notes (op_result's held_note); a session's note that waited its
 * reason's tellAfter (QUIET_WAITS) tells its sender once it is not delivered yet, and stays held. A
 * sender's tell (DROP_TELL_KEY) goes the same way, to the sender, but only as a quiet turn (a
 * normal turn for Walnut's own notice would move the task's board: tellNoQuietTurn); targets with a
 * quiet note go before those with only tells. A look or a delivery that fails is tried again, and
 * once it has failed for a max hold its senders are told (QUIET_WAITS.failing). What waits is looked at again in
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
  // Due targets, quiet notes before tells (after a deploy many old tells fall due at once: they
  // never take the lap's sends from a note), each group oldest first.
  const due: Array<{ sid: string; oldest: number; tells: boolean }> = [];
  for (const sid of [...held.keys()]) {
    const oldest = oldestQuietAt(sid);
    if (oldest === null) { quietRetryAt.delete(sid); failingSince.delete(sid); continue; }
    if (now - oldest < COLD_HOLD_MAX_MS || (quietRetryAt.get(sid) ?? 0) > now) continue;
    due.push({ sid, oldest, tells: onlyTells(sid) });
  }
  due.sort((a, b) => Number(a.tells) - Number(b.tells) || a.oldest - b.oldest);
  for (const { sid, oldest } of due) {
    if (sent >= QUIET_DELIVERIES_PER_LAP) break;
    let target = targetName(sid, undefined, undefined);
    try {
      const out = await lookAtQuiet(sid, now, minutes, COLD_HOLD_MAX_MS, (t) => { target = t; });
      failingSince.delete(sid);
      if (out.changed) changed = true;
      if (out.sent) {
        sent++;
        log.session.info('held quiet notes delivered on their own: the oldest waited the max hold', { sessionId: sid, waitedMs: now - oldest, quiet: out.quiet });
      }
    } catch (err) {
      // Tried again every QUIET_RETRY_MS, never given up; once it has failed for a max hold its senders hear.
      quietRetryAt.set(sid, now + QUIET_RETRY_MS);
      const since = failingSince.get(sid) ?? now;
      failingSince.set(sid, since);
      // `failingSince` is in memory: the note's own age (on disk) is the backstop across restarts.
      if (waitOn(sid, 'failing', target, now, COLD_HOLD_MAX_MS, now - since >= COLD_HOLD_MAX_MS || now - oldest >= 2 * COLD_HOLD_MAX_MS)) changed = true;
      log.session.warn('held quiet notes: delivery failed; tried again later', { sessionId: sid, failingForMs: now - since, error: err instanceof Error ? err.message : String(err) });
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
  failingSince.clear();
}
