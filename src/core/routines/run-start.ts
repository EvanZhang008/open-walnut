/**
 * A routine run that starts a session is a run only once that session is up.
 *
 * The claude-code executor and the isolated walnut-agent path both create a task
 * and emit SESSION_START, which the session runner handles on its own time. They
 * used to report the run 'ok' the moment the event was out. 2026-10-26: this
 * Mac's session daemon was down from 08:00 to 09:16 PT; the 08:00 run of a
 * twice-daily routine was caught up at 09:17, its task was made, the spawn
 * failed, and because the launch carried no session id nothing recorded the
 * failure anywhere. The routine read "OK", the task sat In Progress with no
 * session, and only a later reflection noticed.
 *
 * Now every such launch mints its session id (so the record exists before the
 * spawn and the spawn's failure lands on it), and the run is held to a start
 * deadline:
 *
 *   attempt 1 ── started ──────────────────────────────► done (run ok)
 *      │ failed, or no process within the deadline
 *      ▼
 *   wait (retry delay, then up to hostWaitMs for the host's daemon to serve)
 *      ▼
 *   the host cancels attempt 1 ── it is running after all ► done (run ok)
 *      │ cancelled (the daemon now refuses that start for good)
 *      ▼
 *   attempt 2 on the same task ── started ─────────────► done (row says "on retry")
 *      │ failed again
 *      ▼
 *   run recorded failed on the routine (lastStatus/lastError, a History row),
 *   the task handed back (NEED_ACTION + a note with the reason), one notification
 *
 * Attempt 1 is cancelled on its host before attempt 2 goes, because a start
 * that missed its deadline may still run: the daemon executes a buffered start
 * once it unwedges (inc-1787511363340), and the two would run the routine twice
 * under two session ids. When the host cannot confirm the cancel, the run is not
 * retried, unless the runner itself reported the spawn failed. A run more than
 * staleAfterMs past its time (a server down for hours) is never started late.
 *
 * The first few seconds are waited inline so an ordinary run reports a confirmed
 * start; the rest runs after the executor returns, because the cron lane runs
 * jobs one by one and a trigger fire has a 2-minute delivery budget. The state
 * rides the task (`routine_start`), so a restart in the middle picks it up.
 */

import type { RoutineLaunch, RoutineStart, SessionRecord, Task } from '../types.js';
import { log } from '../../logging/index.js';
import type { RunStartDeps } from './run-start-deps.js';

export type { RoutineLaunch, RoutineStart };

export interface RunStartTimings {
  /** Waited inside the executor before it returns. */
  inlineWaitMs: number;
  /** One attempt's deadline, from its launch. */
  attemptDeadlineMs: number;
  /** Pause between a failed first attempt and the retry. */
  retryDelayMs: number;
  /** After the pause, how long the retry waits for the host's daemon to serve. */
  hostWaitMs: number;
  /** A run this far past its time is not retried (a start picked up after a long outage). */
  staleAfterMs: number;
  pollMs: number;
}

export const DEFAULT_RUN_START_TIMINGS: RunStartTimings = {
  inlineWaitMs: 15_000,
  attemptDeadlineMs: 120_000,
  retryDelayMs: 60_000,
  hostWaitMs: 10 * 60_000,
  staleAfterMs: 6 * 3_600_000,
  pollMs: 500,
};

export type StartVerdict =
  | { kind: 'started' }
  | { kind: 'failed'; reason: string }
  | { kind: 'pending' };

const LIVE = new Set(['running', 'idle']);

/**
 * Stamps a record keeps when no process ever ran for it: the seed, a start that
 * failed or was swept as an orphan, a restart before the spawn. A record that
 * ran keeps its outputFile and moves to a run's own stamp (a turn's end, the
 * snapshot projection, an exit the daemon reported), and its pid is cleared
 * when the process ends: so a pid alone cannot be the test.
 */
const NEVER_RAN = new Set(['awaiting_spawn', 'api_error', 'orphan_no_pid', 'server_restart']);

/**
 * Stamps only a session that ran gets: a turn, an exit or a stop of a running
 * process, the snapshot of a session its daemon holds. Every other stamp on a
 * record with no pid and no output file (a host that went away, a liveness probe
 * that failed) says nothing about the start, so the deadline and the host decide.
 */
const RAN = new Set([
  'session_started', 'turn_completed', 'message_sent', 'normal_completion', 'idle_timeout', 'idle_eviction',
  'daemon_reported_exit', 'turn_interrupted', 'user_stopped', 'user_terminated', 'expected_teardown',
  'restart_reinitialize', 'auto_recovered', 'reconciled_authoritative', 'streaming_evidence_self_heal',
  'snapshot_projection',
]);

/**
 * What a session record says about its start. A pid or an output file is the
 * daemon's confirmation; a stopped or errored record that never left the
 * never-ran stamps is a start that failed. `spawn_outcome_unknown` is not a
 * verdict: the daemon may still run the start. Nor is a host-loss stamp.
 */
export function startVerdictOf(rec: SessionRecord | null, errorText?: string): StartVerdict {
  if (!rec) return { kind: 'pending' };
  if (typeof rec.pid === 'number' && rec.pid > 1) return { kind: 'started' };
  if (rec.outputFile) return { kind: 'started' };
  if (LIVE.has(rec.process_status) && rec.status_reason !== 'awaiting_spawn') return { kind: 'started' };
  if (rec.status_reason === 'spawn_outcome_unknown') return { kind: 'pending' };
  if (rec.process_status === 'stopped' || rec.process_status === 'error') {
    if (rec.status_reason && RAN.has(rec.status_reason)) return { kind: 'started' };
    if (!rec.status_reason || NEVER_RAN.has(rec.status_reason)) {
      return { kind: 'failed', reason: errorText || rec.errorMessage || 'the session process could not be started' };
    }
    return errorText ? { kind: 'failed', reason: errorText } : { kind: 'pending' };
  }
  // The runner's SESSION_ERROR for a spawn that never got a pid.
  if (errorText) return { kind: 'failed', reason: errorText };
  return { kind: 'pending' };
}

/** A session on the task that came up, other than the attempt being judged. */
function startedElsewhere(sessions: SessionRecord[], exceptSid: string | undefined, sinceIso: string): boolean {
  return sessions.some((s) => s.claudeSessionId !== exceptSid && !s.archived
    && (s.startedAt ?? '') >= sinceIso && startVerdictOf(s).kind === 'started');
}

export interface RoutineRunInput {
  job: { id: string; name: string };
  /** The run's dispatch time (the routine's `runningAtMs`), which keys its result. */
  runAtMs: number;
  launch: RoutineLaunch;
}

export interface RoutineRunStarted {
  task: Task;
  sessionId?: string;
  /** 'started': confirmed inline. 'pending': the watch decides after the executor returns. */
  confirmed: boolean;
}

interface ErrorTap { text?: string; stop: () => void }

/** Watches still running in this process, by task id (tests and the boot pickup). */
const watches = new Map<string, Promise<void>>();

export function _runStartWatchesForTesting(): Map<string, Promise<void>> {
  return watches;
}

export class RoutineRunStarter {
  constructor(private readonly deps: RunStartDeps, private readonly t: RunStartTimings = DEFAULT_RUN_START_TIMINGS) {}

  /**
   * Make the run's task, start its session, and hold the run to its deadline.
   * A launch that throws (the host gate, an unknown agent) throws to the caller,
   * which reports it as the run's error the way it always did.
   */
  async start(input: RoutineRunInput): Promise<RoutineRunStarted> {
    const sid = await this.deps.mintSessionId(input.launch.host);
    const attemptAt = this.deps.now();
    // Listening before the launch: a spawn can fail before the launch returns.
    const tap = this.tap(sid);
    let task: Task;
    try {
      ({ task } = await this.deps.launch(input.launch, { preassignedSessionId: sid }));
    } catch (err) {
      tap.stop();
      throw err;
    }
    const record: RoutineStart = {
      job_id: input.job.id,
      job_name: input.job.name,
      run_at: new Date(input.runAtMs).toISOString(),
      attempt: 1,
      attempt_at: new Date(attemptAt).toISOString(),
      ...(sid ? { session_id: sid } : {}),
      state: 'starting',
      launch: input.launch,
    };
    await this.deps.writeStart(task.id, record);
    const inline = await this.observe(task.id, sid, record.attempt_at, tap, attemptAt + Math.min(this.t.inlineWaitMs, this.t.attemptDeadlineMs));
    if (inline.kind === 'started') {
      tap.stop();
      await this.settle(task.id, record, { state: 'started' });
      return { task, ...(sid ? { sessionId: sid } : {}), confirmed: true };
    }
    this.follow(task.id, record, tap);
    return { task, ...(sid ? { sessionId: sid } : {}), confirmed: false };
  }

  /** Continue a start a previous server process left unsettled. */
  resume(taskId: string, record: RoutineStart): void {
    if (record.state !== 'starting' || watches.has(taskId)) return;
    this.follow(taskId, record, this.tap(record.session_id));
  }

  /** The newest SESSION_ERROR text for one attempt's session: the reason a record does not keep. */
  private tap(sid: string | undefined): ErrorTap {
    const tap: ErrorTap = { stop: () => {} };
    if (sid) tap.stop = this.deps.onSessionError(sid, (text) => { tap.text = text; });
    return tap;
  }

  private follow(taskId: string, record: RoutineStart, tap: ErrorTap): void {
    const run = this.finish(taskId, record, tap)
      .catch((err) => log.cron.error('routine start watch failed', {
        taskId, jobId: record.job_id, error: err instanceof Error ? err.message : String(err),
      }))
      .finally(() => { if (watches.get(taskId) === run) watches.delete(taskId); });
    watches.set(taskId, run);
  }

  private async finish(taskId: string, first: RoutineStart, firstTap: ErrorTap): Promise<void> {
    let current = first;
    let verdict = await this.watchAttempt(taskId, current, firstTap);
    if (verdict.kind === 'started') return await this.started(taskId, current);
    let reason = verdict.reason;
    if (current.attempt === 1) {
      log.cron.warn('routine run: session did not start, retrying once', { taskId, jobId: current.job_id, sessionId: current.session_id, reason });
      await this.deps.sleep(this.t.retryDelayMs);
      await this.waitForHost(current.launch?.host);
      const fate = current.session_id ? await this.deps.cancelStart(current.session_id) : 'cancelled';
      if (fate === 'alive') return await this.started(taskId, current);
      const blocked = await this.retryBlocker(taskId, current, fate, verdict.definite);
      if (blocked === 'started') return await this.started(taskId, current);
      if (blocked === 'closed') {
        if (current.session_id) await this.deps.failSession(current.session_id, reason);
        await this.settle(taskId, current, { state: 'failed', error: 'the task was closed before its retry' });
        return;
      }
      if (blocked) {
        reason = `${reason}; ${blocked}`;
      } else {
        if (current.session_id) await this.deps.failSession(current.session_id, reason);
        const retried = await this.retry(taskId, current);
        if ('continued' in retried) {
          await this.settle(taskId, { ...current, session_id: retried.continued }, { state: 'started' });
          return;
        }
        if ('error' in retried) {
          reason = `${reason}; the retry could not be launched: ${retried.error}`;
        } else {
          current = retried.record;
          verdict = await this.watchAttempt(taskId, current, retried.tap);
          if (verdict.kind === 'started') return await this.started(taskId, current);
          reason = verdict.reason;
          // The last attempt too may still come up: cancel it if its host answers now.
          if (current.session_id && (await this.deps.cancelStart(current.session_id)) === 'alive') {
            return await this.started(taskId, current);
          }
        }
      }
    }
    if (current.session_id) await this.deps.failSession(current.session_id, reason);
    const error = `The session for this run never started (${current.attempt === 2 ? 'tried twice' : 'not retried'}): ${reason}`;
    log.cron.error('routine run: session never started', { taskId, jobId: current.job_id, reason });
    await this.settle(taskId, current, { state: 'failed', error });
    await this.deps.recordFailure(current, taskId, error);
    // The user may have closed or started the task while the run was being tried.
    const task = await this.deps.getTask(taskId);
    if (!task || task.phase === 'COMPLETE') return;
    if (startedElsewhere(await this.deps.sessionsForTask(taskId), current.session_id, first.attempt_at)) return;
    await this.deps.handBack(taskId, current, error);
  }

  private async started(taskId: string, rs: RoutineStart): Promise<void> {
    await this.settle(taskId, rs, { state: 'started' });
    if (rs.attempt === 2) await this.deps.recordStartedOnRetry(rs, taskId);
  }

  /**
   * Why attempt 1 must not be retried, if anything: 'started' (it or another
   * session came up), 'closed', or the reason to add to the failure.
   */
  private async retryBlocker(
    taskId: string,
    current: RoutineStart,
    fate: 'cancelled' | 'unknown',
    definite: boolean,
  ): Promise<'started' | 'closed' | string | null> {
    const task = await this.deps.getTask(taskId);
    if (!task || task.phase === 'COMPLETE') return 'closed';
    if (current.session_id && startVerdictOf(await this.deps.getSession(current.session_id)).kind === 'started') return 'started';
    if (startedElsewhere(await this.deps.sessionsForTask(taskId), current.session_id, current.attempt_at)) return 'started';
    if (fate === 'unknown' && !definite) {
      return 'its host did not confirm the first try was stopped, so it was not retried (a second start could run it twice)';
    }
    const late = this.deps.now() - Date.parse(current.run_at);
    if (late > this.t.staleAfterMs) {
      return `the run is ${Math.round(late / 3_600_000)}h past its time, too late to start it now`;
    }
    if (!current.launch) return 'the retry had nothing to start from';
    return null;
  }

  private async retry(taskId: string, prev: RoutineStart): Promise<{ record: RoutineStart; tap: ErrorTap } | { continued: string } | { error: string }> {
    const launch = prev.launch!;
    const sid = await this.deps.mintSessionId(launch.host);
    const next: RoutineStart = {
      ...prev,
      attempt: 2,
      attempt_at: new Date(this.deps.now()).toISOString(),
      ...(sid ? { session_id: sid } : { session_id: undefined }),
    };
    await this.deps.writeStart(taskId, next);
    const tap = this.tap(sid);
    try {
      const { continued } = await this.deps.launch(launch, { preassignedSessionId: sid, existingTaskId: taskId });
      // The task had a conversation after all (one session per task): the run went there.
      if (continued && continued !== sid) {
        tap.stop();
        return { continued };
      }
    } catch (err) {
      tap.stop();
      return { error: err instanceof Error ? err.message : String(err) };
    }
    log.cron.info('routine run: retry launched', { taskId, jobId: prev.job_id, sessionId: sid });
    return { record: next, tap };
  }

  /**
   * One attempt, from its launch to its deadline (a resumed watch keeps the
   * original clock). `definite`: this process heard the runner say the spawn
   * failed, so no process can come up for it later.
   */
  private async watchAttempt(
    taskId: string,
    rs: RoutineStart,
    tap: ErrorTap,
  ): Promise<{ kind: 'started' } | { kind: 'failed'; reason: string; definite: boolean }> {
    try {
      const deadline = Date.parse(rs.attempt_at) + this.t.attemptDeadlineMs;
      const v = await this.observe(taskId, rs.session_id, rs.attempt_at, tap, deadline);
      if (v.kind === 'started') return v;
      if (v.kind === 'failed') return { ...v, definite: !!tap.text };
      return { kind: 'failed', reason: `no session process came up within ${Math.round(this.t.attemptDeadlineMs / 1000)}s`, definite: false };
    } finally {
      tap.stop();
    }
  }

  private async observe(
    taskId: string,
    sid: string | undefined,
    sinceIso: string,
    tap: ErrorTap,
    deadline: number,
  ): Promise<StartVerdict> {
    for (;;) {
      let v: StartVerdict;
      if (sid) {
        v = startVerdictOf(await this.deps.getSession(sid), tap.text);
      } else {
        // An engine that issues its own id: the task's newest session since the launch.
        const mine = (await this.deps.sessionsForTask(taskId))
          .filter((s) => (s.startedAt ?? '') >= sinceIso)
          .sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))[0] ?? null;
        v = startVerdictOf(mine);
      }
      if (v.kind !== 'pending') return v;
      if (this.deps.now() >= deadline) return v;
      await this.deps.sleep(Math.min(this.t.pollMs, Math.max(0, deadline - this.deps.now())));
    }
  }

  private async waitForHost(host: string | undefined): Promise<void> {
    const until = this.deps.now() + this.t.hostWaitMs;
    while (!(await this.deps.hostServing(host)) && this.deps.now() < until) {
      await this.deps.sleep(Math.min(15_000, this.t.hostWaitMs));
    }
  }

  private async settle(taskId: string, rs: RoutineStart, patch: Pick<RoutineStart, 'state'> & { error?: string }): Promise<void> {
    const { launch: _dropped, ...rest } = rs;
    await this.deps.writeStart(taskId, { ...rest, ...patch });
  }
}
