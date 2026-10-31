/**
 * A task's status change, told to everyone it concerns, in Walnut's own words (2026-10-28, the
 * user: "how can we programmatically let everyone know a task's latest status as early as
 * possible"; Main listed to the user, as fact, asks he had already done outside Walnut).
 *
 * When a task's settled status moves (the one user status, src/core/user-status.ts: its state, or
 * the kind of thing it waits on), one line of fact goes out: who, from what to what (with its ask
 * or what it waits on), when. New words alone are no move: a session rewords its ask and its wait
 * at every turn end. Never a model-written report. Who hears it:
 *
 *   - a session holding an unanswered request to the task: always;
 *   - the one node right above it (statusFollowerOf: a worker's leader, a top-level task's VP, a
 *     VP's Main), running or idle: an idle one reads it with its next message (2026-10-31, the
 *     user: updates go through the leaders one level at a time, and an idle node keeps them for
 *     its next turn). Never two levels: each node passes on what is news in its own words.
 *   The line never goes into a session by itself: it rides the session's next message
 *   (status-riding.ts, kept on disk across a restart), never a queue row of its own (a pending row is re-dispatched on a restart
 *   or a host reconnect, which would wake it). A line written into a running turn landed, often
 *   as that turn ended, as a turn of its own (2026-10-30: three of Main's turns were an agent-ack
 *   to a status line that came 0.1 to 5 s after its last words).
 *
 * Settled means it held for SETTLE_MS: a turn that only re-checks a "needs you" and ends where it
 * began is no news, nor is a turn that only started. The first status seen after a start, and every
 * move in the first BOOT_QUIET_MS (a restart's sessions coming back), is the baseline. Primary only.
 */
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import type { SessionRecord, Task } from '../types.js';
import { fallbackUserState, stateWord, type UserState, type UserStatus } from '../user-status.js';
import { statusMark } from './brief-fresh.js';
import { loadRiding, pendingRiding, pruneRiding, pushBody, rideLine, statusText, stopRiding } from './status-riding.js';

export { pushBody, statusText };

const SUBSCRIBER = 'status-push';
export const SETTLE_MS = 90_000;
const WORDS_MAX = 160;

interface Seen { key: string; label: string; words: string; state: UserState; snoozed?: boolean }
interface Change {
  taskId: string; title: string; from: Seen; to: Seen; at: number;
  /** A re-check turn of a "needs you" runs (sessions/needs-recheck.ts): its Working is not news
   *  until this (ms), and the turn's end decides what changed. */
  holdUntil?: number;
}

/** After a start, statuses move in bulk (sessions a restart killed, then resumed): that is
 *  Walnut catching up, not news, so the baseline follows silently for this long. */
const BOOT_QUIET_MS = 10 * 60_000;
let quietUntil = 0;

/** How long a re-check turn's Working is held back at most: its end decides what changed. */
const RECHECK_HOLD_MS = 2 * 60 * 60_000;
/** How long a Brief refresh turn's Working is held back at most. */
const REFRESH_HOLD_MS = 30 * 60_000;

const baseline = new Map<string, Seen>();
const pending = new Map<string, Change>();
let timer: ReturnType<typeof setTimeout> | null = null;
let live = false;

function clip(s: string | undefined): string {
  const flat = (s ?? '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(flat);
  return chars.length > WORDS_MAX ? `${chars.slice(0, WORDS_MAX - 1).join('')}…` : flat;
}

/** What of a status is news: its state, what it asks the user, on whom it waits. */
export function seenOf(task: Pick<Task, 'phase' | 'status' | 'user_status'>): Seen {
  const done = task.phase === 'COMPLETE' || task.status === 'done';
  const s: UserStatus | undefined = done ? undefined : task.user_status ?? undefined;
  const state: UserState = done ? 'done' : s?.state ?? fallbackUserState(task.phase, task.status);
  const words = state === 'needs' ? clip(s?.ask) : state === 'waiting' ? clip(s?.waitingOn) : '';
  const label = stateWord(state, !!s?.snoozed) + (state === 'waiting' && s?.kind && s.kind !== 'other' ? ` (${s.kind === 'you' ? 'on you' : s.kind === 'task' ? 'on another task' : s.kind === 'lead' ? 'on its lead' : s.kind})` : '');
  return { key: statusMark(task), label, words, state, ...(s?.snoozed ? { snoozed: true } : {}) };
}

function hhmm(ms: number): string {
  return `${new Date(ms).toISOString().slice(11, 16)} UTC`;
}

/** The one line of fact for a change. */
export function changeLine(c: Change): string {
  const title = clip(c.title).replace(/"/g, "'");
  let line = `- "${title}" (${c.taskId}): ${c.from.label} → ${c.to.label} at ${hhmm(c.at)}.`;
  if (c.to.state === 'needs' && c.to.words) line += ` It asks the user: "${c.to.words}".`;
  else if (c.from.state === 'needs' && c.from.words) line += ` It no longer asks the user: "${c.from.words}".`;
  else if (c.to.state === 'waiting' && c.to.words) line += ` Waiting on: ${c.to.words}.`;
  return line;
}

function note(task: Task, now = Date.now()): void {
  // A plugin's own task (a test run's included) is no one's team: nobody follows it.
  if (task.plugin_only) return;
  // Between a turn's end and its report the status says nothing yet: the report decides.
  if (task.user_status?.transient && task.phase !== 'COMPLETE' && task.status !== 'done') return;
  const next = seenOf(task);
  const was = baseline.get(task.id);
  if (!was || now < quietUntil) { baseline.set(task.id, next); return; }
  const open = pending.get(task.id);
  if (next.key === was.key && !open) return;
  const recheckAt = Date.parse(task.needs_recheck?.at ?? '');
  const from = open?.from ?? was;
  const recheckTurn = next.state === 'working' && from.state === 'needs' && Number.isFinite(recheckAt) && now - recheckAt < RECHECK_HOLD_MS;
  // A Brief refresh turn the user's look started (brief-refresh.ts) is the same: its end decides.
  const refreshAt = Date.parse(task.brief_refresh?.at ?? '');
  const refreshTurn = next.state === 'working' && from.state !== 'working' && Number.isFinite(refreshAt) && now - refreshAt < REFRESH_HOLD_MS;
  const holdUntil = recheckTurn ? recheckAt + RECHECK_HOLD_MS : refreshTurn ? refreshAt + REFRESH_HOLD_MS : undefined;
  pending.set(task.id, { taskId: task.id, title: task.title, from, to: next, at: now, ...(holdUntil ? { holdUntil } : {}) });
  baseline.set(task.id, next);
  if (!timer && live) {
    timer = setTimeout(() => { timer = null; void flushStatusPush(); }, SETTLE_MS);
    timer.unref?.();
  }
}

function onEvent(event: BusEvent): void {
  const task = (event.data as { task?: Task } | undefined)?.task;
  if (!task?.id) return;
  if (event.name === EventNames.TASK_DELETED) { baseline.delete(task.id); pending.delete(task.id); return; }
  note(task);
}

async function liveSession(taskId: string): Promise<SessionRecord | null> {
  const { getSessionsForTask, isListableSession } = await import('../session-tracker.js');
  const { addressable, bestFirst, isLive } = await import('./reply-routing.js');
  const rows = (await getSessionsForTask(taskId).catch(() => [])).filter((s) => addressable(s, isListableSession) && isLive(s));
  // A running turn first: an idle session newer than it would hide the one that can hear now.
  return rows.find((s) => s.process_status === 'running') ?? rows.sort(bestFirst)[0] ?? null;
}

/**
 * Who hears a task's status move: the one node right above it (2026-10-31, the user: updates go
 * through the leaders, one level at a time). A worker's leader; a top-level task's VP (its
 * project's lead), or Main when no VP leads its project; a VP's Main; Main, nobody. Each node
 * passes on what it judges news in its own words, so no node hears the same change twice.
 * In order of who should hear it: the push takes the first that is open and has a session, so a
 * worker whose leader completed (a parent may close with open subtasks) or has no session is
 * heard by the next one up, never by no one.
 */
export function statusFollowersOf(
  task: Pick<Task, 'id' | 'org_role' | 'parent_task_id'>,
  byId: ReadonlyMap<string, Task>,
  vpOf: (task: Task) => Task | undefined,
  main: Task | undefined,
): Task[] {
  if (task.org_role === 'main') return [];
  const out: Task[] = [];
  const seen = new Set<string>([task.id]);
  const push = (t: Task | undefined): void => { if (t && !seen.has(t.id)) { seen.add(t.id); out.push(t); } };
  if (task.org_role !== 'lead') {
    let top: Task = task as Task;
    for (let id = task.parent_task_id; id && !seen.has(id);) {
      const parent = byId.get(id);
      if (!parent) break;
      push(parent);
      // An org node above (a VP, Main): the chain goes on from it, as its own move would.
      if (parent.org_role) {
        if (parent.org_role !== 'main') push(main);
        return out;
      }
      top = parent;
      id = parent.parent_task_id;
    }
    push(vpOf(top));
  }
  push(main);
  return out;
}

const openTask = (t: Task | undefined): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done';

/** Who leads what, for statusFollowersOf: the tasks by id, each project's open VP, the open Main. */
export async function followContext(all: readonly Task[]): Promise<{
  byId: Map<string, Task>; vpOf: (task: Task) => Task | undefined; main: Task | undefined;
}> {
  const byId = new Map(all.map((t) => [t.id, t] as const));
  const main = all.find((t) => t.org_role === 'main' && openTask(t));
  const { projectKey } = await import('../org/org-tree.js');
  const vpOf = (task: Task): Task | undefined => all.find((t) => t.org_role === 'lead' && openTask(t) && t.id !== task.id
    && [t.project, ...(t.org_leads ?? [])].some((p) => projectKey(p) === projectKey(task.project)));
  return { byId, vpOf, main };
}

/** A task's live session (running first, else the best idle one), or null. */
export async function followerSession(taskId: string): Promise<SessionRecord | null> {
  return liveSession(taskId);
}

/** The first of them. Exported for tests. */
export function statusFollowerOf(
  task: Pick<Task, 'id' | 'org_role' | 'parent_task_id'>,
  byId: ReadonlyMap<string, Task>,
  vpOf: (task: Task) => Task | undefined,
  main: Task | undefined,
): Task | undefined {
  return statusFollowersOf(task, byId, vpOf, main)[0];
}

/** Send what settled. Exported for tests. */
export async function flushStatusPush(now = Date.now()): Promise<number> {
  // Ride-along items nobody's message picked up in days are dropped here too.
  pruneRiding(now);
  const due = [...pending.values()].filter((c) => (now - c.at >= SETTLE_MS && !(c.holdUntil && now < c.holdUntil)) || !live);
  for (const c of due) pending.delete(c.taskId);
  // News is a move of the state or of the kind of wait. Settled where it began (a re-check
  // turn), only reworded (a session words its ask or its wait anew every turn: 2026-10-29 on
  // prod, "Waiting → Waiting" lines every few minutes), or a turn that only started (its end
  // says where it went): no news. Working after Needs you is: the user did it.
  const news = due.filter((c) => c.from.label !== c.to.label
    && !(c.to.state === 'working' && c.from.state !== 'needs'));
  if (pending.size && live && !timer) {
    timer = setTimeout(() => { timer = null; void flushStatusPush(); }, SETTLE_MS);
    timer.unref?.();
  }
  if (news.length === 0) return 0;
  try {
    const { listTasks } = await import('../task-manager.js');
    const all = await listTasks();
    const { byId, vpOf, main } = await followContext(all);
    const { pendingRequestsForTarget } = await import('../session-requests.js');
    // recipient session id → { record or null (an asker found by its request), lines by task }
    const out = new Map<string, { rec: SessionRecord | null; lines: Map<string, { line: string; at: number }>; asker: boolean }>();
    const add = (sid: string, rec: SessionRecord | null, taskId: string, line: string, asker: boolean, at: number) => {
      const slot = out.get(sid) ?? { rec, lines: new Map<string, { line: string; at: number }>(), asker };
      slot.lines.set(taskId, { line, at });
      slot.asker ||= asker;
      slot.rec ??= rec;
      out.set(sid, slot);
    };
    for (const c of news) {
      const task = byId.get(c.taskId);
      if (!task) continue;
      const line = changeLine(c);
      const own = new Set((await (await import('../session-tracker.js')).getSessionsForTask(task.id).catch(() => [])).map((s) => s.claudeSessionId));
      for (const r of await pendingRequestsForTarget({ taskId: task.id }).catch(() => [])) {
        if (!own.has(r.fromSessionId)) add(r.fromSessionId, null, task.id, line, true, c.at);
      }
      // One level up only (statusFollowersOf: the nearest open node with a session), riding its
      // next message whether it runs now or not. Snoozed (snooze.ts): a VP or Main, who bring news
      // to the user, hears nothing of it until the snooze runs out, when the move out of it is the
      // news. A leader still hears (the team's own work goes on), and so does a session waiting on
      // its reply.
      for (const f of statusFollowersOf(task, byId, vpOf, main)) {
        if (!openTask(f)) continue;
        if (c.to.snoozed && f.org_role) break;
        const rec = await liveSession(f.id);
        if (!rec) continue;
        if (!own.has(rec.claudeSessionId)) add(rec.claudeSessionId, rec, task.id, line, false, c.at);
        break;
      }
    }
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    let sent = 0;
    for (const [sid, slot] of out) {
      const rec = slot.rec ?? await getSessionByClaudeId(sid).catch(() => null);
      if (!rec?.taskId || !openTask(byId.get(rec.taskId))) continue;
      try {
        // The lines ride its next message (pendingStatusNote), never a turn of their own; one whose
        // move a notice already told this session (org-follow.ts) is not said again.
        for (const [id, { line, at }] of slot.lines) rideLine(sid, id, line, now, at);
        sent++;
      } catch (err) {
        log.session.warn('status push not delivered', { sessionId: sid, error: err instanceof Error ? err.message : String(err) });
      }
    }
    if (sent) log.session.info('status changes pushed', { tasks: news.map((c) => c.taskId), recipients: sent });
    return sent;
  } catch (err) {
    log.session.warn('status push failed', { error: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

/** The status lines waiting for a session's next message (session-message-queue.ts
 *  sendMessageToSession), or null. `markTold` once the message holding them is queued. */
export function pendingStatusNote(sessionId: string, now = Date.now()): { text: string; markTold: () => void } | null {
  return pendingRiding(sessionId, now);
}

/**
 * One line for a session about work it handed on: now when its turn runs, else riding its next
 * message, never a wake (the note of a reply that went past it to the original asker,
 * reply-handoff.ts). `key` keeps one line per subject. Never throws.
 */
export async function tellOrRide(sessionId: string, key: string, line: string, now = Date.now()): Promise<'told' | 'riding' | 'none'> {
  try {
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const rec = await getSessionByClaudeId(sessionId).catch(() => null);
    if (!rec) return 'none';
    if (rec.process_status === 'running') {
      const { deliverToSession } = await import('./session-send-core.js');
      const text = statusText([line]);
      await deliverToSession(rec, { busText: text, enqueueText: text, source: 'walnut-notify', ...(rec.taskId ? { taskId: rec.taskId } : {}) });
      return 'told';
    }
    rideLine(sessionId, key, line, now);
    return 'riding';
  } catch (err) {
    log.session.warn('status note not delivered', { sessionId, error: err instanceof Error ? err.message : String(err) });
    return 'none';
  }
}

/** Start (server boot, primary only): every task's status now is the baseline. Idempotent. */
export async function startStatusPush(opts: { quietMs?: number } = {}): Promise<void> {
  live = true;
  // What an idle node had not read before the restart still rides its next message.
  const kept = await loadRiding();
  if (kept) log.session.info('status push: ride-along items kept across the restart', { items: kept });
  quietUntil = Date.now() + (opts.quietMs ?? BOOT_QUIET_MS);
  try {
    const { listTasks } = await import('../task-manager.js');
    for (const t of await listTasks()) if (!baseline.has(t.id)) baseline.set(t.id, seenOf(t));
  } catch (err) {
    log.session.warn('status push: baseline not read', { error: err instanceof Error ? err.message : String(err) });
  }
  bus.subscribe(SUBSCRIBER, onEvent, {
    global: true,
    interest: [EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED, EventNames.TASK_DELETED],
  });
}

export function stopStatusPush(): void {
  live = false;
  bus.unsubscribe(SUBSCRIBER);
  if (timer) clearTimeout(timer);
  timer = null;
  baseline.clear();
  pending.clear();
  stopRiding();
}

/** Test seam: a line waiting for a session's next message. */
export function _rideForTest(sessionId: string, taskId: string, line: string): void {
  rideLine(sessionId, taskId, line);
}

/** Test seam. */
export function _pendingStatusPush(): Change[] {
  return [...pending.values()];
}
