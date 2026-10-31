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
 *
 * An ephemeral test server runs on a COPY of the real tasks: a clock it
 * inherited belongs to the real Walnut and never fires there (like its paused
 * cron jobs and its copied Board reminders); a wait set during its own life
 * does. 2026-10-21: an inherited clock woke a copied task, which resumed the
 * real task's session id on the test server, so two copies of one session
 * edited the same working tree.
 */
import { IS_EPHEMERAL } from '../constants.js';
import { bootPolicy } from './boot-policy.js';
import { log } from '../logging/index.js';
import { bus, EventNames, type BusEvent } from './event-bus.js';
import type { Task } from './types.js';
import type { CronJob } from './cron/types.js';
import type { WatchingTrigger } from './task-wait-wake.js';

const deadlines = new Map<string, number>();
/** On an ephemeral server: taskId -> the wait_until it was copied with. */
let inherited: Map<string, string> | null = null;
/** The boot scan finished: until then an ephemeral server never arms, so a copied clock cannot slip in first. */
let scanned = false;
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

/** A clock copied from the real Walnut (ephemeral only), never one set here. */
function isInherited(task: Pick<Task, 'id' | 'wait_until'>): boolean {
  return !!inherited && !!task.wait_until && inherited.get(task.id) === task.wait_until;
}

function track(task: Task): void {
  const at = isInherited(task) ? null : waitUntilAt(task);
  if (at === null) deadlines.delete(task.id);
  else deadlines.set(task.id, at);
  arm();
}

function arm(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  if (!live || (inherited && !scanned) || deadlines.size === 0) return;
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

/** The triggers of a task that watch its ask of the user or a letter (recheck-watch.ts). */
async function userWatchTriggers(taskId: string): Promise<Set<string>> {
  const { getTask } = await import('./task-manager.js');
  const task = await getTask(taskId).catch(() => null);
  return new Set((task?.recheck_watch ?? []).map((w) => w.trigger));
}

/** The triggers that deliver into this task, as the wake note names them (also what
 *  task-wait-resume.ts reads). Never throws: [] when they cannot be listed. */
export async function triggersWatching(taskId: string): Promise<WatchingTrigger[]> {
  try {
    const { listRoutines } = await import('./routines/routines-core.js');
    const { triggerRunState } = await import('./cron/trigger-run-state.js');
    const { jobs } = await listRoutines(true);
    const mine = (jobs as CronJob[]).filter((job) => job.check && job.executor?.type === 'session'
      && (job.executor.config as { target?: unknown } | undefined)?.target === taskId);
    const onUser = mine.length ? await userWatchTriggers(taskId) : new Set<string>();
    return mine.map((job) => ({
      id: job.id,
      name: job.name,
      everyMs: job.schedule.kind === 'every' ? job.schedule.everyMs : undefined,
      state: triggerRunState(job),
      fires: job.state?.fireCount ?? 0,
      lastCheck: job.state?.lastCheck,
      ...(onUser.has(job.id) ? { watchesUser: true } : {}),
    }));
  } catch (err) {
    log.task.warn('wait_until: could not list the task\'s triggers for the wake note', { taskId, error: errText(err) });
    return [];
  }
}

async function wakeMessage(task: Task, nowMs: number): Promise<string> {
  const { buildWalnutMessage } = await import('./peers/walnut-message-tag.js');
  const { buildWaitWakeBody } = await import('./task-wait-wake.js');
  const until = new Date(task.wait_until!).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return buildWalnutMessage({
    kind: 'trigger',
    attrs: { from: 'Walnut: wait until', note: 'the time this task was waiting for has passed' },
    body: buildWaitWakeBody({ until, nowMs, triggers: await triggersWatching(task.id) }),
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
      await sendMessageToSession(target.claudeSessionId, await wakeMessage(task, nowMs), {
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

  // Snoozed (snooze.ts): handed back, but no red dot and no notice before its date.
  const { readSnoozedUntil } = await import('./snooze-read.js');
  const snoozed = await readSnoozedUntil(task, nowMs);
  const res = await updateTaskRaw(task.id, { phase: 'NEED_ACTION', ...(snoozed ? {} : { unread: true }) }, {
    emitEvent: true, push: true, source: 'wait-until', leaveHeld: true,
    shouldUpdate: (current) => current.phase === 'WAITING' && current.wait_until === task.wait_until,
  });
  if (!res.task) return false; // left WAITING or re-timed meanwhile
  log.task.info('wait_until passed: task handed back (no session to wake)', { taskId: task.id, until: task.wait_until, snoozed });
  if (snoozed) return true;
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
 * `notify: false` when the caller tells the user itself (the disable letter).
 * Returns whether the task was handed back.
 */
export async function handBackWaitingTaskOfDisabledTrigger(
  jobId: string,
  error: string | undefined,
  opts: { notify?: boolean } = {},
): Promise<boolean> {
  const { getRoutine } = await import('./routines/routines-core.js');
  const job = await getRoutine(jobId).then((r) => r.job as { name?: string; executor?: { type?: string; config?: { target?: unknown } } }).catch(() => null);
  const target = job?.executor?.type === 'session' ? job.executor.config?.target : undefined;
  if (typeof target !== 'string' || !target) return false;
  const { getTask, updateTaskRaw } = await import('./task-manager.js');
  const task = await getTask(target).catch(() => null);
  if (!task || task.phase !== 'WAITING') return false;
  const { readSnoozedUntil } = await import('./snooze-read.js');
  const snoozed = await readSnoozedUntil(task);
  const res = await updateTaskRaw(task.id, { phase: 'NEED_ACTION', ...(snoozed ? {} : { unread: true }) }, {
    emitEvent: true, push: true, source: 'trigger-check-failed', leaveHeld: true,
    shouldUpdate: (current) => current.phase === 'WAITING',
  });
  if (!res.task) return false;
  log.task.warn('waiting task handed back: its trigger kept failing', { taskId: task.id, routineId: jobId, error, snoozed });
  if (opts.notify === false || snoozed) return true;
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
  return true;
}

/** The boot scan: every WAITING task's clock, including one that passed while Walnut was down. Exported for tests. */
export async function loadWaitUntilDeadlines(): Promise<void> {
  const { listTasks } = await import('./task-manager.js');
  const tasks = await listTasks();
  for (const task of tasks) {
    const at = waitUntilAt(task);
    if (at === null) continue;
    // A copied clock: one a task event registered before this scan (a boot-time update) is dropped too.
    if (inherited) { inherited.set(task.id, task.wait_until!); deadlines.delete(task.id); continue; }
    deadlines.set(task.id, at);
  }
  scanned = true;
  arm();
}

function onTaskEvent(event: BusEvent): void {
  const task = (event.data as { task?: Task } | undefined)?.task;
  if (!task) return;
  // Once its clock changes (cleared, or set again), the task's wait is this server's own.
  if (inherited?.has(task.id) && inherited.get(task.id) !== task.wait_until) inherited.delete(task.id);
  if (event.name === EventNames.TASK_DELETED) {
    if (deadlines.delete(task.id)) arm();
    return;
  }
  if (deadlines.has(task.id) || waitUntilAt(task) !== null) track(task);
}

/** Start the timer and its one subscriber (server boot, primary only). Idempotent: the name is overwritten. */
export function startWaitUntilWatch(opts: { ephemeral?: boolean } = {}): void {
  if (!bootPolicy('wait-until')) return;
  inherited = (opts.ephemeral ?? IS_EPHEMERAL) ? new Map() : null;
  log.task.info('wait_until: started', inherited ? { inheritedClocksPaused: true } : {});
  live = true;
  scanned = false;
  // On an ephemeral server a failed scan leaves the timer off: it cannot tell a copied clock from its own.
  void loadWaitUntilDeadlines().catch((err) => log.task.warn('wait_until boot scan failed', {
    error: errText(err), ...(inherited ? { clocksOff: true } : {}),
  }));
  bus.subscribe(WAIT_UNTIL_SUBSCRIBER, onTaskEvent, {
    global: true,
    interest: [EventNames.TASK_UPDATED, EventNames.TASK_COMPLETED, EventNames.TASK_DELETED],
  });
}

export function stopWaitUntilWatch(): void {
  bus.unsubscribe(WAIT_UNTIL_SUBSCRIBER);
  live = false;
  deadlines.clear();
  inherited = null;
  scanned = false;
  arm();
}

/** Test seam: whether the timer is set. */
export function waitUntilArmed(): boolean {
  return timer !== null;
}

/** Test seam: the deadlines the timer currently knows. */
export function trackedWaitUntil(): ReadonlyMap<string, number> {
  return deadlines;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
