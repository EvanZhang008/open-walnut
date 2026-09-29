/**
 * "Wait until": the side-effect half. A session parks its task on a trigger it
 * created (walnut-trigger, session executor on this task); the task stays TODO
 * and visible, a finished turn no longer hands it back (task-waiting-rules.ts),
 * and the trigger's fire is what brings it back to the human.
 *
 * Lifecycle, and who moves it:
 *
 *   task_wait (the session)      → waiting { condition, routine_id }, routine enabled
 *   trigger fires                → wait ends ('fired'), the fire is delivered with a
 *                                  note, the routine is disabled; the delivered turn
 *                                  ends as NEED_ACTION unless the session re-arms
 *   task_wait again, same id     → re-armed: same routine, its dedup state intact
 *   5 check errors (auto-disable)→ wait ends ('check-failed'), NEED_ACTION + notice
 *   human / peer message         → wait ends ('message')           (phase.ts)
 *   prompt that needs the human  → wait ends ('needs-human')       (phase.ts)
 *   status set to Need Action    → wait ends ('status-changed')    (applyPhase)
 *   Stop waiting / trigger deleted → record removed (and the routine deleted)
 *   task completed or deleted    → routine deleted, record removed
 *   the trigger fired just BEFORE task_wait → the wait is recorded as already
 *                                  over, and the session is told so
 *
 * An ended wait keeps its record (woke_at) so the re-arm finds the routine; the
 * routine behind an ended wait is disabled, never left polling a task that is no
 * longer waiting on it.
 */
import { CLOUD_MODE } from '../constants.js';
import { log } from '../logging/index.js';
import { bus, EventNames, type BusEvent } from './event-bus.js';
import { SessionControlError } from './sessions/session-controls.js';
import { EARLY_FIRE_WINDOW_MS, endedWait, normalizeWaitCondition } from './task-waiting-rules.js';
import { isTaskWaiting, type Task, type TaskWaiting } from './types.js';

interface RoutineRef {
  id: string;
  name?: string;
  enabled?: boolean;
  check?: unknown;
  executor?: { type?: string; config?: Record<string, unknown> };
  state?: { fireLog?: Array<{ atMs?: number; outcome?: string }> };
}

/** The task a routine delivers to, when it is a session routine. */
export function routineTargetTask(job: RoutineRef | null | undefined): string | undefined {
  if (!job || job.executor?.type !== 'session') return undefined;
  const target = job.executor.config?.target;
  return typeof target === 'string' && target ? target : undefined;
}

async function findRoutine(id: string): Promise<RoutineRef | null> {
  try {
    const { getRoutine } = await import('./routines/routines-core.js');
    return (await getRoutine(id)).job as RoutineRef;
  } catch (err) {
    if (err instanceof SessionControlError && err.statusCode === 404) return null;
    throw err;
  }
}

async function setRoutineEnabled(id: string, enabled: boolean, opts: { strict?: boolean } = {}): Promise<void> {
  try {
    const { patchRoutine } = await import('./routines/routines-core.js');
    await patchRoutine(id, { enabled });
  } catch (err) {
    log.task.warn('wait routine toggle failed', { routineId: id, enabled, error: errText(err) });
    if (opts.strict) {
      if (err instanceof SessionControlError) throw err;
      throw new SessionControlError(`could not turn trigger ${id} back on (${errText(err)}); try again`, 503);
    }
  }
}

/** The newest fire of a routine within the early-fire window, if any. */
function recentFireAtMs(job: RoutineRef, now: number): number | undefined {
  const fired = (job.state?.fireLog ?? [])
    .filter((e) => e.outcome === 'fired' && typeof e.atMs === 'number' && now - e.atMs <= EARLY_FIRE_WINDOW_MS)
    .map((e) => e.atMs as number);
  return fired.length ? Math.max(...fired) : undefined;
}

async function deleteRoutineQuietly(id: string): Promise<void> {
  try {
    const { deleteRoutine } = await import('./routines/routines-core.js');
    await deleteRoutine(id);
  } catch (err) {
    if (err instanceof SessionControlError && err.statusCode === 404) return;
    log.task.warn('wait routine delete failed', { routineId: id, error: errText(err) });
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Routines this process already confirmed disabled for an ended wait (no re-read per task event). */
const settledRoutines = new Set<string>();

/**
 * Park a task on a trigger. `routineId` must be a trigger (a routine with a check)
 * that delivers into THIS task's session, which is what `trigger_create` with
 * `session: "this"` makes. Idempotent, and also the re-arm after a fire.
 */
export async function setTaskWaiting(input: {
  taskId: string;
  condition: unknown;
  routineId: unknown;
  source?: string;
}): Promise<Task> {
  if (CLOUD_MODE) throw new SessionControlError('waits are set on the primary Walnut, not the cloud companion', 501);
  const condition = normalizeWaitCondition(input.condition);
  if (!condition) {
    throw new SessionControlError('condition is required: what the task waits for, in the user\'s words (e.g. "CR 1234 is approved")', 400);
  }
  const routineId = typeof input.routineId === 'string' ? input.routineId.trim() : '';
  if (!routineId) {
    throw new SessionControlError('routine_id is required: the id trigger_create returned for the trigger that ends the wait', 400);
  }
  const { getTask, updateTaskRaw } = await import('./task-manager.js');
  const task = await getTask(input.taskId).catch(() => null);
  if (!task) throw new SessionControlError(`no task ${input.taskId}`, 404);
  if (task.phase === 'COMPLETE') throw new SessionControlError('the task is complete; reopen it before it can wait', 409);

  const job = await findRoutine(routineId);
  if (!job) throw new SessionControlError(`no trigger ${routineId}: create it with trigger_create first`, 404);
  if (!job.check) {
    throw new SessionControlError(`routine ${routineId} has no check script; a wait needs a trigger (trigger_create)`, 400);
  }
  const target = routineTargetTask(job);
  if (target !== task.id) {
    throw new SessionControlError(
      `trigger ${routineId} delivers to ${target ? `task ${target}` : 'no task'}, not to this task: `
      + 'create it with trigger_create and session "this" (or this task\'s id)',
      400,
    );
  }

  // One wait per task: a new trigger replaces the old one, which would otherwise
  // keep polling (or sit disabled) with nothing waiting on it.
  const previous = task.waiting?.routine_id;
  const rearm = previous === routineId;
  const now = new Date();
  // Too late: a new trigger's first check runs seconds after trigger_create, so
  // an already-true condition fired as an ordinary trigger before this call, and
  // dedup will not fire it again. Parking now would park forever; record the wait
  // as over instead, so this turn's end hands the task back as usual.
  const firedAtMs = rearm ? undefined : recentFireAtMs(job, now.getTime());
  if (firedAtMs !== undefined) {
    if (previous) await deleteRoutineQuietly(previous);
    const over: TaskWaiting = {
      condition, routine_id: routineId, since: now.toISOString(),
      woke_at: new Date(firedAtMs).toISOString(), woke_reason: 'fired', settled_at: now.toISOString(),
    };
    const res = await updateTaskRaw(task.id, { waiting: over }, { emitEvent: true, source: input.source ?? 'task-wait' });
    log.task.info('task wait set after its trigger already fired', { taskId: task.id, routineId, firedAtMs, condition });
    return res.task ?? { ...task, waiting: over };
  }
  if (previous && !rearm) await deleteRoutineQuietly(previous);
  settledRoutines.delete(routineId);
  // Strict: a wait whose only exit is off must not be reported as set.
  if (job.enabled === false) await setRoutineEnabled(routineId, true, { strict: true });

  const waiting: TaskWaiting = { condition, routine_id: routineId, since: now.toISOString() };
  const res = await updateTaskRaw(task.id, {
    waiting,
    unread: false,
    // A handed-back task that starts waiting stops asking for the human.
    ...(task.phase === 'NEED_ACTION' ? { phase: 'TODO' as const } : {}),
  }, { emitEvent: true, push: true, source: input.source ?? 'task-wait' });
  log.task.info('task waiting', {
    taskId: task.id, routineId, condition, rearm, phase: res.task?.phase ?? task.phase,
  });
  return res.task ?? { ...task, waiting };
}


/** Stop waiting: remove the record and delete its trigger. The task stays where it is (TODO). */
export async function stopTaskWaiting(taskId: string, opts: { source?: string } = {}): Promise<Task> {
  if (CLOUD_MODE) throw new SessionControlError('waits are managed on the primary Walnut, not the cloud companion', 501);
  const { getTask, updateTaskRaw } = await import('./task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task) throw new SessionControlError(`no task ${taskId}`, 404);
  const routineId = task.waiting?.routine_id;
  if (!routineId) return task;
  const res = await updateTaskRaw(task.id, { waiting: null } as unknown as Partial<Task>, {
    emitEvent: true, source: opts.source ?? 'task-wait',
  });
  await deleteRoutineQuietly(routineId);
  log.task.info('task wait stopped', { taskId: task.id, routineId, source: opts.source });
  return res.task ?? task;
}

// ── The trigger side: a fire, a failing check, a deleted routine ──

export interface WaitingFire {
  taskId?: string;
  /** Appended to the fire's prompt: what the wait was and how to keep waiting. */
  note: string;
}

/** What the session reads with the fire. */
export function waitFireNote(condition: string, routineId: string): string {
  const args = JSON.stringify({ condition, routine_id: routineId }).replace(/'/g, "'\\''");
  return [
    `Walnut: this task was waiting until: ${condition}. The trigger fired, so the wait is over: when this turn`,
    'ends the task goes back to the user as Need Action (red dot). Look at what happened and tell the user in a',
    'few lines what it means and what to do next. If it does not need the user yet (an acknowledgement, an',
    'intermediate stage), keep waiting instead, then end the turn; the task stays To Do with no red dot:',
    `walnut tools call task_wait '${args}'`,
  ].join('\n');
}

/**
 * Before a fire is delivered: if its task is waiting on this routine, end the
 * wait. Returns the note to append, or an empty one when the routine is an
 * ordinary trigger. A replayed fire (the wait ended 'fired' and that fire is not
 * settled yet) still gets the note, since the session never saw the first
 * attempt; once settled, a later fire of the same trigger is an ordinary one.
 * (The task event this write emits leaves the routine alone: onTaskEvent skips a
 * 'fired' wake, finishWaitingFire decides.)
 */
export async function beginWaitingFire(job: RoutineRef): Promise<WaitingFire> {
  const taskId = routineTargetTask(job);
  if (!taskId) return { note: '' };
  const { getTask, updateTaskRaw } = await import('./task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  const waiting = task?.waiting;
  if (!task || !waiting || waiting.routine_id !== job.id || task.phase === 'COMPLETE') return { note: '' };
  if (isTaskWaiting(task)) {
    await updateTaskRaw(task.id, { waiting: endedWait(waiting, 'fired') }, {
      emitEvent: true, source: 'trigger-fired',
      shouldUpdate: (current) => isTaskWaiting(current) && current.waiting?.routine_id === job.id,
    });
    log.task.info('task wait ended', { taskId: task.id, routineId: job.id, reason: 'fired' });
  } else if (waiting.woke_reason !== 'fired' || waiting.settled_at) {
    return { note: '' };
  }
  return { taskId: task.id, note: waitFireNote(waiting.condition, job.id) };
}

/**
 * After the fire was handled. A transient failure is replayed by the daemon, so
 * nothing changes yet. Otherwise the routine is disabled (unless the session has
 * already re-armed it), and a fire that could not be delivered at all hands the
 * task back directly: no turn will ever do it.
 */
export async function finishWaitingFire(
  job: RoutineRef,
  begun: WaitingFire,
  outcome: { delivered: boolean; retry: boolean },
): Promise<void> {
  if (!begun.taskId || outcome.retry) return;
  const { getTask, updateTaskRaw } = await import('./task-manager.js');
  const task = await getTask(begun.taskId).catch(() => null);
  if (!task) return;
  if (isTaskWaiting(task) && task.waiting?.routine_id === job.id) return; // re-armed already
  await setRoutineEnabled(job.id, false);
  settledRoutines.add(job.id);
  if (task.phase === 'COMPLETE' || task.waiting?.routine_id !== job.id) return;
  const settled: TaskWaiting = { ...task.waiting!, settled_at: new Date().toISOString() };
  const stillThisFire = (current: Task) => current.waiting?.routine_id === job.id && !isTaskWaiting(current);
  if (outcome.delivered) {
    await updateTaskRaw(task.id, { waiting: settled }, { emitEvent: true, source: 'trigger-fired', shouldUpdate: stillThisFire });
    return;
  }
  // Refused for good: no turn will ever hand the task back, so do it here.
  await updateTaskRaw(task.id, { phase: 'NEED_ACTION', unread: true, waiting: settled }, {
    emitEvent: true, push: true, source: 'trigger-fired', shouldUpdate: stillThisFire,
  });
  log.task.warn('wait trigger fired but could not deliver; task handed back', { taskId: task.id, routineId: job.id });
}

/** The trigger was auto-disabled for failing checks: a wait on it can never end by itself. */
export async function wakeForFailedTrigger(jobId: string, error: string | undefined): Promise<void> {
  const job = await findRoutine(jobId).catch(() => null);
  const taskId = routineTargetTask(job);
  if (!taskId) return;
  const { getTask, updateTaskRaw } = await import('./task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task || !isTaskWaiting(task) || task.waiting?.routine_id !== jobId) return;
  await updateTaskRaw(task.id, {
    phase: 'NEED_ACTION', unread: true, waiting: endedWait(task.waiting!, 'check-failed'),
  }, { emitEvent: true, push: true, source: 'trigger-check-failed' });
  settledRoutines.add(jobId);
  log.task.warn('task wait ended: its trigger kept failing', { taskId: task.id, routineId: jobId, error });
  try {
    const { addNotification } = await import('./notifications/store.js');
    await addNotification({
      kind: 'cron',
      severity: 'warning',
      title: `Stopped waiting: ${task.title}`,
      body: `The trigger watching "${task.waiting!.condition}" kept failing${error ? ` (${error})` : ''}, so the task needs a look.`,
      dedupKey: `task-wait-failed:${task.id}:${jobId}`,
      taskId: task.id,
    });
  } catch (err) {
    log.task.warn('wait failure notification failed', { taskId: task.id, error: errText(err) });
  }
}

/** A routine was deleted (Stop waiting, the trigger card, trigger_delete): drop a wait on it. */
export async function onRoutineDeleted(job: RoutineRef | null | undefined): Promise<void> {
  const taskId = routineTargetTask(job);
  if (!taskId || !job) return;
  settledRoutines.delete(job.id);
  try {
    const { getTask, updateTaskRaw } = await import('./task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    if (!task || task.waiting?.routine_id !== job.id) return;
    // Silently on a COMPLETE row: its write would emit task:completed again.
    await updateTaskRaw(task.id, { waiting: null } as unknown as Partial<Task>, {
      emitEvent: task.phase !== 'COMPLETE', source: 'trigger-deleted',
      shouldUpdate: (current) => current.waiting?.routine_id === job.id,
    });
    log.task.info('task wait removed with its trigger', { taskId: task.id, routineId: job.id });
  } catch (err) {
    log.task.warn('wait cleanup after routine delete failed', { routineId: job.id, error: errText(err) });
  }
}

// ── Task events: completion and deletion clean up, an ended wait disables its routine ──

export const TASK_WAITING_SUBSCRIBER = 'task-waiting';

async function onTaskEvent(event: BusEvent): Promise<void> {
  const task = (event.data as { task?: Task } | undefined)?.task;
  const waiting = task?.waiting;
  if (!task || !waiting?.routine_id) return;
  const gone = event.name === EventNames.TASK_DELETED;
  if (gone || task.phase === 'COMPLETE') {
    if (!gone) {
      // Record first, and silently: a COMPLETE row's write would emit
      // task:completed a second time (and with the record gone, the routine
      // delete below finds nothing to clear). Removing it matters for a reopen,
      // which must not find a live wait.
      const { updateTaskRaw } = await import('./task-manager.js');
      await updateTaskRaw(task.id, { waiting: null } as unknown as Partial<Task>, {
        shouldUpdate: (current) => current.waiting?.routine_id === waiting.routine_id,
      });
    }
    await deleteRoutineQuietly(waiting.routine_id);
    settledRoutines.delete(waiting.routine_id);
    log.task.info('wait trigger removed with its task', { taskId: task.id, routineId: waiting.routine_id, deleted: gone });
    return;
  }
  // Ended by a message, a prompt or a status change: that trigger must stop polling.
  // A fire is finishWaitingFire's to settle: a delivery the daemon still replays
  // (even across a server restart, which empties settledRoutines) needs it enabled.
  if (waiting.woke_at && waiting.woke_reason !== 'fired' && !settledRoutines.has(waiting.routine_id)) {
    settledRoutines.add(waiting.routine_id);
    const job = await findRoutine(waiting.routine_id).catch(() => null);
    if (job?.enabled) await setRoutineEnabled(job.id, false);
  }
}

/**
 * A waiting task's turn ended and it stayed quiet (TODO, no NEED_ACTION edge), so
 * session-request-watch never speaks. A parent that asked it for a reply still
 * hears that it stopped, as it would from any other turn end.
 */
export async function notifyParentsOfQuietTurnEnd(taskId: string, sessionId: string | undefined): Promise<void> {
  const { pendingRequestsForTarget } = await import('./session-requests.js');
  const pending = await pendingRequestsForTarget({ sessionId, taskId });
  if (pending.length === 0) return;
  const { notifyRequesterFallback } = await import('./sessions/session-request-notify.js');
  for (const request of pending) await notifyRequesterFallback(request, 'completed');
  log.task.info('waiting task turn ended: pending requests notified', { taskId, sessionId, count: pending.length });
}

/** Start the one subscriber (server boot, primary only). Idempotent: the name is overwritten. */
export function startTaskWaitingWatch(): void {
  if (CLOUD_MODE) return;
  bus.subscribe(TASK_WAITING_SUBSCRIBER, (event) => {
    void onTaskEvent(event).catch((err) => log.task.warn('task-waiting event failed', {
      event: event.name, error: errText(err),
    }));
  }, {
    global: true,
    interest: [EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED, EventNames.TASK_DELETED],
  });
}

export function stopTaskWaitingWatch(): void {
  bus.unsubscribe(TASK_WAITING_SUBSCRIBER);
}
