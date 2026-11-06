/**
 * What is left of the start queue (2026-11-06, the user: "if it did not start, it must be an
 * error ... it is a sync call: did it start or not? ... if it fails it fails, and the VP gets the
 * message directly and can fix it"). A start no host has room for is an error to its caller now
 * (task-start.ts), so nothing is queued any more. The starts an older Walnut queued
 * (`Task.start_queue`) are each started once for real, as their asker asked them, or failed
 * loudly: the entry goes, the failure is the task's `last_start` (task_get's execution reads it),
 * and the asking session is told at once.
 *
 * Kept: an entry's task completed, its asking task completed or is gone, or it started some other
 * way since (a person's start, a newer `last_start`, a session that began after it): it is dropped
 * with nothing told. A team stop (team-stop.ts) holds its team's entries until team_resume. On the
 * task's page Start now runs an entry as the user's own start and Cancel drops it, saying so on
 * the task (src/web/routes/task-v1.ts).
 *
 * Primary only: a pass soon after boot and every few minutes (for a team resumed later). A cloud
 * companion never runs one, and an ephemeral server only touches what was queued after it booted,
 * so neither starts work it copied from the user's real data. `WALNUT_START_QUEUE=0` turns it
 * off, `=1` lets an ephemeral server run every entry.
 */

import { randomUUID } from 'node:crypto';
import type { StartQueueEntry, Task, TaskPriority } from '../types.js';
import { log } from '../../logging/index.js';
import type { SessionStartResult } from './task-start.js';

export const START_QUEUE_SOURCE = 'start-queue';
/** The first pass after boot, then one every so often for a team resumed since. */
export const START_QUEUE_FIRST_MS = 30_000;
export const START_QUEUE_INTERVAL_MS = 5 * 60_000;

const PRIORITY_RANK: Record<TaskPriority, number> = { immediate: 0, important: 1, none: 2, backlog: 3 };

type Queued = Pick<Task, 'id' | 'priority'> & { start_queue?: StartQueueEntry | null };

/** Order: priority first, then the oldest queued, then the id (a stable tie-break). */
export function queueOrder(a: Queued, b: Queued): number {
  const rank = (t: Queued) => PRIORITY_RANK[t.priority ?? 'none'] ?? PRIORITY_RANK.none;
  return rank(a) - rank(b)
    || (a.start_queue?.at ?? '').localeCompare(b.start_queue?.at ?? '')
    || a.id.localeCompare(b.id);
}

/** True when a team stop is in force on the task or one of its ancestors. Cycle-safe. */
export function heldByTeamStop(task: Pick<Task, 'id' | 'parent_task_id' | 'team_stop'>, byId: ReadonlyMap<string, Pick<Task, 'id' | 'parent_task_id' | 'team_stop'>>): boolean {
  const seen = new Set<string>();
  let cur: Pick<Task, 'id' | 'parent_task_id' | 'team_stop'> | undefined = task;
  while (cur && !seen.has(cur.id)) {
    if (cur.team_stop) return true;
    seen.add(cur.id);
    cur = cur.parent_task_id ? byId.get(cur.parent_task_id) : undefined;
  }
  return false;
}

/** Drop a task's queued start (it started, it completed, it was stopped). Never throws. */
export async function clearStartQueue(taskId: string, why: string): Promise<boolean> {
  const { updateTaskRaw } = await import('../task-manager.js');
  try {
    const res = await updateTaskRaw(taskId, (cur) => (cur.start_queue ? { start_queue: null } : null),
      { emitEvent: true, push: false, source: START_QUEUE_SOURCE });
    if (res.changed) log.session.info('queued start cleared', { taskId, why });
    return res.changed;
  } catch {
    return false;
  }
}

/**
 * The user's Start now on a queued start (the task's page): the start as it was asked, with its
 * asker's reply request, run now as the user's own start, which never waits for a slot. Null
 * when nothing is queued for the task.
 */
export async function startQueuedNow(taskId: string): Promise<SessionStartResult | null> {
  const { getTask } = await import('../task-manager.js');
  const entry = (await getTask(taskId)).start_queue;
  if (!entry) return null;
  const { startSessionForTask } = await import('./task-start.js');
  return await startSessionForTask({ ...entry.params, taskIdPrefix: taskId, callerSid: entry.caller_sid, source: START_QUEUE_SOURCE, byPerson: true, queuedAt: entry.at });
}

/**
 * The user cancelled a queued start: it goes, and the task says so where its asker reads it
 * (task_get `execution`: an error naming the cancel), so the asker does not wait for a start that
 * never comes.
 */
export async function cancelQueuedStartByPerson(taskId: string): Promise<boolean> {
  const { updateTaskRaw } = await import('../task-manager.js');
  const res = await updateTaskRaw(taskId, (cur) => (cur.start_queue ? {
    start_queue: null,
    last_start: { id: randomUUID(), at: new Date().toISOString(), state: 'failed' as const, error: 'The user cancelled this queued start; it did not run.' },
  } : null), { emitEvent: true, push: false, source: START_QUEUE_SOURCE }).catch(() => ({ changed: false }));
  if (res.changed) log.session.info('queued start cancelled by the user', { taskId });
  return res.changed;
}

/**
 * A queued start that could not start: the entry goes, the failure is the task's `last_start`
 * (unless its own start recorded one), and its asking session is told now, so it can fix it.
 */
async function failLoudly(task: Task, entry: StartQueueEntry, error: string): Promise<void> {
  const { updateTaskRaw } = await import('../task-manager.js');
  await updateTaskRaw(task.id, (cur) => {
    if (!cur.start_queue) return null;
    const recorded = !!cur.last_start && cur.last_start.at >= entry.at;
    return {
      start_queue: null,
      ...(recorded ? {} : { last_start: { id: randomUUID(), at: new Date().toISOString(), state: 'failed' as const, error } }),
    };
  }, { emitEvent: true, push: false, source: START_QUEUE_SOURCE }).catch(() => null);
  log.session.warn('queued start failed and was dropped', { taskId: task.id, askerId: entry.parent_id, error });
  try {
    const { resolveReplyDestination, isLive } = await import('./reply-routing.js');
    const destination = await resolveReplyDestination(entry.caller_sid).catch(() => null);
    if (!destination || !isLive(destination.session)) return;
    const { buildWalnutMessage } = await import('../peers/walnut-message-tag.js');
    const text = buildWalnutMessage({
      kind: 'notification',
      attrs: { from: 'Walnut', 'about-task': task.id, outcome: 'error', note: 'automated Walnut status notice' },
      body: `"${task.title}" (${task.id}), which you started and Walnut had queued since ${entry.at}, did not start: ${error}\n`
        + 'Walnut no longer queues starts: a start either starts or fails. Read task_get for it, then retry task_start with its id, or tell the user.',
    });
    const { deliverToSession } = await import('./session-send-core.js');
    await deliverToSession(destination.session, { busText: text, enqueueText: text, source: 'walnut-notify', ...(destination.session.taskId ? { taskId: destination.session.taskId } : {}) });
  } catch (err) {
    log.session.warn('queued start failure not told', { taskId: task.id, error: err instanceof Error ? err.message : String(err) });
  }
}

export interface DrainResult {
  started: string[];
  /** Dropped with nothing told: done, its asker done or gone, or started some other way. */
  dropped: string[];
  held: string[];
  /** Could not start: dropped, with the failure on the task and its asker told. */
  failed: string[];
}

let chain: Promise<unknown> = Promise.resolve();

/** Start or fail every queued start, one pass at a time. `notBefore` (ms) leaves older entries untouched. */
export function drainStartQueue(opts: { notBefore?: number } = {}): Promise<DrainResult> {
  const run = chain.then(() => drainNow(opts));
  chain = run.catch(() => {});
  return run;
}

async function drainNow(opts: { notBefore?: number }): Promise<DrainResult> {
  const out: DrainResult = { started: [], dropped: [], held: [], failed: [] };
  const { listTasks } = await import('../task-manager.js');
  const all = await listTasks();
  const byId = new Map(all.map((t) => [t.id, t] as const));
  const line = all.filter((t) => t.start_queue && (opts.notBefore === undefined || Date.parse(t.start_queue.at) >= opts.notBefore)).sort(queueOrder);
  if (!line.length) return out;
  const { getSessionsForTask, getSessionByClaudeId } = await import('../session-tracker.js');
  const { startSessionForTask, SessionExistsError, QueuedStartGoneError } = await import('./task-start.js');
  for (const t of line) {
    const entry = t.start_queue!;
    if (t.phase === 'COMPLETE') {
      await clearStartQueue(t.id, 'task complete');
      out.dropped.push(t.id);
      continue;
    }
    // Started some other way since it was queued (a person's start, a message that resumed it).
    if (t.last_start && t.last_start.at > entry.at && t.last_start.state !== 'failed') {
      await clearStartQueue(t.id, 'started since queued');
      out.dropped.push(t.id);
      continue;
    }
    // The task whose session queued it finished or is gone: nobody waits for this start any more.
    const askerTaskId = (await getSessionByClaudeId(entry.caller_sid).catch(() => null))?.taskId ?? entry.parent_id;
    const asker = byId.get(askerTaskId);
    if (!asker || asker.phase === 'COMPLETE') {
      await clearStartQueue(t.id, asker ? 'caller complete' : 'caller gone');
      out.dropped.push(t.id);
      continue;
    }
    // A session began since it was queued by a path that writes no last_start (the web's Start,
    // the phone, a quick start): a replay now would send the queued message into it again.
    const records = await getSessionsForTask(t.id).catch(() => []);
    if (records.some((r) => (r.startedAt ?? '') > entry.at)) {
      await clearStartQueue(t.id, 'session since queued');
      out.dropped.push(t.id);
      continue;
    }
    if (heldByTeamStop(t, byId)) { out.held.push(t.id); continue; }
    try {
      // Placed again: it goes to the host with room that has its files (start-placement.ts).
      await startSessionForTask({ ...entry.params, taskIdPrefix: t.id, callerSid: entry.caller_sid, source: START_QUEUE_SOURCE, queuedAt: entry.at, answerWithinMs: 110_000 });
      out.started.push(t.id);
      log.session.info('queued start started', { taskId: t.id, askerId: entry.parent_id, host: entry.host, queuedAt: entry.at });
    } catch (err) {
      // The user cancelled it while it was placed: nothing started, the cancel is on the task.
      if (err instanceof QueuedStartGoneError) { out.dropped.push(t.id); continue; }
      if (err instanceof SessionExistsError) {
        await clearStartQueue(t.id, 'already started');
        out.dropped.push(t.id);
        continue;
      }
      await failLoudly(t, entry, err instanceof Error ? err.message : String(err));
      out.failed.push(t.id);
    }
  }
  return out;
}

// ── The passes (primary only) ──

let first: ReturnType<typeof setTimeout> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let notBefore: number | undefined;
let live = false;

function drainLogged(): void {
  void drainStartQueue(notBefore !== undefined ? { notBefore } : {})
    .then((r) => {
      if (r.started.length || r.failed.length) log.session.info('start queue: old queued starts run', { started: r.started, failed: r.failed, held: r.held });
    })
    .catch((err) => log.session.warn('start queue: pass failed', { error: err instanceof Error ? err.message : String(err) }));
}

/** On the primary, after boot. */
export async function startStartQueue(opts: { ephemeral?: boolean; cloud?: boolean } = {}): Promise<{ stop(): void }> {
  const flag = process.env.WALNUT_START_QUEUE;
  if (live || opts.cloud || flag === '0') return { stop: () => {} };
  live = true;
  notBefore = opts.ephemeral && flag !== '1' ? Date.now() : undefined;
  first = setTimeout(() => { first = null; drainLogged(); }, START_QUEUE_FIRST_MS);
  first.unref?.();
  timer = setInterval(() => drainLogged(), START_QUEUE_INTERVAL_MS);
  timer.unref?.();
  return { stop: stopStartQueue };
}

export function stopStartQueue(): void {
  if (!live) return;
  live = false;
  if (first) clearTimeout(first);
  if (timer) clearInterval(timer);
  first = null;
  timer = null;
}
