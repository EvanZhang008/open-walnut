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
 */
import { log } from '../../logging/index.js';
import {
  TELL_KEEP_MS, closeStore, expiredByAge, held, metaOf, openStore, persist, pruneFates, settleTells, taken,
  type DropTell, type Held,
} from './held-notices-store.js';
import {
  DROP_WHY, dropParts, holdFoldedNotice, moveHeldNotices, putBack, takeDropTells, tellUndeliverable,
} from './held-notices.js';

const SWEEP_MS = 10 * 60_000;
/** A message that took notices and said nothing for this long did not carry them. */
const TAKEN_STALE_MS = 10 * 60_000;

let timer: ReturnType<typeof setInterval> | null = null;

/** Server boot (the leader): read the file, then sweep every SWEEP_MS. Idempotent. */
export async function startHeldNotices(): Promise<void> {
  await openStore();
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
