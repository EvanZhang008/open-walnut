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
  mintSessionId(host: string | undefined): Promise<string | undefined>;
  /** `continued`: the task already held a conversation, and the message continued it there. */
  launch(launch: RoutineLaunch, opts: { preassignedSessionId?: string; existingTaskId?: string }): Promise<{ task: Task; continued?: string }>;
  getSession(sessionId: string): Promise<SessionRecord | null>;
  sessionsForTask(taskId: string): Promise<SessionRecord[]>;
  getTask(taskId: string): Promise<Task | null>;
  writeStart(taskId: string, start: RoutineStart): Promise<void>;
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

export function defaultRunStartDeps(): RunStartDeps {
  return {
    now: () => Date.now(),
    sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms).unref?.(); }),
    async mintSessionId(host) {
      const { getConfig } = await import('../config-manager.js');
      const { resolveDefaultEngine } = await import('../agents/default-engine.js');
      const { isAcpEngine, normalizeEngine } = await import('../agents/engine-registry.js');
      const h = host && host !== LOCAL ? host : undefined;
      // The same resolution quickStartSession makes for an omitted engine: an id
      // is minted only for an engine that accepts one.
      const engine = normalizeEngine(resolveDefaultEngine(await getConfig(), { host: h }));
      return isAcpEngine(engine) ? undefined : randomUUID();
    },
    async launch(launch, opts) {
      const { quickStartSession, continuedSessionOf } = await import('../sessions/quick-start.js');
      const task = await quickStartSession({
        message: launch.message,
        cwd: launch.cwd,
        host: launch.host,
        model: launch.model,
        ...(launch.taskTitle ? { taskTitle: launch.taskTitle } : {}),
        // Background automation: an explicit null keeps every run off the pinned board.
        taskMeta: { pinTier: null },
        ...(launch.project ? { project: launch.project } : {}),
        source: launch.source,
        ...(launch.walnutAgent ? { walnutAgent: true } : {}),
        ...(launch.agentId ? { agentId: launch.agentId } : {}),
        ...(opts.preassignedSessionId ? { preassignedSessionId: opts.preassignedSessionId } : {}),
        ...(opts.existingTaskId ? { existingTaskId: opts.existingTaskId } : {}),
      });
      const continued = continuedSessionOf(task);
      return { task, ...(continued ? { continued } : {}) };
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
    async writeStart(taskId, start) {
      const { updateTaskRaw } = await import('../task-manager.js');
      await updateTaskRaw(taskId, { routine_start: start }, { source: 'routine', push: false })
        .catch((err) => log.cron.warn('routine start: task write failed', {
          taskId, error: err instanceof Error ? err.message : String(err),
        }));
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
          summary: `task ${taskId}: its session started on the second try`,
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
  const open = (await listTasks()).filter((t) => t.routine_start?.state === 'starting' && t.phase !== 'COMPLETE');
  if (open.length === 0) return 0;
  const starter = await routineRunStarter();
  for (const t of open) starter.resume(t.id, t.routine_start!);
  log.cron.info('routine start: picked up unsettled starts', { count: open.length, taskIds: open.map((t) => t.id) });
  return open.length;
}
