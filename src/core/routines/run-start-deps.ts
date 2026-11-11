/**
 * The real wiring behind routines/run-start.ts. Kept apart so the starter's
 * rules are tested against fakes, and so this file is the one list of what a
 * routine start touches: the launch, the session record, the task, the cron
 * store, the notification feed.
 */

import { randomUUID } from 'node:crypto';
import { bus, EventNames } from '../event-bus.js';
import { log } from '../../logging/index.js';
import type { RoutineLaunch, RoutineStart, SessionRecord, Task } from '../types.js';

export interface RunStartDeps {
  now(): number;
  sleep(ms: number): Promise<void>;
  /** A session id for the launch, or undefined for an engine that issues its own. */
  /** `model`: a run that names one never falls back (quickStartSession). `project`: its launch
   *  defaults may name the engine (project-launch-defaults.ts). */
  mintSessionId(host: string | undefined, model?: string, project?: string): Promise<string | undefined>;
  /** `continued`: the task already held a conversation, and the message continued it there. */
  launch(launch: RoutineLaunch, opts: { preassignedSessionId?: string; existingTaskId?: string; queuedAt?: string; byPerson?: boolean; record?: RoutineStart }): Promise<{ task: Task; continued?: string; queued?: true }>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  sessionsForTask(taskId: string): Promise<SessionRecord[]>;
  getTask(taskId: string): Promise<Task | null>;
  findRun?(jobId: string, runAt: string): Promise<Task | null>;
  writeStart(taskId: string, start: RoutineStart): Promise<void>;
  failClaimedStart?(taskId: string, expected: RoutineStart, error: string): Promise<boolean>;
  /** Mark an attempt's never-spawned record failed, so the task is free for the retry. */
  failSession(sessionId: string, reason: string): Promise<void>;
  /** The host's daemon is connected (undefined = this machine). */
  hostServing(host: string | undefined): Promise<boolean>;
  /**
   * Ask the session's host to cancel a start that has not come up: 'cancelled'
   * (the daemon now refuses that start for good), 'alive' (it is running), or
   * 'unknown' (the host is not connected, too old, or did not answer).
   */
  cancelStart(sessionId: string): Promise<'cancelled' | 'alive' | 'unknown'>;
  /** Calls back with each SESSION_ERROR text for the session; returns the unsubscribe. */
  onSessionError(sessionId: string, cb: (text: string) => void): () => void;
  recordFailure(start: RoutineStart, taskId: string, error: string): Promise<void>;
  recordStartedOnRetry(start: RoutineStart, taskId: string): Promise<void>;
  /** The run did not happen: the task needs the user, with the reason on it. */
  handBack(taskId: string, start: RoutineStart, error: string): Promise<void>;
}

const LOCAL = '__local__';
/** Capacity is persisted on the run's task; no inline wait holds a trigger's delivery. */
export const ROUTINE_WAIT_MS = 0;
/** How long a started run's slot stays counted, as a task start's (task-start.ts). */
const SLOT_HOLD_MS = 60_000;

export function defaultRunStartDeps(): RunStartDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
    async mintSessionId(host, model, project) {
      const { getConfig } = await import('../config-manager.js');
      const { resolveDefaultEngine } = await import('../agents/default-engine.js');
      const { isAcpEngine, normalizeEngine } = await import('../agents/engine-registry.js');
      const h = host && host !== LOCAL ? host : undefined;
      // The same resolution quickStartSession makes for an omitted engine: an id
      // is minted only for an engine that accepts one.
      const config = await getConfig();
      // A project that sets launch defaults decides the engine (and its fallback) the same way.
      const { hasLaunchDefaults, pickLaunchDefaults, projectLaunchDefaultsOf } = await import('../sessions/project-launch-defaults.js');
      if (project && hasLaunchDefaults(await projectLaunchDefaultsOf(project))) {
        const pick = await pickLaunchDefaults({ config, project, host: h, named: { model }, decidesFallback: !model || model === 'default' });
        return isAcpEngine(pick.engine) ? undefined : randomUUID();
      }
      const inherited = resolveDefaultEngine(config, { host: h });
      // A run whose default engine is out of usage starts on the fallback (quickStartSession), which
      // may be an engine that issues its own ids: decided the same way here, before minting.
      const { resolveFallbackLaunch } = await import('../agents/fallback-engine.js');
      const fallback = model && model !== 'default' ? null : await resolveFallbackLaunch(config, inherited, h, { quiet: true }).catch(() => null);
      const engine = normalizeEngine(fallback?.engine ?? inherited);
      return isAcpEngine(engine) ? undefined : randomUUID();
    },
    async launch(launch, opts) {
      const { quickStartSession, continuedSessionOf } = await import('../sessions/quick-start.js');
      const { admitHostStart, holdSlotFor, HostsFullError } = await import('../sessions/host-admission.js');
      const host = launch.host && launch.host !== LOCAL ? launch.host : LOCAL;
      if (opts.existingTaskId && !opts.queuedAt) {
        const { getTask } = await import('../task-manager.js');
        const waiting = await getTask(opts.existingTaskId);
        if (waiting.start_queue?.routine) {
          if (waiting.start_queue.routine.message === launch.message) return { task: waiting, queued: true };
          throw new Error(`Task ${waiting.id} has an earlier accepted capacity wait; this trigger message has not been accepted yet`);
        }
      }
      const quick = {
        message: launch.message, cwd: launch.cwd, host: launch.host, model: launch.model,
        ...(launch.taskTitle ? { taskTitle: launch.taskTitle } : {}),
        ...(launch.sessionTitle ? { sessionTitle: launch.sessionTitle } : {}),
        taskMeta: { pinTier: null }, ...(launch.project ? { project: launch.project } : {}),
        source: launch.source, ...(launch.walnutAgent ? { walnutAgent: true } : {}),
        ...(launch.agentId ? { agentId: launch.agentId } : {}),
      };
      let slot: (holdMs?: number) => void;
      try {
        slot = await admitHostStart(opts.existingTaskId ?? `routine-run:${opts.preassignedSessionId ?? randomUUID()}`, host, {
          automatic: !opts.byPerson, respectWaiting: !opts.queuedAt && !opts.byPerson,
        });
      } catch (error) {
        if (!(error instanceof HostsFullError) || opts.queuedAt) throw error;
        const { ensureRoutineQueueDataVersion } = await import('./capacity-data-version.js');
        await ensureRoutineQueueDataVersion();
        const task = await quickStartSession({ ...quick, deferStart: true,
          ...(opts.existingTaskId ? { existingTaskId: opts.existingTaskId } : {}),
        });
        const { updateTaskRaw, getTask } = await import('../task-manager.js');
        // Bind before publishing the durable queue, so boot cannot replay an unbound batch twice.
        const { isTriageRunTask } = await import('../triage/runs.js');
        if (isTriageRunTask(task)) {
          const { bindTriageClaim } = await import('../triage/state.js');
          await bindTriageClaim(task.id, Date.now());
        }
        await updateTaskRaw(task.id, (cur) => cur.phase === 'COMPLETE' || cur.start_queue ? null : {
          start_queue: { at: new Date().toISOString(), parent_id: task.id, caller_sid: '',
            host, reason: error.detail.reason, wait_for_slot: true, routine: launch,
            ...(opts.preassignedSessionId ? { routine_session_id: opts.preassignedSessionId } : {}),
            params: { message: launch.message, cwd: launch.cwd, ...(launch.host ? { host: launch.host } : {}), ...(launch.model ? { model: launch.model } : {}), expectReply: false } },
          ...(opts.record ? { routine_start: { ...opts.record, waited_for_slot: true as const } } : {}),
        }, { source: 'start-queue', emitEvent: true, push: false });
        const waiting = await getTask(task.id);
        if (!waiting.start_queue) throw new Error('The routine run was closed before its capacity wait was recorded');
        // A second fire on one target is still owed, not silently replaced by the first wait.
        // Its caller retains the fire and retries after the accepted entry has started.
        if (waiting.start_queue.routine?.message !== launch.message) throw error;
        return { task: waiting, queued: true };
      }
      let claimedRecord: RoutineStart | undefined;
      if (opts.queuedAt) {
        const { updateTaskRaw } = await import('../task-manager.js');
        const claimed = await updateTaskRaw(opts.existingTaskId!, (cur) => {
          if (cur.phase === 'COMPLETE' || cur.start_queue?.at !== opts.queuedAt) return null;
          claimedRecord = cur.routine_start ? { ...cur.routine_start, attempt_at: new Date().toISOString() } : undefined;
          return { start_queue: null, ...(claimedRecord ? { routine_start: claimedRecord } : {}) };
        }, { source: 'start-queue', emitEvent: true, push: false });
        if (!claimed.changed) {
          slot();
          const { QueuedStartGoneError } = await import('../sessions/task-start.js');
          throw new QueuedStartGoneError(opts.existingTaskId!);
        }
      }
      let started = false;
      try {
        const task = await quickStartSession({ ...quick,
          ...(opts.preassignedSessionId ? { preassignedSessionId: opts.preassignedSessionId } : {}),
          ...(opts.existingTaskId ? { existingTaskId: opts.existingTaskId } : {}),
        });
        if (claimedRecord) (await routineRunStarter()).resumeFromCapacity(task.id, claimedRecord);
        const continued = continuedSessionOf(task);
        started = true;
        // Its session has its record now, counted by its task; the hold covers one not yet
        // marked running, under the task it made (review round 5, Sol: a new run's slot was let go).
        if (!opts.existingTaskId && task?.id) holdSlotFor(host, task.id, SLOT_HOLD_MS);
        return { task, ...(continued ? { continued } : {}) };
      } catch (error) {
        const text = error instanceof Error ? error.message : String(error);
        if (claimedRecord) await (await routineRunStarter()).failCapacity(opts.existingTaskId!, text, claimedRecord);
        else if (opts.queuedAt && opts.existingTaskId) {
          const { updateTaskRaw } = await import('../task-manager.js');
          await updateTaskRaw(opts.existingTaskId, (cur) => cur.start_queue || cur.phase === 'COMPLETE' ? null : {
            last_start: { id: randomUUID(), at: new Date().toISOString(), state: 'failed', error: text },
          }, { source: 'start-queue', emitEvent: true, push: false });
          if (launch.jobId) await this.recordFailure({ job_id: launch.jobId, job_name: launch.sessionTitle ?? launch.taskTitle ?? 'Trigger',
            run_at: opts.queuedAt, attempt_at: opts.queuedAt, attempt: 1, state: 'failed' }, opts.existingTaskId, text);
        }
        throw error;
      } finally {
        slot(started && opts.existingTaskId ? SLOT_HOLD_MS : 0);
      }
    },
    async getSession(sessionId) {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      return await getSessionByClaudeId(sessionId).catch(() => null);
    },
    async sessionsForTask(taskId) {
      const { getSessionsForTask } = await import('../session-tracker.js');
      return await getSessionsForTask(taskId).catch(() => []);
    },
    async getTask(taskId) {
      const { getTask } = await import('../task-manager.js');
      return await getTask(taskId).catch(() => null);
    },
    async findRun(jobId, runAt) {
      const { listTasks } = await import('../task-manager.js');
      return (await listTasks()).find((t) => t.routine_start?.job_id === jobId && t.routine_start.run_at === runAt) ?? null;
    },
    async writeStart(taskId, start) {
      const { updateTaskRaw } = await import('../task-manager.js');
      await updateTaskRaw(taskId, { routine_start: start }, { source: 'routine', push: false, emitEvent: true })
        .catch((err) => log.cron.warn('routine start: task write failed', {
          taskId, error: err instanceof Error ? err.message : String(err),
        }));
    },
    async failClaimedStart(taskId, expected, error) {
      const { updateTaskRaw } = await import('../task-manager.js');
      const result = await updateTaskRaw(taskId, (cur) => {
        const rs = cur.routine_start;
        if (cur.phase === 'COMPLETE' || cur.start_queue || !rs || rs.state !== 'starting'
          || rs.run_at !== expected.run_at || rs.attempt_at !== expected.attempt_at || rs.session_id !== expected.session_id) return null;
        return { routine_start: { ...rs, state: 'failed' as const, launch: undefined, error } };
      }, { source: 'routine', emitEvent: true, push: false });
      return result.changed;
    },
    async failSession(sessionId, reason) {
      const { getSessionByClaudeId, updateSessionRecord } = await import('../session-tracker.js');
      const rec = await getSessionByClaudeId(sessionId).catch(() => null);
      // It came up after all: that record is a real session, not ours to mark.
      const { startVerdictOf } = await import('./run-start.js');
      if (!rec || startVerdictOf(rec).kind === 'started') return;
      await updateSessionRecord(sessionId, {
        process_status: 'error', status_reason: 'api_error', status_changed_by: 'session-runner',
        errorMessage: reason.slice(0, 500),
      }).catch(() => {});
    },
    async hostServing(host) {
      const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
      return !!getConnectedDaemonConnection(host && host !== LOCAL ? host : LOCAL);
    },
    async cancelStart(sessionId) {
      const { getSessionByClaudeId } = await import('../session-tracker.js');
      const { getConnectedDaemonConnection } = await import('../../providers/daemon-connection.js');
      const rec = await getSessionByClaudeId(sessionId).catch(() => null);
      const conn = getConnectedDaemonConnection(rec?.host && rec.host !== LOCAL ? rec.host : LOCAL);
      if (!conn || !conn.hasCapability('cancel-pending-start-v1')) return 'unknown';
      // The same daemon command a task start uses to retry an unconfirmed start (sessions/task-start.ts).
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const res = await Promise.race([
          conn.send('cancelPendingStart', { sid: sessionId }, 5_000),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('no answer')), 8_000); }),
        ]) as { ok?: boolean; alive?: boolean; cancelled?: boolean };
        if (res.alive) return 'alive';
        return res.ok !== false && res.cancelled === true ? 'cancelled' : 'unknown';
      } catch (err) {
        log.cron.warn('routine start: cancel of an unconfirmed start failed', { sessionId, error: err instanceof Error ? err.message : String(err) });
        return 'unknown';
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
    onSessionError(sessionId, cb) {
      const name = `routine-start-${sessionId}-${randomUUID()}`;
      bus.subscribe(name, (event) => {
        if (event.name !== EventNames.SESSION_ERROR) return;
        const d = event.data as { sessionId?: string; error?: string; errorKind?: string };
        // delivery_failed is a queued message's connectivity, not this spawn.
        if (d.sessionId !== sessionId || d.errorKind === 'delivery_failed' || !d.error) return;
        cb(d.error);
      }, { global: true, interest: [EventNames.SESSION_ERROR] });
      return () => bus.unsubscribe(name);
    },
    async recordFailure(start, taskId, error) {
      const { getCronService } = await import('../../web/routes/cron.js');
      await getCronService()?.recordRunStartFailure(start.job_id, {
        runAtMs: Date.parse(start.run_at), error, ref: taskId,
        ...(start.session_id ? { sessionId: start.session_id } : {}),
      });
    },
    async recordStartedOnRetry(start, taskId) {
      const { getCronService } = await import('../../web/routes/cron.js');
      const { auditDelivery } = await import('../cron/trigger-audit.js');
      await getCronService()?.recordRunOutcome(start.job_id, {
        atMs: Date.parse(start.run_at),
        outcome: 'fired',
        delivery: auditDelivery({
          status: 'ok', retry: false,
          summary: `task ${taskId}: its session started ${start.waited_for_slot ? 'after waiting for a free slot' : 'on the second try'}`,
          ...(start.session_id ? { sessionId: start.session_id } : {}),
        }),
      }, taskId);
    },
    async handBack(taskId, start, error) {
      const { addNote, updateTask } = await import('../task-manager.js');
      const at = start.run_at.replace('T', ' ').replace(/:\d\d(\.\d+)?Z$/, ' UTC');
      await addNote(taskId, `Routine "${start.job_name}" (run of ${at}) did not run. ${error.replace(/[.\s]+$/, '')}. `
        + 'Start this task to run it now, or the routine runs again at its next time.')
        .catch((err) => log.cron.warn('routine start: note failed', { taskId, error: err instanceof Error ? err.message : String(err) }));
      await updateTask(taskId, { phase: 'NEED_ACTION' }, { source: 'routine' })
        .catch((err) => log.cron.warn('routine start: hand-back failed', { taskId, error: err instanceof Error ? err.message : String(err) }));
      const { addNotification } = await import('../notifications/store.js');
      await addNotification({
        kind: 'cron', severity: 'warning',
        title: `Routine "${start.job_name}" did not run`,
        body: error,
        dedupKey: `routine-start:${start.job_id}:${start.run_at}`,
        taskId,
      }).catch(() => { /* the routine card and the task already carry it */ });
    },
  };
}

let shared: import('./run-start.js').RoutineRunStarter | null = null;

/**
 * The deadlines, each overridable by env for tests (`WALNUT_ROUTINE_START_<NAME>_MS`:
 * INLINE, DEADLINE, RETRY, HOST_WAIT, STALE, POLL).
 */
export function runStartTimingsFromEnv(env: NodeJS.ProcessEnv, defaults: import('./run-start.js').RunStartTimings): import('./run-start.js').RunStartTimings {
  const read = (name: string, def: number): number => {
    const raw = env[`WALNUT_ROUTINE_START_${name}_MS`];
    if (raw === undefined || raw.trim() === '') return def;
    const n = Number(raw);
    return Number.isFinite(n) && n >= 0 ? Math.min(n, 24 * 3_600_000) : def;
  };
  return {
    inlineWaitMs: read('INLINE', defaults.inlineWaitMs),
    attemptDeadlineMs: read('DEADLINE', defaults.attemptDeadlineMs),
    retryDelayMs: read('RETRY', defaults.retryDelayMs),
    hostWaitMs: read('HOST_WAIT', defaults.hostWaitMs),
    staleAfterMs: read('STALE', defaults.staleAfterMs),
    pollMs: Math.max(10, read('POLL', defaults.pollMs)),
  };
}

/** The process's one starter on the real wiring (the executors and the boot pickup share it). */
export async function routineRunStarter(): Promise<import('./run-start.js').RoutineRunStarter> {
  if (!shared) {
    const { RoutineRunStarter, DEFAULT_RUN_START_TIMINGS } = await import('./run-start.js');
    shared = new RoutineRunStarter(defaultRunStartDeps(), runStartTimingsFromEnv(process.env, DEFAULT_RUN_START_TIMINGS));
  }
  return shared;
}

/** Tests: forget the shared starter (its timings were read from env once). */
export function _resetRoutineRunStarterForTesting(): void {
  shared = null;
}

/**
 * After boot: pick up every routine start a previous server left unsettled. An
 * ephemeral server's tasks are copies of the real ones, so it never retries them.
 */
export async function resumeRoutineStarts(): Promise<number> {
  const { IS_EPHEMERAL } = await import('../../constants.js');
  if (IS_EPHEMERAL) return 0;
  const { listTasks } = await import('../task-manager.js');
  const open = (await listTasks()).filter((t) => t.routine_start?.state === 'starting' && t.phase !== 'COMPLETE' && !t.start_queue?.routine);
  if (open.length === 0) return 0;
  const starter = await routineRunStarter();
  for (const t of open) starter.resume(t.id, t.routine_start!);
  log.cron.info('routine start: picked up unsettled starts', { count: open.length, taskIds: open.map((t) => t.id) });
  return open.length;
}
