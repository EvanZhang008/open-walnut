/**
 * A watch on a task: "tell me where it stands at least every 30 minutes" (2026-10-31, the user:
 * a VP "can easily create a timer ... every update the task gives refreshes it ... three hours and still
 * not done? the VP asks it what its status is now ... and if it has not moved at all, no need").
 *
 * Set in one call by anyone (task_watch, PUT /api/v1/tasks/:id/watch), usually the VP or Main
 * that follows the task; `task.watch` holds who watches and how often. Every status the task gives
 * (its turn-end answer, status-question.ts) restarts the clock. When it runs out the reconcile loop
 * (status-reconcile.ts) looks: a task with no live session, or idle with a status that covers its
 * last turn, has nothing new and the clock restarts quietly; otherwise Walnut asks the task the
 * status side question (mid-turn too: a long turn is what a watch is for) and its answer rides the
 * watcher's next message (status-riding.ts), one item per task, never a wake. A completion ends the
 * watch (it stays on the row, inert); a watcher that completed or is gone removes it.
 */
import { log } from '../../logging/index.js';
import type { Task } from '../types.js';
import { isAcpEngine } from '../agents/engine-registry.js';

export interface TaskWatch {
  /** The task whose session hears the answers. */
  by: string;
  by_name?: string;
  every_ms: number;
  set_at: string;
  /** The last time the clock ran out (asked, or found nothing new). */
  polled_at?: string;
}

export const WATCH_MIN_MS = 10 * 60_000;
export const WATCH_MAX_MS = 7 * 24 * 60 * 60_000;
/** At most this many watch asks per pass. */
const WATCH_PER_PASS = 4;

/** "30m", "3h", "1d" (or ms) to ms within the bounds; throws on anything else. Pure. */
export function parseWatchEvery(raw: unknown): number {
  const text = typeof raw === 'number' ? String(raw) : typeof raw === 'string' ? raw.trim() : '';
  const m = /^(\d+(?:\.\d+)?)\s*(m|h|d)?$/i.exec(text);
  if (!m) throw new Error('every must be a duration like "30m", "3h" or "1d"');
  const unit = { m: 60_000, h: 3_600_000, d: 86_400_000 }[(m[2] ?? 'm').toLowerCase() as 'm' | 'h' | 'd'];
  const ms = Math.round(Number(m[1]) * unit);
  if (ms < WATCH_MIN_MS || ms > WATCH_MAX_MS) throw new Error('every must be between 10 minutes and 7 days');
  return ms;
}

const parse = (iso: string | undefined | null): number => {
  const ms = Date.parse(iso ?? '');
  return Number.isFinite(ms) ? ms : 0;
};

/** When the watch runs out next (ms), or null when it is over. Pure. */
export function watchDueAt(task: Pick<Task, 'watch' | 'status_report' | 'completed_at' | 'phase' | 'status'>): number | null {
  const w = task.watch;
  if (!w) return null;
  // A completion after it was set ends it, a reopen included: the watcher sets a new one.
  if (task.phase === 'COMPLETE' || task.status === 'done' || parse(task.completed_at) >= parse(w.set_at)) return null;
  const last = Math.max(parse(w.set_at), parse(w.polled_at), parse(task.status_report?.at));
  return last + w.every_ms;
}

/** The line the watcher reads. Pure. */
export function watchLine(task: Pick<Task, 'id' | 'title' | 'status_report' | 'user_status'>, nowMs: number): string {
  const r = task.status_report;
  const state = task.user_status?.state ?? r?.state ?? 'unknown';
  const words = [r?.ask && state === 'needs' ? `It asks the user: "${r.ask}".` : '', r?.now ? `Now: ${r.now}` : '', r?.next ? `Next: ${r.next}` : '']
    .filter(Boolean).join(' ');
  const title = task.title.replace(/\s+/g, ' ').slice(0, 120).replace(/"/g, "'");
  return `- Your watch on "${title}" (${task.id}) ran out at ${new Date(nowMs).toISOString().slice(11, 16)} UTC and Walnut asked it: ${state}.${words ? ` ${words}` : ''}`;
}

/** The line when the task gave no status when asked. Pure. */
export function watchSilentLine(task: Pick<Task, 'id' | 'title' | 'status_report' | 'user_status'>, nowMs: number): string {
  const title = task.title.replace(/\s+/g, ' ').slice(0, 120).replace(/"/g, "'");
  const last = task.status_report?.at ? ` Its last status, from ${task.status_report.at.slice(0, 16)}Z: ${task.user_status?.state ?? task.status_report.state}.` : '';
  return `- Your watch on "${title}" (${task.id}) ran out at ${new Date(nowMs).toISOString().slice(11, 16)} UTC; it gave no status when Walnut asked.${last} task_history shows its record.`;
}

/** One pass over the watched tasks. Returns the ids asked. Called by the reconcile loop. */
export async function runWatchPass(nowMs = Date.now()): Promise<string[]> {
  const asked: string[] = [];
  const { listTasks, updateTaskRaw, getTask } = await import('../task-manager.js');
  const all = await listTasks();
  const byId = new Map(all.map((t) => [t.id, t] as const));
  const due = all.filter((t) => { const at = watchDueAt(t); return at !== null && at <= nowMs; });
  if (due.length === 0) return asked;
  const { getSessionsForTask } = await import('../session-tracker.js');
  const { sessionRunner } = await import('../../providers/claude-code-session.js');
  const { statusMissed } = await import('./status-reconcile.js');
  const { askStatus, statusAskInFlight } = await import('./status-question.js');
  const { followerSession } = await import('./status-push.js');
  const { rideLine } = await import('./status-riding.js');
  const polled = async (id: string): Promise<void> => {
    await updateTaskRaw(id, (cur) => (cur.watch ? { watch: { ...cur.watch, polled_at: new Date(nowMs).toISOString() } } : {}), {
      emitEvent: false, source: 'task-watch', shouldUpdate: (cur) => !!cur.watch && cur.phase !== 'COMPLETE' && cur.status !== 'done',
    }).catch(() => undefined);
  };
  for (const task of due) {
    const w = task.watch!;
    const watcher = byId.get(w.by);
    // Its watcher is gone or finished: nobody reads it any more, so the watch ends.
    if (!watcher || watcher.phase === 'COMPLETE' || watcher.status === 'done') {
      await updateTaskRaw(task.id, { watch: null }, { emitEvent: false, source: 'task-watch' }).catch(() => undefined);
      continue;
    }
    if (asked.length >= WATCH_PER_PASS) break;
    // The org is off (org/org-enabled.ts): a watch Main or a VP keeps asks nothing and tells it nothing.
    if (watcher.org_role === 'main' || watcher.org_role === 'lead') {
      const { isOrgEnabled } = await import('../org/org-enabled.js');
      if (!(await isOrgEnabled())) { await polled(task.id); continue; }
    }
    // Nowhere to tell the answer yet (the watcher's session is stopped): the clock restarts, no ask spent.
    const rec = await followerSession(watcher.id);
    if (!rec) { await polled(task.id); continue; }
    // Its status line never crosses an incoming-item area (router/context-sharing.ts), to the
    // watcher's task or to the session that would read it: no ask is spent, nothing rides.
    const { mayShareTaskContext } = await import('../router/context-sharing.js');
    const sharable = await mayShareTaskContext(task.id, watcher.id).catch(() => false)
      && (rec.taskId === watcher.id || await mayShareTaskContext(task.id, rec.taskId).catch(() => false));
    if (!sharable) {
      log.session.info('task watch: watcher is outside the task\'s area, nothing asked or told', { taskId: task.id, watcher: w.by });
      await polled(task.id);
      continue;
    }
    const sessions = (await getSessionsForTask(task.id).catch(() => [])).filter((s) => !s.archived);
    const live = sessions.find((s) => s.process_status === 'running') ?? sessions.find((s) => s.process_status === 'idle');
    // An ACP engine answers a hidden ask with a turn of its own, and a chat lane has no status.
    if (live && (isAcpEngine(live.engine) || live.lane?.startsWith('chat:'))) { await polled(task.id); continue; }
    const running = live ? sessionRunner.isTurnRunning(live.claudeSessionId) || live.process_status === 'running' : false;
    // Nothing running and nothing new since its last word: nothing to ask.
    if (!live || (!running && statusMissed(task, live, nowMs) === null)) { await polled(task.id); continue; }
    // A status ask of it is on its way now (its turn just ended): that answer is the news; next tick.
    if (statusAskInFlight(live.claudeSessionId)) continue;
    if (!(await sessionRunner.getOrAttachLiveSession(live.claudeSessionId).catch(() => undefined))) { await polled(task.id); continue; }
    asked.push(task.id);
    await polled(task.id);
    log.session.info('task watch ran out: asking its status', { taskId: task.id, watcher: w.by, everyMs: w.every_ms, running });
    const stored = await askStatus(task.id, live.claudeSessionId, nowMs, 'watch');
    const fresh = await getTask(task.id).catch(() => task);
    rideLine(rec.claudeSessionId, task.id, stored ? watchLine(fresh, nowMs) : watchSilentLine(fresh, nowMs), nowMs);
  }
  return asked;
}
