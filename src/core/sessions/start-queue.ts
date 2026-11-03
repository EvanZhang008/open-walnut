/**
 * The start queue: a session's start that the running-subtask cap (subtask-limits.ts) would
 * refuse is recorded on the task (`Task.start_queue`) and answered "queued"; Walnut starts it
 * by itself once one of the caller task's running subtasks stops running.
 *
 * Why (2026-11-03): a VP whose job is to delegate hit the cap with 17 running, read "do this
 * part with your own tools" in the refusal and ran the investigation itself, then wrote its own
 * background loops to retry the starts. A full slot now means "queued", never "do it yourself".
 *
 * Order: highest task priority first (immediate, important, unset, backlog), then the oldest
 * queued. The replay is the same start as asked, run as the asking session's start with source
 * `start-queue`; such a start is never queued again: at the cap it throws as before, and the
 * drain stops for that parent until the next slot frees.
 *
 * Lifecycle: a start through startSessionForTask clears its entry, and the drain drops one whose task
 * has a session that began after it was queued (the web's Start, the phone, a quick start); a COMPLETE
 * task's entry is dropped, and so is one whose caller task completed or is gone; a task started some other way since it was queued (its `last_start`
 * is newer) is dropped; a team stop (team-stop.ts, `team_stop` on the task or an ancestor) holds
 * the entries of its team until team_resume; a replay that fails for another reason is dropped
 * with the failure left on `last_start`, where task_get's execution reads it.
 *
 * Primary only: a loop every 30 s plus a nudge (debounced 1 s) when a subtask leaves
 * IN_PROGRESS. A cloud companion never drains, and an ephemeral server only drains what was
 * queued after it booted, so neither starts work it copied from the user's real data.
 * `WALNUT_START_QUEUE=0` turns the loop off, `=1` lets an ephemeral server drain everything.
 */

import { randomUUID } from 'node:crypto';
import type { StartQueueEntry, Task, TaskPriority } from '../types.js';
import { log } from '../../logging/index.js';
import type { RunningCapDetail } from './subtask-limits.js';
import type { SessionStartParams, SessionStartResult } from './task-start.js';

export const START_QUEUE_SOURCE = 'start-queue';
export const START_QUEUE_INTERVAL_MS = 30_000;
export const START_QUEUE_NUDGE_MS = 1_000;

const PRIORITY_RANK: Record<TaskPriority, number> = { immediate: 0, important: 1, none: 2, backlog: 3 };

type Queued = Pick<Task, 'id' | 'priority'> & { start_queue?: StartQueueEntry | null };

/** Queue order: priority first, then the oldest queued, then the id (a stable tie-break). */
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

/** The fields of a start the replay needs (the task and the caller ride the entry itself). */
function replayParams(params: SessionStartParams): StartQueueEntry['params'] {
  const out: StartQueueEntry['params'] = {};
  const keys = ['message', 'cwd', 'host', 'model', 'mode', 'effort', 'engine', 'userRequest', 'createCwd',
    'workspace', 'expectReply', 'replyTimeoutSecs', 'handsOn'] as const;
  for (const k of keys) if (params[k] !== undefined) (out as Record<string, unknown>)[k] = params[k];
  return out;
}

/** Position (1-based) of a task among the entries queued behind the same parent. */
function positionOf(taskId: string, parentId: string, tasks: readonly Task[]): number {
  const line = tasks.filter((t) => t.start_queue?.parent_id === parentId && t.phase !== 'COMPLETE').sort(queueOrder);
  const at = line.findIndex((t) => t.id === taskId);
  return at < 0 ? line.length + 1 : at + 1;
}

/**
 * Record a start the running cap refused and answer it as queued. A task queued again keeps its
 * place (its first `at`) and takes the newer start's settings. Returns null when the task is
 * COMPLETE (nothing to queue: the caller gets the refusal).
 */
export async function enqueueStart(detail: RunningCapDetail, params: SessionStartParams): Promise<SessionStartResult | null> {
  if (!params.callerSid) return null;
  const { listTasks, updateTaskRaw } = await import('../task-manager.js');
  let title = '';
  const res = await updateTaskRaw(detail.taskId, (cur) => {
    if (cur.phase === 'COMPLETE') return null;
    title = cur.title;
    const keep = cur.start_queue && cur.start_queue.parent_id === detail.parentId ? cur.start_queue.at : undefined;
    const entry: StartQueueEntry = {
      at: keep ?? new Date().toISOString(), parent_id: detail.parentId, caller_sid: params.callerSid!, params: replayParams(params),
    };
    return { start_queue: entry };
  }, { emitEvent: true, push: false, source: START_QUEUE_SOURCE });
  if (!res.changed && !title) return null;
  const position = positionOf(detail.taskId, detail.parentId, await listTasks());
  log.session.info('start queued behind running subtasks', {
    taskId: detail.taskId, parentId: detail.parentId, callerSid: params.callerSid, position, running: detail.running.length, cap: detail.cap,
  });
  return {
    taskId: detail.taskId, title, started: false, applied: [],
    queued: { position, running: detail.running, cap: detail.cap },
  };
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

/** A replay that failed for another reason than the cap: drop it, and leave the failure where task_get reads it. */
async function dropFailed(task: Task, entry: StartQueueEntry, error: string): Promise<void> {
  const { updateTaskRaw } = await import('../task-manager.js');
  await updateTaskRaw(task.id, (cur) => {
    if (!cur.start_queue) return null;
    // The start got far enough to record its own outcome: keep that one.
    const recorded = !!cur.last_start && cur.last_start.at >= entry.at;
    return {
      start_queue: null,
      ...(recorded ? {} : { last_start: { id: randomUUID(), at: new Date().toISOString(), state: 'failed' as const, error } }),
    };
  }, { emitEvent: true, push: false, source: START_QUEUE_SOURCE }).catch(() => null);
  log.session.warn('queued start failed and was dropped', { taskId: task.id, parentId: entry.parent_id, error });
}

export interface DrainResult {
  started: string[];
  dropped: string[];
  held: string[];
  /** Still queued: the cap is full again for their parent. */
  waiting: string[];
}

let chain: Promise<unknown> = Promise.resolve();

/**
 * Start what the queue holds while its parents have room, one drain at a time. `parentId`
 * limits it to one parent's queue; `notBefore` (ms) leaves entries queued earlier untouched.
 */
export function drainStartQueue(parentId?: string, opts: { notBefore?: number } = {}): Promise<DrainResult> {
  const run = chain.then(() => drainNow(parentId, opts));
  chain = run.catch(() => {});
  return run;
}

async function drainNow(parentId: string | undefined, opts: { notBefore?: number }): Promise<DrainResult> {
  const out: DrainResult = { started: [], dropped: [], held: [], waiting: [] };
  const { listTasks } = await import('../task-manager.js');
  const all = await listTasks();
  const byId = new Map(all.map((t) => [t.id, t] as const));
  const queued = all.filter((t) => t.start_queue && (!parentId || t.start_queue.parent_id === parentId));
  if (!queued.length) return out;
  const lines = new Map<string, Task[]>();
  for (const t of queued) {
    const entry = t.start_queue!;
    if (opts.notBefore !== undefined && !(Date.parse(entry.at) >= opts.notBefore)) continue;
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
    // The task that queued it finished or is gone: nobody waits for this start any more.
    const parent = byId.get(entry.parent_id);
    if (!parent || parent.phase === 'COMPLETE') {
      await clearStartQueue(t.id, parent ? 'caller complete' : 'caller gone');
      out.dropped.push(t.id);
      continue;
    }
    // A session began since it was queued by a path that writes no last_start (the web's Start, the
    // phone, a quick start): a replay now would send the queued message into that conversation again.
    const { getSessionsForTask } = await import('../session-tracker.js');
    const records = await getSessionsForTask(t.id).catch(() => []);
    if (records.some((r) => (r.startedAt ?? '') > entry.at)) {
      await clearStartQueue(t.id, 'session since queued');
      out.dropped.push(t.id);
      continue;
    }
    if (heldByTeamStop(t, byId)) { out.held.push(t.id); continue; }
    const line = lines.get(entry.parent_id) ?? [];
    line.push(t);
    lines.set(entry.parent_id, line);
  }
  const { startSessionForTask, SessionExistsError } = await import('./task-start.js');
  const { SubtaskLimitError, admitSubtaskStart } = await import('./subtask-limits.js');
  for (const line of lines.values()) {
    line.sort(queueOrder);
    for (let i = 0; i < line.length; i++) {
      const t = line[i];
      const entry = t.start_queue!;
      // Admitted against the parent itself, not through the caller's session: a caller session
      // that is gone would otherwise fail open and start every entry over the cap at once.
      let release = () => {};
      try {
        release = await admitSubtaskStart(entry.parent_id, t.id, undefined, { userAsked: !!entry.params.userRequest });
        await startSessionForTask({ ...entry.params, taskIdPrefix: t.id, callerSid: entry.caller_sid, source: START_QUEUE_SOURCE });
        out.started.push(t.id);
        log.session.info('queued start started', { taskId: t.id, parentId: entry.parent_id, queuedAt: entry.at });
      } catch (err) {
        if (err instanceof SubtaskLimitError && err.code === 'too_many_running_subtasks') {
          out.waiting.push(...line.slice(i).map((x) => x.id));
          break;
        }
        if (err instanceof SessionExistsError) {
          await clearStartQueue(t.id, 'already started');
          out.dropped.push(t.id);
          continue;
        }
        await dropFailed(t, entry, err instanceof Error ? err.message : String(err));
        out.dropped.push(t.id);
      } finally {
        release();
      }
    }
  }
  return out;
}

// ── The loop and the nudge (primary only) ──

const SUBSCRIBER = 'start-queue';
let timer: ReturnType<typeof setInterval> | null = null;
let nudgeTimer: ReturnType<typeof setTimeout> | null = null;
const nudged = new Set<string>();
let notBefore: number | undefined;
let live = false;

function drainLogged(parentId?: string): void {
  void drainStartQueue(parentId, notBefore !== undefined ? { notBefore } : {})
    .catch((err) => log.session.warn('start queue: drain failed', { parentId, error: err instanceof Error ? err.message : String(err) }));
}

/** A subtask of `parentId` stopped running (or finished): try its parent's queue soon. */
export function nudgeStartQueue(parentId: string): void {
  if (!live) return;
  nudged.add(parentId);
  if (nudgeTimer) return;
  nudgeTimer = setTimeout(() => {
    nudgeTimer = null;
    const parents = [...nudged];
    nudged.clear();
    for (const p of parents) drainLogged(p);
  }, START_QUEUE_NUDGE_MS);
  nudgeTimer.unref?.();
}

/** On the primary, after boot. */
export async function startStartQueue(opts: { ephemeral?: boolean; cloud?: boolean } = {}): Promise<{ stop(): void }> {
  const flag = process.env.WALNUT_START_QUEUE;
  if (live || opts.cloud || flag === '0') return { stop: () => {} };
  live = true;
  notBefore = opts.ephemeral && flag !== '1' ? Date.now() : undefined;
  const { bus, EventNames } = await import('../event-bus.js');
  bus.subscribe(SUBSCRIBER, (event) => {
    const data = event.data as { task?: Task; newPhase?: string; oldPhase?: string } | undefined;
    const task = data?.task;
    if (!data || !task?.id) return;
    if (event.name === EventNames.TASK_PHASE_CHANGED) {
      if (data.oldPhase === data.newPhase) return;
      // A sibling left a running slot: its parent's queue may start one.
      if (data.oldPhase === 'IN_PROGRESS' && task.parent_task_id) nudgeStartQueue(task.parent_task_id);
      // A queued task completed: its entry goes.
      if (data.newPhase === 'COMPLETE' && task.start_queue) void clearStartQueue(task.id, 'task complete');
    } else if (event.name === EventNames.TASK_DELETED && task.parent_task_id) {
      nudgeStartQueue(task.parent_task_id);
    }
  }, { global: true, interest: [EventNames.TASK_PHASE_CHANGED, EventNames.TASK_DELETED] });
  timer = setInterval(() => drainLogged(), START_QUEUE_INTERVAL_MS);
  timer.unref?.();
  return { stop: stopStartQueue };
}

export function stopStartQueue(): void {
  if (!live) return;
  live = false;
  if (timer) clearInterval(timer);
  if (nudgeTimer) clearTimeout(nudgeTimer);
  timer = null;
  nudgeTimer = null;
  nudged.clear();
  void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(SUBSCRIBER)).catch(() => {});
}
