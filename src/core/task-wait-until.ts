/**
 * `wait_until`: the clock on a WAITING task.
 *
 * A task set to WAITING holds until something new happens on it (a message, a
 * trigger fire, a prompt for the human) or until its optional `wait_until`
 * passes. This module owns the second exit. One server timer for the nearest
 * deadline (re-checked at least hourly, so a Mac that slept past one catches up
 * on wake), fed by a boot scan and by the task events every write emits.
 *
 * When the time comes the task is woken the way a trigger would wake it: a
 * message into its session, which starts a turn (IN_PROGRESS) that ends the
 * normal way (NEED_ACTION). A task with no session to wake comes back to the
 * human directly as NEED_ACTION with a red dot. Either way the clock is cleared
 * by the move out of WAITING (applyPhase).
 *
 * A server clock, not a daemon's: the host that would have fired a trigger is
 * exactly what may have stopped working.
 */
import { CLOUD_MODE } from '../constants.js';
import { log } from '../logging/index.js';
import { bus, EventNames, type BusEvent } from './event-bus.js';
import type { Task } from './types.js';

const deadlines = new Map<string, number>();
let timer: ReturnType<typeof setTimeout> | null = null;
let live = false;
const RECHECK_MS = 3_600_000;

export const WAIT_UNTIL_SUBSCRIBER = 'task-wait-until';
export const WAIT_UNTIL_SEND_SOURCE = 'wait-until';

/** The deadline a task carries, or null when it has none the timer can use. */
export function waitUntilAt(task: Pick<Task, 'phase' | 'wait_until'>): number | null {
  if (task.phase !== 'WAITING' || !task.wait_until) return null;
  const at = Date.parse(task.wait_until);
  // A malformed value must not reach the timer: a NaN deadline would re-arm it every millisecond.
  return Number.isFinite(at) ? at : null;
}

function track(task: Task): void {
  const at = waitUntilAt(task);
  if (at === null) deadlines.delete(task.id);
  else deadlines.set(task.id, at);
  arm();
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!live || deadlines.size === 0) return;
  const next = Math.min(...deadlines.values());
  const delay = Math.max(1_000, Math.min(next - Date.now(), RECHECK_MS));
  timer = setTimeout(() => {
    timer = null;
    void sweepWaitUntil().catch((err) => log.task.warn('wait_until sweep failed', { error: errText(err) }));
  }, delay);
  timer.unref?.();
}

/**
 * Wake every task whose `wait_until` has passed. Exported for tests (a fake
 * `nowMs`); the timer calls it with the real clock. Re-reads each task, so one
 * that left WAITING or got a later time since it was tracked is left alone.
 */
export async function sweepWaitUntil(nowMs = Date.now()): Promise<string[]> {
  const due = [...deadlines.entries()].filter(([, at]) => at <= nowMs).map(([id]) => id);
  const woke: string[] = [];
  for (const id of due) {
    deadlines.delete(id);
    if (await wake(id, nowMs)) woke.push(id);
  }
  arm();
  return woke;
}

async function wakeMessage(task: Task): Promise<string> {
  const { buildWalnutMessage } = await import('./peers/walnut-message-tag.js');
  const when = new Date(task.wait_until!).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return buildWalnutMessage({
    kind: 'trigger',
    attrs: { from: 'Walnut: wait until', note: 'the time this task was waiting for has passed' },
    body: `The wait on this task ran until ${when}. Take it from here: check what it was waiting for, do what is next, and tell the user where things stand.`,
  });
}

async function wake(taskId: string, nowMs: number): Promise<boolean> {
  const { getTask, updateTaskRaw } = await import('./task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  if (!task) return false;
  const at = waitUntilAt(task);
  if (at === null || at > nowMs) {
    track(task);
    return false;
  }

  const { getSessionsForTask } = await import('./session-tracker.js');
  const { pickDeliverySession } = await import('./routines/session-target.js');
  const sessions = await getSessionsForTask(task.id).catch(() => []);
  const target = pickDeliverySession(sessions);
  if (target) {
    try {
      const { sendMessageToSession } = await import('./session-message-queue.js');
      // The send itself moves the task: session:input → IN_PROGRESS, and the
      // turn's end → NEED_ACTION, the same path a trigger fire takes.
      await sendMessageToSession(target.claudeSessionId, await wakeMessage(task), {
        source: WAIT_UNTIL_SEND_SOURCE, taskId: task.id,
      });
      log.task.info('wait_until passed: session woken', {
        taskId: task.id, sessionId: target.claudeSessionId, until: task.wait_until,
      });
      return true;
    } catch (err) {
      log.task.warn('wait_until passed: session wake failed, handing the task back instead', {
        taskId: task.id, sessionId: target.claudeSessionId, error: errText(err),
      });
    }
  }

  const res = await updateTaskRaw(task.id, { phase: 'NEED_ACTION', unread: true }, {
    emitEvent: true, push: true, source: 'wait-until', leaveHeld: true,
    shouldUpdate: (current) => current.phase === 'WAITING' && current.wait_until === task.wait_until,
  });
  if (!res.task) return false; // left WAITING or re-timed meanwhile
  log.task.info('wait_until passed: task handed back (no session to wake)', { taskId: task.id, until: task.wait_until });
  try {
    const { addNotification } = await import('./notifications/store.js');
    await addNotification({
      kind: 'cron',
      severity: 'info',
      title: `Waiting is over: ${task.title}`,
      body: `The time this task was waiting for has passed, and it has no conversation to pick it up, so it is back with you.`,
      dedupKey: `wait-until:${task.id}:${task.wait_until}`,
      taskId: task.id,
    });
  } catch (err) {
    log.task.warn('wait_until notification failed', { taskId: task.id, error: errText(err) });
  }
  return true;
}

/**
 * A trigger that delivers to a WAITING task was switched off by the server (five
 * check errors in a row): nothing will wake that task now, so it comes back to
 * the human. Any other routine, or a task in any other phase, is left alone.
 */
export async function handBackWaitingTaskOfDisabledTrigger(jobId: string, error: string | undefined): Promise<void> {
  const { getRoutine } = await import('./routines/routines-core.js');
  const job = await getRoutine(jobId).then((r) => r.job as { name?: string; executor?: { type?: string; config?: { target?: unknown } } }).catch(() => null);
  const target = job?.executor?.type === 'session' ? job.executor.config?.target : undefined;
  if (typeof target !== 'string' || !target) return;
  const { getTask, updateTaskRaw } = await import('./task-manager.js');
  const task = await getTask(target).catch(() => null);
  if (!task || task.phase !== 'WAITING') return;
  const res = await updateTaskRaw(task.id, { phase: 'NEED_ACTION', unread: true }, {
    emitEvent: true, push: true, source: 'trigger-check-failed', leaveHeld: true,
    shouldUpdate: (current) => current.phase === 'WAITING',
  });
  if (!res.task) return;
  log.task.warn('waiting task handed back: its trigger kept failing', { taskId: task.id, routineId: jobId, error });
  try {
    const { addNotification } = await import('./notifications/store.js');
    await addNotification({
      kind: 'cron',
      severity: 'warning',
      title: `Stopped waiting: ${task.title}`,
      body: `The trigger "${job?.name ?? jobId}" that would have woken this task kept failing${error ? ` (${error})` : ''}, so the task needs a look.`,
      dedupKey: `wait-trigger-failed:${task.id}:${jobId}`,
      taskId: task.id,
    });
  } catch (err) {
    log.task.warn('wait trigger failure notification failed', { taskId: task.id, error: errText(err) });
  }
}

/** The boot scan: every WAITING task's clock, including one that passed while Walnut was down. Exported for tests. */
export async function loadWaitUntilDeadlines(): Promise<void> {
  const { listTasks } = await import('./task-manager.js');
  const tasks = await listTasks();
  for (const task of tasks) {
    const at = waitUntilAt(task);
    if (at !== null) deadlines.set(task.id, at);
  }
  arm();
}

function onTaskEvent(event: BusEvent): void {
  const task = (event.data as { task?: Task } | undefined)?.task;
  if (!task) return;
  if (event.name === EventNames.TASK_DELETED) {
    if (deadlines.delete(task.id)) arm();
    return;
  }
  if (deadlines.has(task.id) || waitUntilAt(task) !== null) track(task);
}

/** Start the timer and its one subscriber (server boot, primary only). Idempotent: the name is overwritten. */
export function startWaitUntilWatch(): void {
  if (CLOUD_MODE) return;
  live = true;
  void loadWaitUntilDeadlines().catch((err) => log.task.warn('wait_until boot scan failed', { error: errText(err) }));
  bus.subscribe(WAIT_UNTIL_SUBSCRIBER, onTaskEvent, {
    global: true,
    interest: [EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED, EventNames.TASK_DELETED],
  });
}

export function stopWaitUntilWatch(): void {
  bus.unsubscribe(WAIT_UNTIL_SUBSCRIBER);
  live = false;
  deadlines.clear();
  arm();
}

/** Test seam: the deadlines the timer currently knows. */
export function trackedWaitUntil(): ReadonlyMap<string, number> {
  return deadlines;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
