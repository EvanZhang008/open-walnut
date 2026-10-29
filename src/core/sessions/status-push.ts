/**
 * A task's status change, told to everyone it concerns, in Walnut's own words (2026-10-28, the
 * user: "how can we programmatically let everyone know a task's latest status as early as
 * possible"; Main listed to the user, as fact, asks he had already done outside Walnut).
 *
 * When a task's settled status moves (the one user status, src/core/user-status.ts: its state,
 * what it asks the user, on whom it waits), one line of fact goes out: who, from what to what,
 * when. Never a model-written report. Who hears it:
 *
 *   - a session holding an unanswered request to the task: always (mid-turn when it runs, else
 *     the line rides its next message, in memory like the place note, never a queue row of its
 *     own: a pending row is re-dispatched on a restart or a host reconnect, which would wake it);
 *   - its leader, its project's VP and Main: when their session is running a turn, mid-turn.
 *     An idle one is not woken: its next message carries the same news already (the lead's team
 *     note, org/team-note.ts; Main's org update; a leader's subtask notices), and the Brief and
 *     the "needs you" list read the live status.
 *
 * Settled means it held for SETTLE_MS: a turn that only re-checks a "needs you" and ends where it
 * began is no news, nor is a turn that only started. The first status seen after a start, and every
 * move in the first BOOT_QUIET_MS (a restart's sessions coming back), is the baseline. Primary only.
 */
import { log } from '../../logging/index.js';
import { bus, EventNames, type BusEvent } from '../event-bus.js';
import type { SessionRecord, Task } from '../types.js';
import { USER_STATE_LABELS, fallbackUserState, type UserState, type UserStatus } from '../user-status.js';
import { buildWalnutMessage as buildMessage } from '../peers/walnut-message-tag.js';

const SUBSCRIBER = 'status-push';
export const SETTLE_MS = 90_000;
const WORDS_MAX = 160;

interface Seen { key: string; label: string; words: string; state: UserState }
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

const baseline = new Map<string, Seen>();
/** Asker session id -> task id -> its newest line, riding that session's next message. */
const riding = new Map<string, Map<string, { line: string; at: number }>>();
/** A ride-along line older than this is dropped unread: the live list has moved on. */
const RIDE_MAX_MS = 3 * 24 * 60 * 60_000;
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
  const label = USER_STATE_LABELS[state] + (state === 'waiting' && s?.kind && s.kind !== 'other' ? ` (${s.kind === 'you' ? 'on you' : s.kind === 'task' ? 'on another task' : s.kind === 'lead' ? 'on its lead' : s.kind})` : '');
  return { key: `${state}|${state === 'waiting' ? s?.kind ?? '' : ''}|${words}`, label, words, state };
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

export function pushBody(lines: readonly string[]): string {
  return [
    lines.length === 1 ? 'A task you follow changed its status (Walnut\'s record, not a report):' : `${lines.length} tasks you follow changed their status (Walnut's record, not a report):`,
    ...lines,
    'Read it as the live state: what the user was asked and has since done is no longer theirs to do. Nothing here asks you to act; task_get shows more.',
  ].join('\n');
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
  pending.set(task.id, { taskId: task.id, title: task.title, from, to: next, at: now, ...(recheckTurn ? { holdUntil: recheckAt + RECHECK_HOLD_MS } : {}) });
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

/** Send what settled. Exported for tests. */
export async function flushStatusPush(now = Date.now()): Promise<number> {
  // Ride-along lines nobody's message picked up in days are dropped here too.
  for (const [sid, held] of riding) {
    for (const [id, v] of held) if (now - v.at > RIDE_MAX_MS) held.delete(id);
    if (held.size === 0) riding.delete(sid);
  }
  const due = [...pending.values()].filter((c) => (now - c.at >= SETTLE_MS && !(c.holdUntil && now < c.holdUntil)) || !live);
  for (const c of due) pending.delete(c.taskId);
  // Settled where it began (a re-check turn), a "needs you" only reworded, or a turn that only
  // started (its end says where it went): no news. Working after Needs you is: the user did it.
  const news = due.filter((c) => c.from.key !== c.to.key && !(c.from.state === 'needs' && c.to.state === 'needs')
    && !(c.to.state === 'working' && c.from.state !== 'needs'));
  if (pending.size && live && !timer) {
    timer = setTimeout(() => { timer = null; void flushStatusPush(); }, SETTLE_MS);
    timer.unref?.();
  }
  if (news.length === 0) return 0;
  try {
    const { listTasks } = await import('../task-manager.js');
    const all = await listTasks();
    const byId = new Map(all.map((t) => [t.id, t] as const));
    const openTask = (t: Task | undefined): t is Task => !!t && t.phase !== 'COMPLETE' && t.status !== 'done';
    const main = all.find((t) => t.org_role === 'main' && openTask(t));
    const { projectKey } = await import('../org/org-tree.js');
    const vpOf = (task: Task): Task | undefined => all.find((t) => t.org_role === 'lead' && openTask(t) && t.id !== task.id
      && [t.project, ...(t.org_leads ?? [])].some((p) => projectKey(p) === projectKey(task.project)));
    const { pendingRequestsForTarget } = await import('../session-requests.js');
    // recipient session id → { record or null (an asker found by its request), lines by task }
    const out = new Map<string, { rec: SessionRecord | null; lines: Map<string, string>; asker: boolean }>();
    const add = (sid: string, rec: SessionRecord | null, taskId: string, line: string, asker: boolean) => {
      const slot = out.get(sid) ?? { rec, lines: new Map<string, string>(), asker };
      slot.lines.set(taskId, line);
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
        if (!own.has(r.fromSessionId)) add(r.fromSessionId, null, task.id, line, true);
      }
      const followers = [task.parent_task_id ? byId.get(task.parent_task_id) : undefined, vpOf(task), main];
      for (const f of followers) {
        if (!openTask(f) || f.id === task.id) continue;
        const rec = await liveSession(f.id);
        if (rec?.process_status === 'running' && !own.has(rec.claudeSessionId)) add(rec.claudeSessionId, rec, task.id, line, false);
      }
    }
    const { getSessionByClaudeId } = await import('../session-tracker.js');
    const { deliverToSession } = await import('./session-send-core.js');
    let sent = 0;
    for (const [sid, slot] of out) {
      const rec = slot.rec ?? await getSessionByClaudeId(sid).catch(() => null);
      if (!rec?.taskId || !openTask(byId.get(rec.taskId))) continue;
      try {
        if (rec.process_status === 'running') {
          // Lines it already waits to read go with these, once.
          const held = riding.get(sid);
          riding.delete(sid);
          const lines = new Map([...(held ? [...held].map(([id, v]) => [id, v.line] as const) : []), ...slot.lines]);
          const text = statusText([...lines.values()]);
          await deliverToSession(rec, { busText: text, enqueueText: text, source: 'walnut-notify', taskId: rec.taskId });
        } else if (slot.asker) {
          // Not running: the lines ride its next message (pendingStatusNote), never a wake.
          const held = riding.get(sid) ?? new Map<string, { line: string; at: number }>();
          for (const [id, line] of slot.lines) held.set(id, { line, at: now });
          riding.set(sid, held);
        } else continue;
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

function statusText(lines: readonly string[]): string {
  return buildMessage({
    kind: 'notification',
    attrs: { from: 'Walnut', outcome: 'status', note: 'status changes of tasks you follow, not a work request' },
    body: pushBody(lines),
  });
}

/** The status lines waiting for a session's next message (session-message-queue.ts
 *  sendMessageToSession), or null. `markTold` once the message holding them is queued. */
export function pendingStatusNote(sessionId: string, now = Date.now()): { text: string; markTold: () => void } | null {
  const held = riding.get(sessionId);
  if (!held) return null;
  for (const [id, v] of held) if (now - v.at > RIDE_MAX_MS) held.delete(id);
  if (held.size === 0) { riding.delete(sessionId); return null; }
  const snapshot = new Map(held);
  return {
    text: statusText([...snapshot.values()].map((v) => v.line)),
    markTold: () => {
      const cur = riding.get(sessionId);
      if (!cur) return;
      // Only what this message carried: a line that came meanwhile rides the next one.
      for (const [id, v] of snapshot) if (cur.get(id) === v) cur.delete(id);
      if (cur.size === 0) riding.delete(sessionId);
    },
  };
}

/** Start (server boot, primary only): every task's status now is the baseline. Idempotent. */
export async function startStatusPush(opts: { quietMs?: number } = {}): Promise<void> {
  live = true;
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
  riding.clear();
}

/** Test seam: a line waiting for a session's next message. */
export function _rideForTest(sessionId: string, taskId: string, line: string): void {
  const held = riding.get(sessionId) ?? new Map<string, { line: string; at: number }>();
  held.set(taskId, { line, at: Date.now() });
  riding.set(sessionId, held);
}

/** Test seam. */
export function _pendingStatusPush(): Change[] {
  return [...pending.values()];
}
