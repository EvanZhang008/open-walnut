/**
 * A task's triggers stop when the task completes (2026-11-02, the user: the trigger of a
 * completed task kept polling, its check script was deleted, it failed five times, and
 * Walnut wrote him a letter about it).
 *
 * When a task moves to COMPLETE, every enabled TRIGGER aimed at it (a routine with a check
 * whose session executor targets the task; a plain timed routine stays as its maker set it)
 * is paused the way a person pauses one (routines-core `patchRoutine`, as team-stop.ts does),
 * and recorded here with the `pausedAtMs` that pause stamped. When the task leaves COMPLETE
 * (a reopen), exactly those are resumed, and only while each still carries that stamp: one
 * the user or a session resumed by hand on the completed task stays as they left it, and one
 * they paused again since stays paused. A trigger that was already paused before the
 * completion is not Walnut's to resume, so it is never recorded. A completion by
 * task_transfer leaves the triggers alone: a fire follows `transferred_to` to the task that
 * took the work over (executors/session.ts).
 *
 * Leader only, wired beside complete-archive.ts. The boot pass covers what happened while the
 * server was down: a task completed since the last pass is handled as a completion (unless a
 * record says it was), and a recorded task that is no longer COMPLETE as a reopen. The record
 * is machine-local (routine-state/, gitignored) because the stamp it compares lives in the
 * machine-local cron state.
 */

import path from 'node:path';
import { WALNUT_HOME } from '../../constants.js';
import { log } from '../../logging/index.js';
import { readJsonFile, writeJsonFile } from '../../utils/fs.js';
import type { CronJob } from '../cron/types.js';
import type { Task } from '../types.js';

const SUBSCRIBER = 'trigger-completion-pause';
/** The `origin` of the writes, as team-stop passes its own. */
const PAUSE_ORIGIN = 'task-complete';
const RESUME_ORIGIN = 'task-reopen';
/** Completions this close before the last pass are looked at again: a write racing that pass. */
const SWEEP_OVERLAP_MS = 5 * 60_000;
/** A completion that paused nothing is kept only long enough to cover the next pass's overlap. */
const EMPTY_RECORD_KEEP_MS = 24 * 60 * 60_000;

export interface PausedTrigger { id: string; pausedAtMs: number }
interface TaskRecord { atMs: number; triggers: PausedTrigger[] }
interface RecordFile { version: 1; sweptAtMs?: number; tasks: Record<string, TaskRecord> }

function recordPath(): string {
  return path.join(WALNUT_HOME, 'routine-state', 'task-completion-pauses.json');
}

async function readRecord(): Promise<RecordFile> {
  const raw = await readJsonFile<Partial<RecordFile>>(recordPath(), {});
  return { version: 1, ...(typeof raw.sweptAtMs === 'number' ? { sweptAtMs: raw.sweptAtMs } : {}), tasks: raw.tasks && typeof raw.tasks === 'object' ? raw.tasks : {} };
}

/** One writer at a time: every change reads, edits and writes the whole (small) file. */
let chain: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const run = chain.then(work, work);
  chain = run.catch(() => undefined);
  return run;
}

/** The triggers aimed at `taskId`, paused or not. */
export function triggersOf(jobs: readonly CronJob[], taskId: string): CronJob[] {
  return jobs.filter((j) => typeof j.check?.run === 'string' && j.executor?.type === 'session'
    && (j.executor.config as { target?: unknown } | undefined)?.target === taskId);
}

async function allJobs(): Promise<CronJob[]> {
  const { listRoutines } = await import('./routines-core.js');
  return (await listRoutines(true)).jobs as CronJob[];
}

/** Pause the enabled triggers of a task that completed; returns what it paused. */
async function pauseFor(task: Task, jobs: readonly CronJob[], file: RecordFile, opts: { createdBeforeMs?: number } = {}): Promise<PausedTrigger[]> {
  if (task.transferred_to) {
    log.cron.info('task completed by a transfer: its triggers follow the work', { taskId: task.id, to: task.transferred_to });
    return [];
  }
  const { patchRoutine } = await import('./routines-core.js');
  const paused: PausedTrigger[] = [];
  for (const job of triggersOf(jobs, task.id)) {
    if (!job.enabled) continue;
    // Made after the completion (the boot pass only): someone armed it on the done task on purpose.
    if (opts.createdBeforeMs !== undefined && job.createdAtMs > opts.createdBeforeMs) continue;
    try {
      const { job: after } = await patchRoutine(job.id, { enabled: false }, PAUSE_ORIGIN) as { job: CronJob };
      const stamp = after?.state?.pausedAtMs;
      if (typeof stamp === 'number') paused.push({ id: job.id, pausedAtMs: stamp });
    } catch (err) {
      log.cron.warn('trigger of a completed task not paused', { taskId: task.id, jobId: job.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  const was = file.tasks[task.id];
  // A second completion without a reopen in between keeps what the first one paused.
  const merged = [...(was?.triggers ?? []).filter((t) => !paused.some((p) => p.id === t.id)), ...paused];
  file.tasks[task.id] = { atMs: Date.now(), triggers: merged };
  if (paused.length) log.cron.info('triggers paused: their task completed', { taskId: task.id, jobIds: paused.map((p) => p.id) });
  return paused;
}

/** Resume what a completion of `taskId` paused, where nobody touched it since. */
async function resumeFor(taskId: string, jobs: readonly CronJob[], file: RecordFile): Promise<string[]> {
  const rec = file.tasks[taskId];
  delete file.tasks[taskId];
  if (!rec?.triggers.length) return [];
  const { patchRoutine } = await import('./routines-core.js');
  const byId = new Map(jobs.map((j) => [j.id, j] as const));
  const resumed: string[] = [];
  const ours = rec.triggers.filter((t) => {
    const job = byId.get(t.id);
    // Gone, resumed by hand, or paused again by someone since: theirs now.
    return !!job && !job.enabled && job.state?.pausedAtMs === t.pausedAtMs;
  });
  // Its team is stopped (team-stop.ts): the triggers join that stop, and its resume turns them on.
  if (ours.length && await handToTeamStop(taskId, ours.map((t) => t.id))) return [];
  for (const t of ours) {
    try {
      await patchRoutine(t.id, { enabled: true }, RESUME_ORIGIN);
      resumed.push(t.id);
    } catch (err) {
      log.cron.warn('trigger of a reopened task not resumed', { taskId, jobId: t.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  if (resumed.length) log.cron.info('triggers resumed: their task reopened', { taskId, jobIds: resumed });
  return resumed;
}

/**
 * When the task or one above it holds a team stop, add `ids` to that stop's record for the task,
 * so a team resume turns them back on and nothing runs while the team is stopped. True when one did.
 */
async function handToTeamStop(taskId: string, ids: string[]): Promise<boolean> {
  const { getTask, updateTaskRaw } = await import('../task-manager.js');
  let id: string | undefined = taskId;
  for (let hop = 0; id && hop < 8; hop++) {
    const t: Task | null = await getTask(id).catch(() => null);
    if (!t) return false;
    const stop = t.team_stop;
    if (stop) {
      const members = stop.members.some((m) => m.id === taskId)
        ? stop.members.map((m) => (m.id === taskId ? { ...m, triggers: [...new Set([...(m.triggers ?? []), ...ids])] } : m))
        : [...stop.members, { id: taskId, title: (await getTask(taskId).catch(() => null))?.title ?? taskId, triggers: ids }];
      await updateTaskRaw(t.id, { team_stop: { ...stop, members } }, { emitEvent: true, push: false, source: 'trigger-completion-pause' });
      log.cron.info('triggers of a reopened task kept paused: its team is stopped', { taskId, rootId: t.id, jobIds: ids });
      return true;
    }
    id = t.parent_task_id || undefined;
  }
  return false;
}

/** A task just completed: pause its triggers. Exported for tests. */
export function onTaskCompleted(taskId: string): Promise<PausedTrigger[]> {
  return serial(async () => {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    // Reopened before this ran: nothing to pause.
    if (!task || task.phase !== 'COMPLETE') return [];
    const file = await readRecord();
    const paused = await pauseFor(task, await allJobs(), file);
    await writeJsonFile(recordPath(), file);
    return paused;
  });
}

/** A completed task was reopened: resume what its completion paused. Exported for tests. */
export function onTaskReopened(taskId: string): Promise<string[]> {
  return serial(async () => {
    const { getTask } = await import('../task-manager.js');
    const task = await getTask(taskId).catch(() => null);
    // Completed again before this ran: keep the record for the next reopen.
    if (task?.phase === 'COMPLETE') return [];
    const file = await readRecord();
    if (!file.tasks[taskId]) return [];
    const resumed = await resumeFor(taskId, await allJobs(), file);
    await writeJsonFile(recordPath(), file);
    return resumed;
  });
}

/**
 * The boot pass: completions and reopens this server did not see. Returns what it changed.
 * The first pass takes every completed task: a trigger left polling on one from before this
 * rule is the case it exists for.
 */
export function sweepTriggerCompletionPauses(nowMs = Date.now()): Promise<{ paused: string[]; resumed: string[] }> {
  return serial(async () => {
    const { listTasks } = await import('../task-manager.js');
    const [tasks, jobs, file] = await Promise.all([listTasks(), allJobs(), readRecord()]);
    const byId = new Map(tasks.map((t) => [t.id, t] as const));
    const since = typeof file.sweptAtMs === 'number' ? file.sweptAtMs - SWEEP_OVERLAP_MS : -Infinity;
    const out = { paused: [] as string[], resumed: [] as string[] };
    for (const [taskId, rec] of Object.entries(file.tasks)) {
      const task = byId.get(taskId);
      if (!task) { delete file.tasks[taskId]; continue; }
      if (task.phase !== 'COMPLETE') out.resumed.push(...await resumeFor(taskId, jobs, file));
      else if (!rec.triggers.length && nowMs - rec.atMs > EMPTY_RECORD_KEEP_MS) delete file.tasks[taskId];
    }
    for (const task of tasks) {
      if (task.phase !== 'COMPLETE' || file.tasks[task.id]) continue;
      const doneAt = task.completed_at ? Date.parse(task.completed_at) : NaN;
      if (Number.isFinite(doneAt) ? doneAt < since : since !== -Infinity) continue;
      // Nothing aimed at it is armed: no record needed (most completed tasks).
      if (!triggersOf(jobs, task.id).some((j) => j.enabled)) continue;
      const paused = await pauseFor(task, jobs, file, Number.isFinite(doneAt) ? { createdBeforeMs: doneAt } : {});
      out.paused.push(...paused.map((p) => p.id));
    }
    file.sweptAtMs = nowMs;
    await writeJsonFile(recordPath(), file);
    if (out.paused.length || out.resumed.length) log.cron.info('trigger completion pass', out);
    return out;
  });
}

/** What a reopen would resume, for tests and diagnostics. */
export async function completionPausesOf(taskId: string): Promise<PausedTrigger[]> {
  return (await readRecord()).tasks[taskId]?.triggers ?? [];
}

let live = false;

/** Leader only (wired beside complete-archive.ts in server.ts). */
export async function startTriggerCompletionPause(): Promise<void> {
  if (live) return;
  live = true;
  const { bus, EventNames } = await import('../event-bus.js');
  bus.subscribe(SUBSCRIBER, (event) => {
    if (event.name !== EventNames.TASK_PHASE_CHANGED) return;
    const data = event.data as { task?: Task; newPhase?: string; oldPhase?: string } | undefined;
    const id = data?.task?.id;
    if (!id || data.newPhase === data.oldPhase) return;
    const fail = (what: string) => (err: unknown) => log.cron.warn(what, { taskId: id, error: err instanceof Error ? err.message : String(err) });
    if (data.newPhase === 'COMPLETE') void onTaskCompleted(id).catch(fail('pausing a completed task\'s triggers failed'));
    else if (data.oldPhase === 'COMPLETE') void onTaskReopened(id).catch(fail('resuming a reopened task\'s triggers failed'));
  }, { global: true, interest: [EventNames.TASK_PHASE_CHANGED] });
  void sweepTriggerCompletionPauses().catch((err) => log.cron.warn('trigger completion pass failed', { error: err instanceof Error ? err.message : String(err) }));
}

export async function stopTriggerCompletionPause(): Promise<void> {
  if (!live) return;
  live = false;
  const { bus } = await import('../event-bus.js');
  bus.unsubscribe(SUBSCRIBER);
}
