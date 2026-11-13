/**
 * Automatic starts with no named host or folder wait explicitly for capacity (2026-11-11).
 * Task.start_queue keeps the original request until a suitable host admits it. A full replay
 * stays waiting; another failure is recorded on the task and told to its asker. Older entries
 * without wait_for_slot keep their one-shot replay for compatibility.
 *
 * Kept: an entry's task completed, its asking task completed or is gone, or it started some other
 * way since (a person's start, a newer `last_start`, a session that began after it): it is dropped
 * with nothing told. A team stop (team-stop.ts) holds its team's entries until team_resume. On the
 * task's page Start now runs an entry as the user's own start and Cancel drops it, saying so on
 * the task (src/web/routes/task-v1.ts).
 *
 * Primary only: one coalesced pass soon after boot and every 15 seconds. A cloud
 * companion never runs one, and an ephemeral server only touches what was queued after it booted,
 * so neither starts work it copied from the user's real data. `WALNUT_START_QUEUE=0` turns it
 * off, `=1` lets an ephemeral server run every entry.
 */

import { randomUUID } from 'node:crypto';
import type { StartQueueEntry, Task, TaskPriority } from '../types.js';
import { log } from '../../logging/index.js';
import type { SessionStartParams, SessionStartResult } from './task-start.js';
import type { HostsFullDetail } from './host-admission.js';

export const START_QUEUE_SOURCE = 'start-queue';
/** The first pass after boot, then one every so often for a team resumed since. */
export const START_QUEUE_FIRST_MS = 30_000;
export const START_QUEUE_INTERVAL_MS = 15_000;

const PRIORITY_RANK: Record<TaskPriority, number> = { immediate: 0, important: 1, none: 2, backlog: 3 };

type Queued = Pick<Task, 'id' | 'priority'> & { start_queue?: StartQueueEntry | null };

/** Main uses the routine launch plumbing, but its automatic start is ordinary work. */
export function isQueuedRoutine(t: Queued): boolean {
  return !!t.start_queue?.routine && t.start_queue.routine.source !== 'org-autostart';
}

/** Accepted routine fires first, then task priority, age and a stable id tie-break. */
export function queueOrder(a: Queued, b: Queued): number {
  const rank = (t: Queued) => PRIORITY_RANK[t.priority ?? 'none'] ?? PRIORITY_RANK.none;
  return Number(!isQueuedRoutine(a)) - Number(!isQueuedRoutine(b))
    || rank(a) - rank(b)
    || (a.start_queue?.at ?? '').localeCompare(b.start_queue?.at ?? '')
    || a.id.localeCompare(b.id);
}

export async function queuedStartResult(task: Task, detail?: HostsFullDetail): Promise<SessionStartResult> {
  const { listTasks } = await import('../task-manager.js');
  const entry = task.start_queue!;
  const line = (await listTasks()).filter((t) => t.start_queue).sort(queueOrder);
  return { taskId: task.id, title: task.title, started: false, queued: {
    position: Math.max(1, line.findIndex((t) => t.id === task.id) + 1),
    host: entry.host ?? '__local__', reason: entry.reason ?? 'waiting for a free slot',
    running: detail?.running ?? [], ...(detail?.cap !== undefined ? { cap: detail.cap } : {}),
  } };
}

/** Store the original start once. Retries never replace its message or make another waiting task. */
export async function waitForHostSlot(params: SessionStartParams, detail: HostsFullDetail): Promise<SessionStartResult> {
  const { getTask, updateTaskRaw } = await import('../task-manager.js');
  const { getSessionByClaudeId } = await import('../session-tracker.js');
  const caller = params.callerSid ? await getSessionByClaudeId(params.callerSid).catch(() => null) : null;
  if (params.callerSid && !caller?.taskId) throw new Error('An automatic slot wait needs its asking task');
  const entry: StartQueueEntry = {
    at: new Date().toISOString(), parent_id: caller?.taskId ?? detail.taskId, caller_sid: caller?.claudeSessionId ?? '',
    ...(!caller ? { source: params.source } : {}),
    host: detail.host, reason: detail.reason, wait_for_slot: true,
    params: {
      ...(params.message !== undefined ? { message: params.message } : {}),
      ...(params.model !== undefined ? { model: params.model } : {}),
      ...(params.mode !== undefined ? { mode: params.mode } : {}),
      ...(params.effort !== undefined ? { effort: params.effort } : {}),
      ...(params.engine !== undefined ? { engine: params.engine } : {}),
      ...(params.expectReply !== undefined ? { expectReply: params.expectReply } : {}),
      ...(params.replyTimeoutSecs !== undefined ? { replyTimeoutSecs: params.replyTimeoutSecs } : {}),
      ...(params.handsOn !== undefined ? { handsOn: params.handsOn } : {}),
    },
  };
  await updateTaskRaw(detail.taskId, (cur) => cur.phase === 'COMPLETE' || cur.start_queue || cur.last_start?.state === 'starting'
    ? null : { start_queue: entry }, { emitEvent: true, push: false, source: START_QUEUE_SOURCE });
  const task = await getTask(detail.taskId);
  if (!task.start_queue) throw new Error(`Task ${task.id} changed before its slot wait could be recorded`);
  return queuedStartResult(task, detail);
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

/** Read the routine switch once per queue pass, not once per waiting task. */
export async function queuedRoutineSwitches(): Promise<ReadonlyMap<string, boolean> | undefined> {
  const { getCronService } = await import('../../web/routes/cron.js');
  const service = getCronService();
  return service ? new Map((await service.list({ includeDisabled: true })).map((job) => [job.id, job.enabled])) : undefined;
}

export function routineQueueEnabled(task: Task, switches: ReadonlyMap<string, boolean> | undefined): boolean {
  const jobId = task.routine_start?.job_id ?? task.start_queue?.routine?.jobId;
  return !task.start_queue?.routine || !jobId || !switches || switches.get(jobId) === true;
}

/** Routine entries that cannot run must not come back through the boot retry. */
function droppedRoutine(task: Task, error: string): Partial<Task> {
  return task.start_queue?.routine && task.routine_start ? { routine_start: {
    ...task.routine_start, state: 'failed', launch: undefined, error,
  } } : {};
}

async function recordDroppedRoutine(taskId: string, record: Task['routine_start']): Promise<void> {
  if (!record?.error) return;
  const { defaultRunStartDeps } = await import('../routines/run-start-deps.js');
  await defaultRunStartDeps().recordFailure(record, taskId, record.error);
}

/** Drop a task's queued start (it started, it completed, it was stopped). Never throws. */
export async function clearStartQueue(taskId: string, why: string, queuedAt?: string): Promise<boolean> {
  const { updateTaskRaw } = await import('../task-manager.js');
  let record: Task['routine_start'];
  try {
    const res = await updateTaskRaw(taskId, (cur) => {
      if (!cur.start_queue || (queuedAt && cur.start_queue.at !== queuedAt)) return null;
      const error = `This queued run did not run: ${why}.`;
      const patch = droppedRoutine(cur, error);
      const launch = cur.start_queue.routine;
      record = patch.routine_start ?? (launch?.jobId ? { job_id: launch.jobId, job_name: launch.sessionTitle ?? launch.taskTitle ?? 'Trigger',
        run_at: cur.start_queue.at, attempt_at: cur.start_queue.at, attempt: 1, state: 'failed', error } : undefined);
      return { start_queue: null, ...patch };
    }, { emitEvent: true, push: false, source: START_QUEUE_SOURCE });
    if (res.changed) {
      log.session.info('queued start cleared', { taskId, why });
      await recordDroppedRoutine(taskId, record);
    }
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
  if (entry.routine) {
    const { defaultRunStartDeps } = await import('../routines/run-start-deps.js');
    const result = await defaultRunStartDeps().launch(entry.routine, { existingTaskId: taskId,
      queuedAt: entry.at, byPerson: true,
      ...(entry.routine_session_id ? { preassignedSessionId: entry.routine_session_id } : {}),
    });
    return { taskId, title: result.task.title, started: true, ...(entry.routine_session_id ? { sessionId: entry.routine_session_id } : {}) };
  }
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
  let record: Task['routine_start'];
  const res = await updateTaskRaw(taskId, (cur) => {
    if (!cur.start_queue) return null;
    const error = 'The user cancelled this queued run; it did not run.';
    const patch = droppedRoutine(cur, error);
    const launch = cur.start_queue.routine;
    record = patch.routine_start ?? (launch?.jobId ? { job_id: launch.jobId, job_name: launch.sessionTitle ?? launch.taskTitle ?? 'Trigger',
      run_at: cur.start_queue.at, attempt_at: cur.start_queue.at, attempt: 1, state: 'failed', error } : undefined);
    return { start_queue: null, ...patch,
      last_start: { id: randomUUID(), at: new Date().toISOString(), state: 'failed' as const, error: 'The user cancelled this queued start; it did not run.' },
    };
  }, { emitEvent: true, push: false, source: START_QUEUE_SOURCE }).catch(() => ({ changed: false }));
  if (res.changed) {
    log.session.info('queued start cancelled by the user', { taskId });
    await recordDroppedRoutine(taskId, record);
  }
  return res.changed;
}

/**
 * A queued start that could not start: the entry goes, the failure is the task's `last_start`
 * (unless its own start recorded one), and its asking session is told now, so it can fix it.
 */
async function failLoudly(task: Task, entry: StartQueueEntry, error: string): Promise<void> {
  const { updateTaskRaw } = await import('../task-manager.js');
  await updateTaskRaw(task.id, (cur) => {
    if (cur.start_queue?.at !== entry.at) return null;
    const recorded = !!cur.last_start && cur.last_start.at >= entry.at;
    return {
      start_queue: null,
      ...droppedRoutine(cur, error),
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
        + (entry.wait_for_slot
          ? 'Its capacity wait ended with this failure. Read task_get for the cause before retrying the same id.'
          : 'This older queued start was tried once and failed. Read task_get for it before retrying the same id.'),
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

let draining: Promise<DrainResult> | null = null;

/** One pass at a time; ticks during a slow start share its pass instead of piling up. */
export function drainStartQueue(opts: { notBefore?: number } = {}): Promise<DrainResult> {
  if (draining) return draining;
  const run = drainNow(opts).finally(() => { if (draining === run) draining = null; });
  draining = run;
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
      await clearStartQueue(t.id, 'task complete', entry.at);
      out.dropped.push(t.id);
      continue;
    }
    // Started some other way since it was queued (a person's start, a message that resumed it).
    if (t.last_start && t.last_start.at > entry.at && t.last_start.state !== 'failed') {
      await clearStartQueue(t.id, 'started since queued', entry.at);
      out.dropped.push(t.id);
      continue;
    }
    // The task whose session queued it finished or is gone: nobody waits for this start any more.
    const askerTaskId = (await getSessionByClaudeId(entry.caller_sid).catch(() => null))?.taskId ?? entry.parent_id;
    const asker = byId.get(askerTaskId);
    if (!asker || asker.phase === 'COMPLETE') {
      await clearStartQueue(t.id, asker ? 'caller complete' : 'caller gone', entry.at);
      out.dropped.push(t.id);
      continue;
    }
    // A session began since it was queued by a path that writes no last_start (the web's Start,
    // the phone, a quick start): a replay now would send the queued message into it again.
    const records = await getSessionsForTask(t.id).catch(() => []);
    if (records.some((r) => (r.startedAt ?? '') > entry.at)) {
      await clearStartQueue(t.id, 'session since queued', entry.at);
      out.dropped.push(t.id);
      continue;
    }
    if (heldByTeamStop(t, byId)) { out.held.push(t.id); continue; }
    if (t.org_role === 'main' || t.org_role === 'lead') {
      const { isOrgEnabled } = await import('../org/org-enabled.js');
      if (!await isOrgEnabled()) { out.held.push(t.id); continue; }
    }
    try {
      if (entry.routine) {
        const { getCronService } = await import('../../web/routes/cron.js');
        const service = getCronService();
        const jobId = t.routine_start?.job_id ?? entry.routine.jobId;
        if (service && jobId) {
          const job = (await service.list({ includeDisabled: true })).find((j) => j.id === jobId);
          if (!job) { await clearStartQueue(t.id, 'routine removed', entry.at); out.dropped.push(t.id); continue; }
          if (!job.enabled) { out.held.push(t.id); continue; }
        }
        const { defaultRunStartDeps } = await import('../routines/run-start-deps.js');
        await defaultRunStartDeps().launch(entry.routine, {
          existingTaskId: t.id, queuedAt: entry.at,
          ...(entry.routine_session_id ? { preassignedSessionId: entry.routine_session_id } : {}),
        });
        out.started.push(t.id);
        continue;
      }
      // Placed again: it goes to the host with room that has its files (start-placement.ts).
      const result = await startSessionForTask({ ...entry.params, taskIdPrefix: t.id, callerSid: entry.caller_sid, source: entry.source ?? START_QUEUE_SOURCE, queuedAt: entry.at, answerWithinMs: 110_000 });
      if (result.queued) { out.held.push(t.id); continue; }
      out.started.push(t.id);
      log.session.info('queued start started', { taskId: t.id, askerId: entry.parent_id, host: entry.host, queuedAt: entry.at });
    } catch (err) {
      const { HostsFullError } = await import('./host-admission.js');
      if (entry.wait_for_slot && err instanceof HostsFullError) { out.held.push(t.id); continue; }
      // The user cancelled it while it was placed: nothing started, the cancel is on the task.
      if (err instanceof QueuedStartGoneError) { out.dropped.push(t.id); continue; }
      if (err instanceof SessionExistsError) {
        const { isTaskStarting } = await import('./task-start.js');
        if (isTaskStarting(t.id)) { out.held.push(t.id); continue; }
        await clearStartQueue(t.id, 'already started', entry.at);
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
