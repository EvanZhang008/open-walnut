/**
 * The server's copy of every running session's live action (core/live-activity.ts), and the
 * one event that carries it: `session:live-activity` {sessionId, taskId, activity | null}.
 *
 * Cheap by construction (CLAUDE.md, the event-bus fan-out stall): the session runner reports
 * only when the action CHANGED (a new tool call, a tool's result, the first token of text after
 * a tool), never per token, and this module sends at most one event per session every
 * THROTTLE_MS, the latest state winning. A turn's end clears at once. Durations are the
 * reader's to compute from the timestamps, so nothing is sent just because time passed.
 *
 * In memory only: after a restart a running session reports again at its next action, and a
 * reader that finds nothing shows the task's own words as before.
 */
import { bus, EventNames } from '../event-bus.js';
import type { LiveActivity } from '../live-activity.js';

export const LIVE_ACTIVITY_THROTTLE_MS = 5_000;

interface Entry {
  taskId?: string;
  activity: LiveActivity | null;
  lastEmitAt: number;
  /** What the last event carried, to skip a send that would change nothing. */
  lastSent: string;
  timer?: ReturnType<typeof setTimeout>;
}

const entries = new Map<string, Entry>();
let listening = false;

function emit(sessionId: string, e: Entry, now: number): void {
  if (e.timer) { clearTimeout(e.timer); e.timer = undefined; }
  const body = JSON.stringify(e.activity);
  if (body === e.lastSent) return;
  e.lastSent = body;
  e.lastEmitAt = now;
  // `taskActivity` is the task's own line (its newest running session's), so a reader keyed by
  // task never lets one session's end clear, or flip between, another's (two sessions of a task).
  bus.emit(EventNames.SESSION_LIVE_ACTIVITY, {
    sessionId, taskId: e.taskId ?? null, activity: e.activity,
    taskActivity: e.taskId ? liveActivityForTask(e.taskId) ?? null : e.activity,
  }, ['web-ui', 'mobile-events-feed'], { source: 'session-runner' });
}

/** The session runner's report: its action changed (null: no turn runs any more). */
export function reportLiveActivity(sessionId: string, taskId: string | undefined, activity: LiveActivity | null, now = Date.now()): void {
  listen();
  let e = entries.get(sessionId);
  if (!activity) {
    if (!e) return;
    e.activity = null;
    emit(sessionId, e, now);
    entries.delete(sessionId);
    return;
  }
  if (!e) {
    e = { activity, lastEmitAt: 0, lastSent: 'null', ...(taskId ? { taskId } : {}) };
    entries.set(sessionId, e);
  } else {
    e.activity = activity;
    if (taskId) e.taskId = taskId;
  }
  const wait = e.lastEmitAt + LIVE_ACTIVITY_THROTTLE_MS - now;
  if (wait <= 0) { emit(sessionId, e, now); return; }
  if (e.timer) return;
  const entry = e;
  entry.timer = setTimeout(() => {
    entry.timer = undefined;
    if (entries.get(sessionId) === entry) emit(sessionId, entry, Date.now());
  }, wait);
  entry.timer.unref?.();
}

/** A session whose process went away carries no live action, whoever saw it stop. */
function listen(): void {
  if (listening) return;
  listening = true;
  bus.subscribe('live-activity', (event) => {
    const d = event.data as { sessionId?: string; process_status?: string } | undefined;
    if (!d?.sessionId || !entries.has(d.sessionId)) return;
    // The runner clears its own (synchronously, at the status it reports), so its events are
    // skipped here: committed later, one could land after the next turn already reported. A
    // stopped or failed process seen by someone else (the daemon's snapshot, the health
    // monitor) clears it. Never `session:ended`: the server sends that at EVERY turn's result,
    // which would wipe a background command's line, or a queued next turn's.
    if (event.source === 'session-runner') return;
    if (d.process_status === 'stopped' || d.process_status === 'error') {
      reportLiveActivity(d.sessionId, undefined, null);
    }
  }, { global: true, interest: [EventNames.SESSION_STATUS_CHANGED] });
}

/** The live action of a task: its newest running session's. */
export function liveActivityForTask(taskId: string): LiveActivity | undefined {
  let best: LiveActivity | undefined;
  for (const e of entries.values()) {
    if (e.taskId !== taskId || !e.activity) continue;
    if (!best || e.activity.since > best.since) best = e.activity;
  }
  return best;
}

/** Every task's live action, for a reader's first load (GET /api/live-activity). */
export function liveActivityByTask(): Record<string, LiveActivity> {
  const out: Record<string, LiveActivity> = {};
  for (const e of entries.values()) {
    if (!e.taskId || !e.activity) continue;
    const prev = out[e.taskId];
    if (!prev || e.activity.since > prev.since) out[e.taskId] = e.activity;
  }
  return out;
}

/** A v1 task row with its live action (`live_activity`, additive: an older phone ignores it).
 *  Never part of the stored projection, which a replica imports as its own rows. */
export function withLiveActivity<T extends { id: string; phase?: string }>(row: T, byTask?: Record<string, LiveActivity>): T & { live_activity?: LiveActivity } {
  if (entries.size === 0 || row.phase === 'COMPLETE') return row;
  const live = byTask ? byTask[row.id] : liveActivityForTask(row.id);
  return live ? { ...row, live_activity: live } : row;
}

/** `withLiveActivity` for a whole list: the registry is read once, not once per row. */
export function withLiveActivityAll<T extends { id: string; phase?: string }>(rows: T[]): (T & { live_activity?: LiveActivity })[] {
  if (entries.size === 0) return rows;
  const byTask = liveActivityByTask();
  return rows.map((r) => withLiveActivity(r, byTask));
}

/** Test seam. */
export function resetLiveActivity(): void {
  for (const e of entries.values()) if (e.timer) clearTimeout(e.timer);
  entries.clear();
  listening = false;
}
