/**
 * A routine run whose session never starts is retried once, then recorded
 * failed (src/core/routines/run-start.ts).
 *
 * 2026-10-26: this Mac's session daemon was down from 08:00 to 09:16 PT. The
 * 08:00 run of a twice-daily routine was caught up at 09:17, its task was made,
 * the spawn failed, and the run still read "OK": no session record, no error,
 * nothing on the routine or the task. These tests drive the starter on a virtual
 * clock with fake records, so each path (confirmed, failed then retried, never
 * started, the daemon coming back late, a restart in the middle) runs exactly.
 */

import { describe, it, expect } from 'vitest';
import { RoutineRunStarter, startVerdictOf, _runStartWatchesForTesting, type RunStartTimings } from '../../../src/core/routines/run-start.js';
import type { RunStartDeps } from '../../../src/core/routines/run-start-deps.js';
import type { RoutineLaunch, RoutineStart, SessionRecord, Task } from '../../../src/core/types.js';

const T0 = Date.parse('2026-10-26T16:17:36.000Z');

const TIMINGS: RunStartTimings = {
  inlineWaitMs: 15_000, attemptDeadlineMs: 120_000, retryDelayMs: 60_000, hostWaitMs: 10 * 60_000, staleAfterMs: 6 * 3_600_000, pollMs: 1_000,
};

const LAUNCH: RoutineLaunch = {
  message: 'Review how the organization worked in the last 12 hours.',
  cwd: '/home/walnut', model: 'opus', taskTitle: 'Org reflection', project: 'Routines', source: 'routine',
};

const DAEMON_DOWN = 'Local daemon failed to start — port file not created within 30s';

/** What the session runner does with one launch, decided by the test. */
type Spawn = 'up' | 'fail' | 'silent' | { at: number; then: 'up' | 'fail' };

class World {
  t = T0;
  seq = 0;
  sessions = new Map<string, SessionRecord>();
  tasks = new Map<string, Task>();
  launches: Array<{ launch: RoutineLaunch; preassignedSessionId?: string; existingTaskId?: string }> = [];
  starts: Array<{ taskId: string; start: RoutineStart }> = [];
  failed: Array<{ sid: string; reason: string }> = [];
  failures: Array<{ start: RoutineStart; taskId: string; error: string }> = [];
  retryOk: Array<{ start: RoutineStart; taskId: string }> = [];
  handBacks: Array<{ taskId: string; error: string }> = [];
  errorTaps = new Map<string, (text: string) => void>();
  serving = true;
  /** One entry per launch, in order. */
  plan: Spawn[] = [];
  pendingSpawns: Array<{ at: number; sid: string; then: 'up' | 'fail' }> = [];
  /** Things to do when the clock passes a time. */
  at: Array<{ at: number; fn: () => void }> = [];
  ownIds = true;
  continued: string | undefined;
  /** Starts the host cancelled: the daemon refuses them for good. */
  cancelled = new Set<string>();
  cancels: string[] = [];

  private spawn(sid: string, then: 'up' | 'fail'): void {
    const r = this.sessions.get(sid);
    if (!r || this.cancelled.has(sid)) return;
    if (then === 'up') {
      this.sessions.set(sid, { ...r, pid: 4242, process_status: 'running' });
    } else {
      this.sessions.set(sid, { ...r, process_status: 'stopped' });
      this.errorTaps.get(sid)?.(DAEMON_DOWN);
    }
  }

  private tick(): void {
    for (const p of this.pendingSpawns.filter((x) => x.at <= this.t)) {
      this.pendingSpawns.splice(this.pendingSpawns.indexOf(p), 1);
      this.spawn(p.sid, p.then);
    }
    for (const a of this.at.filter((x) => x.at <= this.t)) {
      this.at.splice(this.at.indexOf(a), 1);
      a.fn();
    }
  }

  deps(): RunStartDeps {
    return {
      now: () => this.t,
      sleep: async (ms) => { this.t += Math.max(1, ms); this.tick(); },
      mintSessionId: async () => (this.ownIds ? `sid-${++this.seq}` : undefined),
      launch: async (launch, opts) => {
        this.launches.push({ launch, ...opts });
        const id = opts.existingTaskId ?? `task-${this.launches.length}`;
        const task = this.tasks.get(id) ?? ({ id, title: launch.taskTitle, phase: 'IN_PROGRESS' } as Task);
        this.tasks.set(id, task);
        if (this.continued) return { task, continued: this.continued };
        const sid = opts.preassignedSessionId ?? `acp-${this.launches.length}`;
        // quickStartSession seeds the record before SESSION_START.
        this.sessions.set(sid, {
          claudeSessionId: sid, taskId: id, process_status: 'idle', status_reason: 'awaiting_spawn',
          startedAt: new Date(this.t).toISOString(),
        } as SessionRecord);
        const what = this.plan[this.launches.length - 1] ?? 'up';
        if (what === 'up' || what === 'fail') this.spawn(sid, what);
        else if (typeof what === 'object') this.pendingSpawns.push({ at: this.t + what.at, sid, then: what.then });
        return { task };
      },
      getSession: async (sid) => this.sessions.get(sid) ?? null,
      sessionsForTask: async (taskId) => [...this.sessions.values()].filter((s) => s.taskId === taskId),
      getTask: async (id) => this.tasks.get(id) ?? null,
      writeStart: async (taskId, start) => {
        this.starts.push({ taskId, start });
        const t = this.tasks.get(taskId);
        if (t) this.tasks.set(taskId, { ...t, routine_start: start });
      },
      failSession: async (sid, reason) => {
        this.failed.push({ sid, reason });
        const r = this.sessions.get(sid);
        if (r && !r.pid) this.sessions.set(sid, { ...r, process_status: 'error', status_reason: 'api_error', errorMessage: reason });
      },
      hostServing: async () => this.serving,
      cancelStart: async (sid) => {
        this.cancels.push(sid);
        const r = this.sessions.get(sid);
        if (r?.pid) return 'alive';
        if (!this.serving) return 'unknown';
        this.cancelled.add(sid);
        return 'cancelled';
      },
      onSessionError: (sid, cb) => { this.errorTaps.set(sid, cb); return () => this.errorTaps.delete(sid); },
      recordFailure: async (start, taskId, error) => { this.failures.push({ start, taskId, error }); },
      recordStartedOnRetry: async (start, taskId) => { this.retryOk.push({ start, taskId }); },
      handBack: async (taskId, _start, error) => {
        this.handBacks.push({ taskId, error });
        const t = this.tasks.get(taskId);
        if (t) this.tasks.set(taskId, { ...t, phase: 'NEED_ACTION' });
      },
    };
  }

  lastStart(taskId: string): RoutineStart | undefined {
    return this.tasks.get(taskId)?.routine_start;
  }
}

const JOB = { id: 'mvmrfw2l-4dad', name: 'Org reflection (every 12 hours)' };

async function run(w: World) {
  const starter = new RoutineRunStarter(w.deps(), TIMINGS);
  const started = await starter.start({ job: JOB, runAtMs: T0, launch: LAUNCH });
  await Promise.all([..._runStartWatchesForTesting().values()]);
  return started;
}

describe('a routine run is a run once its session is up', () => {
  it('a session that comes up is confirmed inline: one launch, a minted id, nothing retried', async () => {
    const w = new World();
    const started = await run(w);
    expect(started).toMatchObject({ confirmed: true, sessionId: 'sid-1' });
    expect(w.launches).toHaveLength(1);
    expect(w.launches[0].preassignedSessionId).toBe('sid-1');
    expect(w.lastStart('task-1')).toMatchObject({ state: 'started', attempt: 1, session_id: 'sid-1', job_id: JOB.id });
    // The launch copy is dropped once the run settles.
    expect(w.lastStart('task-1')?.launch).toBeUndefined();
    expect(w.failures).toEqual([]);
    expect(w.handBacks).toEqual([]);
  });

  it('while starting, the task carries what the retry needs', async () => {
    const w = new World();
    w.plan = ['silent', 'up'];
    await run(w);
    const first = w.starts.find((s) => s.start.state === 'starting' && s.start.attempt === 1)!;
    expect(first.start.launch).toEqual(LAUNCH);
    expect(first.start.run_at).toBe(new Date(T0).toISOString());
  });

  it('a spawn that fails is retried once on the same task, after the delay, and the retry is recorded', async () => {
    const w = new World();
    w.plan = ['fail', 'up'];
    const started = await run(w);
    expect(started.confirmed).toBe(false);
    expect(w.launches).toHaveLength(2);
    expect(w.launches[1]).toMatchObject({ existingTaskId: 'task-1', preassignedSessionId: 'sid-2' });
    // The first record is freed for the retry, with the runner's error as its reason.
    expect(w.failed).toEqual([{ sid: 'sid-1', reason: DAEMON_DOWN }]);
    expect(w.lastStart('task-1')).toMatchObject({ state: 'started', attempt: 2, session_id: 'sid-2' });
    expect(w.retryOk).toHaveLength(1);
    expect(w.failures).toEqual([]);
    expect(w.handBacks).toEqual([]);
    const retryAt = Date.parse(w.starts.find((s) => s.start.attempt === 2)!.start.attempt_at);
    expect(retryAt - T0).toBeGreaterThanOrEqual(TIMINGS.retryDelayMs);
  });

  it('a session that never starts (repro of 2026-10-26): retried once, then the run is recorded failed and the task handed back', async () => {
    const w = new World();
    w.plan = ['fail', 'fail'];
    await run(w);
    expect(w.launches).toHaveLength(2);
    expect(w.failures).toHaveLength(1);
    expect(w.failures[0]).toMatchObject({ taskId: 'task-1' });
    expect(w.failures[0].error).toContain('never started (tried twice)');
    expect(w.failures[0].error).toContain('port file not created');
    expect(w.handBacks).toEqual([{ taskId: 'task-1', error: w.failures[0].error }]);
    expect(w.tasks.get('task-1')?.phase).toBe('NEED_ACTION');
    expect(w.lastStart('task-1')).toMatchObject({ state: 'failed', attempt: 2 });
    expect(w.failed.map((f) => f.sid)).toEqual(['sid-1', 'sid-2']);
  });

  it('a start that stays silent is failed at its deadline, not left "starting" forever', async () => {
    const w = new World();
    w.plan = ['silent', 'silent'];
    await run(w);
    expect(w.failures).toHaveLength(1);
    expect(w.failures[0].error).toContain('no session process came up within 120s');
    expect(w.t - T0).toBeLessThan(TIMINGS.attemptDeadlineMs * 2 + TIMINGS.retryDelayMs + 10_000);
  });

  it('the retry waits for the host daemon to serve, then starts (resume when the context is back)', async () => {
    const w = new World();
    w.plan = ['fail', 'up'];
    w.serving = false;
    // The new login's daemon serves four minutes later.
    w.at.push({ at: T0 + 4 * 60_000, fn: () => { w.serving = true; } });
    await run(w);
    const retryAt = Date.parse(w.starts.find((s) => s.start.attempt === 2)!.start.attempt_at);
    expect(retryAt).toBeGreaterThanOrEqual(T0 + 4 * 60_000);
    expect(w.lastStart('task-1')).toMatchObject({ state: 'started', attempt: 2 });
    expect(w.failures).toEqual([]);
  });

  it('a host that never comes back: the retry still goes at the end of the wait, and the failure says why', async () => {
    const w = new World();
    w.plan = ['fail', 'fail'];
    w.serving = false;
    await run(w);
    expect(w.launches).toHaveLength(2);
    expect(w.failures[0].error).toContain('port file not created');
  });

  it('a first attempt that comes up late (during the retry delay) is not started a second time', async () => {
    const w = new World();
    w.plan = [{ at: 150_000, then: 'up' }];
    await run(w);
    expect(w.launches).toHaveLength(1);
    expect(w.lastStart('task-1')).toMatchObject({ state: 'started', attempt: 1 });
    expect(w.failures).toEqual([]);
  });

  it('a task the user closed before the retry is not started again and not reported failed', async () => {
    const w = new World();
    w.plan = ['fail'];
    w.at.push({ at: T0 + 30_000, fn: () => { w.tasks.set('task-1', { ...w.tasks.get('task-1')!, phase: 'COMPLETE' }); } });
    await run(w);
    expect(w.launches).toHaveLength(1);
    expect(w.failures).toEqual([]);
    expect(w.handBacks).toEqual([]);
    expect(w.lastStart('task-1')).toMatchObject({ state: 'failed', error: 'the task was closed before its retry' });
  });

  it('a retry whose task already holds a conversation goes there (one session per task)', async () => {
    const w = new World();
    w.plan = ['fail'];
    w.at.push({ at: T0 + 30_000, fn: () => { w.continued = 'sid-human'; } });
    await run(w);
    expect(w.launches).toHaveLength(2);
    expect(w.lastStart('task-1')).toMatchObject({ state: 'started', session_id: 'sid-human' });
    expect(w.failures).toEqual([]);
  });

  it('a retry that cannot be launched at all is the run\'s failure, with both reasons', async () => {
    const w = new World();
    w.plan = ['fail'];
    const deps = w.deps();
    const starter = new RoutineRunStarter({
      ...deps,
      launch: async (launch, opts) => {
        if (opts.existingTaskId) throw new Error('host gate: claude is not logged in');
        return await deps.launch(launch, opts);
      },
    }, TIMINGS);
    await starter.start({ job: JOB, runAtMs: T0, launch: LAUNCH });
    await Promise.all([..._runStartWatchesForTesting().values()]);
    expect(w.failures[0].error).toContain('port file not created');
    expect(w.failures[0].error).toContain('the retry could not be launched: host gate: claude is not logged in');
  });

  it('a launch that throws (the host gate) throws to the executor and records nothing', async () => {
    const w = new World();
    const starter = new RoutineRunStarter({ ...w.deps(), launch: async () => { throw new Error('refused'); } }, TIMINGS);
    await expect(starter.start({ job: JOB, runAtMs: T0, launch: LAUNCH })).rejects.toThrow('refused');
    expect(w.starts).toEqual([]);
    expect(w.errorTaps.size).toBe(0);
  });

  it('an engine that issues its own ids is judged by the task\'s newest session', async () => {
    const w = new World();
    w.ownIds = false;
    const started = await run(w);
    expect(started.confirmed).toBe(true);
    expect(w.launches[0].preassignedSessionId).toBeUndefined();
  });

  it('a start that missed its deadline is cancelled on its host before the retry, so the two never both run', async () => {
    // The daemon would run attempt 1 at 400s, after its deadline (inc-1787511363340's shape).
    const w = new World();
    w.plan = [{ at: 400_000, then: 'up' }, 'up'];
    await run(w);
    expect(w.cancels[0]).toBe('sid-1');
    expect(w.launches).toHaveLength(2);
    expect(w.lastStart('task-1')).toMatchObject({ state: 'started', attempt: 2, session_id: 'sid-2' });
    w.t += 600_000;
    await w.deps().sleep(1);
    // Attempt 1 never came up: its host refused it once cancelled.
    expect(w.sessions.get('sid-1')?.pid).toBeUndefined();
  });

  it('a start the host turns out to be running when asked to cancel it is the run, not retried', async () => {
    const w = new World();
    w.plan = [{ at: 170_000, then: 'up' }];
    await run(w);
    expect(w.launches).toHaveLength(1);
    expect(w.lastStart('task-1')).toMatchObject({ state: 'started', attempt: 1 });
    expect(w.failures).toEqual([]);
  });

  it('a silent start whose host never confirms the cancel is not retried (it could run twice), and says so', async () => {
    const w = new World();
    w.plan = ['silent'];
    w.serving = false;
    await run(w);
    expect(w.launches).toHaveLength(1);
    expect(w.failures).toHaveLength(1);
    expect(w.failures[0].error).toContain('never started (not retried)');
    expect(w.failures[0].error).toContain('did not confirm the first try was stopped');
    expect(w.handBacks).toHaveLength(1);
  });

  it('a task the user closed during the last attempt is recorded failed on the routine but not reopened', async () => {
    const w = new World();
    w.plan = ['fail', 'silent'];
    w.at.push({ at: T0 + 100_000, fn: () => { w.tasks.set('task-1', { ...w.tasks.get('task-1')!, phase: 'COMPLETE' }); } });
    await run(w);
    expect(w.launches).toHaveLength(2);
    expect(w.failures).toHaveLength(1);
    expect(w.handBacks).toEqual([]);
    expect(w.tasks.get('task-1')?.phase).toBe('COMPLETE');
  });

  it('a start picked up hours after its run is never started late', async () => {
    const w = new World();
    const runAt = T0 - 8 * 3_600_000;
    w.tasks.set('task-9', { id: 'task-9', title: 'Org reflection', phase: 'IN_PROGRESS' } as Task);
    w.sessions.set('sid-old', {
      claudeSessionId: 'sid-old', taskId: 'task-9', process_status: 'stopped', status_reason: 'orphan_no_pid',
      startedAt: new Date(runAt).toISOString(),
    } as SessionRecord);
    const starter = new RoutineRunStarter(w.deps(), TIMINGS);
    starter.resume('task-9', {
      job_id: JOB.id, job_name: JOB.name, run_at: new Date(runAt).toISOString(), attempt: 1,
      attempt_at: new Date(runAt).toISOString(), session_id: 'sid-old', state: 'starting', launch: LAUNCH,
    });
    await Promise.all([..._runStartWatchesForTesting().values()]);
    expect(w.launches).toEqual([]);
    expect(w.cancels).toEqual(['sid-old']);
    expect(w.failures[0].error).toContain('8h past its time, too late to start it now');
    expect(w.lastStart('task-9')).toMatchObject({ state: 'failed' });
  });

  it('after a restart, a start the last server left unsettled is finished: past its deadline, it is retried', async () => {
    const w = new World();
    w.tasks.set('task-9', { id: 'task-9', title: 'Org reflection', phase: 'IN_PROGRESS' } as Task);
    w.sessions.set('sid-old', {
      claudeSessionId: 'sid-old', taskId: 'task-9', process_status: 'stopped', status_reason: 'orphan_no_pid',
      startedAt: new Date(T0 - 10 * 60_000).toISOString(),
    } as SessionRecord);
    const stored: RoutineStart = {
      job_id: JOB.id, job_name: JOB.name, run_at: new Date(T0 - 10 * 60_000).toISOString(),
      attempt: 1, attempt_at: new Date(T0 - 10 * 60_000).toISOString(), session_id: 'sid-old',
      state: 'starting', launch: LAUNCH,
    };
    const starter = new RoutineRunStarter(w.deps(), TIMINGS);
    starter.resume('task-9', stored);
    starter.resume('task-9', stored);  // a second pickup of the same task is ignored
    await Promise.all([..._runStartWatchesForTesting().values()]);
    expect(w.launches).toHaveLength(1);
    expect(w.launches[0]).toMatchObject({ existingTaskId: 'task-9' });
    expect(w.lastStart('task-9')).toMatchObject({ state: 'started', attempt: 2 });
  });
});

describe('startVerdictOf', () => {
  const base = { claudeSessionId: 's', taskId: 't', startedAt: '2026-10-26T16:17:36.000Z' } as SessionRecord;
  it('reads a pid as the daemon confirming the spawn', () => {
    expect(startVerdictOf({ ...base, process_status: 'idle', status_reason: 'awaiting_spawn', pid: 77 } as SessionRecord).kind).toBe('started');
  });
  it('a seeded record is still pending, and an unknown spawn outcome is not a verdict', () => {
    expect(startVerdictOf({ ...base, process_status: 'idle', status_reason: 'awaiting_spawn' } as SessionRecord).kind).toBe('pending');
    expect(startVerdictOf({ ...base, process_status: 'error', status_reason: 'spawn_outcome_unknown' } as SessionRecord, 'timeout').kind).toBe('pending');
  });
  it('a session that ran and ended (its pid cleared at exit) is a start, not a failure', () => {
    // Seen on a test server: the CLI ran its turn and exited within a second; a
    // pid-only rule called that a failed start and would have run it twice.
    expect(startVerdictOf({ ...base, process_status: 'stopped', status_reason: 'awaiting_spawn', outputFile: 'remote://__local__/s' } as SessionRecord).kind).toBe('started');
    expect(startVerdictOf({ ...base, process_status: 'stopped', status_reason: 'snapshot_projection' } as SessionRecord).kind).toBe('started');
    expect(startVerdictOf({ ...base, process_status: 'error', status_reason: 'daemon_reported_exit' } as SessionRecord).kind).toBe('started');
  });
  it('a host-loss stamp on a record that never got a pid is not a verdict: the deadline and the host decide', () => {
    expect(startVerdictOf({ ...base, process_status: 'error', status_reason: 'remote_unreachable' } as SessionRecord).kind).toBe('pending');
    expect(startVerdictOf({ ...base, process_status: 'stopped', status_reason: 'process_exited_no_result' } as SessionRecord).kind).toBe('pending');
    expect(startVerdictOf({ ...base, process_status: 'error', status_reason: 'remote_unreachable' } as SessionRecord, 'host gone').kind).toBe('failed');
  });
  it('a record a restart or the orphan sweep marked, with no output file, never ran', () => {
    expect(startVerdictOf({ ...base, process_status: 'stopped', status_reason: 'server_restart' } as SessionRecord).kind).toBe('failed');
    expect(startVerdictOf({ ...base, process_status: 'stopped', status_reason: 'orphan_no_pid' } as SessionRecord).kind).toBe('failed');
  });
  it('a stopped record without a pid, or the runner\'s error, is a failed start', () => {
    expect(startVerdictOf({ ...base, process_status: 'stopped', status_reason: 'awaiting_spawn' } as SessionRecord)).toEqual({ kind: 'failed', reason: 'the session process could not be started' });
    expect(startVerdictOf({ ...base, process_status: 'idle', status_reason: 'awaiting_spawn' } as SessionRecord, 'Unknown host "x"')).toEqual({ kind: 'failed', reason: 'Unknown host "x"' });
  });
});
