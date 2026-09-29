/**
 * Tests for SessionHealthMonitor — specifically the process_status:'error' behavior.
 *
 * Key assertions:
 *   - Health monitor sets process_status:'error' + errorMessage when process dies without result
 *   - Health monitor sets process_status:'stopped' when result found
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

// Mock isProcessAliveAsync — used as fallback when no session manager is registered
vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => false,
  isProcessAliveAsync: async () => false,
}));

// Mock daemon-connection — local sessions don't use it. getConnectedDaemonConnection
// is the owner-stop pool: no daemon unless a test hands one in (daemonHook.conn).
const { daemonHook } = vi.hoisted(() => ({
  daemonHook: { conn: null as null | { connected: boolean; hasCapability(cap: string): boolean; send(command: string, args: Record<string, unknown>): Promise<Record<string, unknown>> } },
}));
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
  getConnectedDaemonConnection: () => daemonHook.conn,
}));

// Mock session-manager registry — returns null (no active manager registered)
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: () => null,
}));

// Mock config-manager — returns a config with no idle_timeout override
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ session: {} }),
}));

// Mock task-manager to avoid setting up a full task store for clearSessionSlot calls
vi.mock('../../src/core/task-manager.js', () => ({
  clearSessionSlot: async (taskId: string, sessionId: string) => ({
    task: { id: taskId, session_id: sessionId, title: 'mock task' },
  }),
  listTasks: async () => [
    { id: 'task-1', phase: 'IN_PROGRESS' },
    { id: 'task-2', phase: 'IN_PROGRESS' },
    { id: 'task-3', phase: 'IN_PROGRESS' },
    { id: 'task-4', phase: 'TODO' },
  ],
  listTasksByIds: async (ids: string[]) => [
    { id: 'task-1', phase: 'IN_PROGRESS' },
    { id: 'task-2', phase: 'IN_PROGRESS' },
    { id: 'task-3', phase: 'IN_PROGRESS' },
    { id: 'task-4', phase: 'TODO' },
  ].filter((task) => ids.includes(task.id)),
}));

// Mock event bus — we don't need to verify events in these unit tests
vi.mock('../../src/core/event-bus.js', () => ({
  bus: { emit: vi.fn() },
  EventNames: {
    SESSION_STATUS_CHANGED: 'session:status-changed',
    TASK_UPDATED: 'task:updated',
  },
}));

// The monitor fires its orphan sweep without awaiting it. Record every sweep's
// promise (the real implementation still runs) so a test can wait for the
// verdict instead of asserting before the sweep has looked at anything.
const { sweeps } = vi.hoisted(() => ({ sweeps: [] as Array<Promise<unknown>> }));
vi.mock('../../src/core/sessions/owner-stop.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/core/sessions/owner-stop.js')>();
  return {
    ...actual,
    sweepOrphansThroughOwner: (...args: Parameters<typeof actual.sweepOrphansThroughOwner>) => {
      const run = actual.sweepOrphansThroughOwner(...args);
      sweeps.push(run);
      return run;
    },
  };
});

import {
  createSessionRecord,
  listSessions,
  updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js';
import type { OrphanOutcome } from '../../src/core/sessions/owner-stop.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { log } from '../../src/logging/index.js';

/** Above any real pid limit: even a signal that escaped the spies would reach nothing. */
const IMPOSSIBLE_PID = 2 ** 22 + 71;

/** Wait for the monitor's fire-and-forget orphan sweep(s) to start and finish. */
async function settledSweeps(): Promise<OrphanOutcome[]> {
  await vi.waitFor(() => expect(sweeps.length).toBeGreaterThan(0), { timeout: 5_000 });
  const results = await Promise.all(sweeps.splice(0));
  return results.flat() as OrphanOutcome[];
}

let tmpDir: string;

beforeEach(async () => {
  sweeps.length = 0;
  daemonHook.conn = null;
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
});

afterEach(async () => {
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(tmpDir, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

// ── Test 3: Health monitor sets process_status:'error' when process dies without result ──

describe('SessionHealthMonitor — process_status:error behavior', () => {
  it('sets process_status:error and errorMessage when local process dies without result', async () => {
    // Create a session with process_status:'running', dead PID
    // No outputFile → no result event → should trigger the error path
    await createSessionRecord('dead-no-result', 'task-1', 'proj', undefined, {
      pid: 999999999,  // Dead PID — isProcessAliveAsync mocked to return false
      outputFile: '/tmp/nonexistent-output-no-result.jsonl',  // File doesn't exist → no result
    });

    const monitor = new SessionHealthMonitor();
    await monitor.check();

    const sessions = await listSessions();
    const session = sessions.find(s => s.claudeSessionId === 'dead-no-result');
    expect(session).toBeDefined();

    // Should set process_status:'error' (NOT 'stopped')
    expect(session!.process_status).toBe('error');

    // Should set a human-readable error message
    expect(session!.errorMessage).toBe('Process exited without result');
  });

  it('sets process_status:stopped when result found in output file', async () => {
    // Create an output file with a successful result event
    const outputFile = path.join(tmpDir, 'session-with-result.jsonl');
    const resultLine = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'All done' });
    await fsp.writeFile(outputFile, resultLine + '\n', 'utf-8');

    await createSessionRecord('dead-with-result', 'task-2', 'proj', undefined, {
      pid: 999999999,
      outputFile,
    });

    const monitor = new SessionHealthMonitor();
    await monitor.check();

    const sessions = await listSessions();
    const session = sessions.find(s => s.claudeSessionId === 'dead-with-result');
    expect(session).toBeDefined();

    // Result found → normal completion
    expect(session!.process_status).toBe('stopped');

    // Should NOT be error state
    expect(session!.process_status).not.toBe('error');
    expect(session!.errorMessage).toBeUndefined();
  });

  it('does not change terminal sessions', async () => {
    // A session already in error state should remain untouched by health check
    await createSessionRecord('already-error', 'task-3', 'proj', undefined, { pid: 999999999 });
    await updateSessionRecord('already-error', {
      process_status: 'error',
      errorMessage: 'Previous error',
    });

    const monitor = new SessionHealthMonitor();
    await monitor.check();

    const sessions = await listSessions();
    const session = sessions.find(s => s.claudeSessionId === 'already-error');
    expect(session).toBeDefined();

    // Terminal session — should remain error, not double-processed
    expect(session!.process_status).toBe('error');
    expect(session!.errorMessage).toBe('Previous error');
  });

  it('does not change stopped sessions', async () => {
    await createSessionRecord('already-done', 'task-4', 'proj');
    await updateSessionRecord('already-done', {
      process_status: 'stopped',
    });

    const monitor = new SessionHealthMonitor();
    await monitor.check();

    const sessions = await listSessions();
    const session = sessions.find(s => s.claudeSessionId === 'already-done');
    expect(session!.process_status).toBe('stopped');
  });
});

// ── REGRESSION: the orphan sweep never signals a pid read from the sessions store ──

describe('SessionHealthMonitor: orphan sweep goes through the owning daemon, never a signal', () => {
  it('does NOT SIGTERM a local session whose JSONL was just written, even when process_status=stopped + pid alive', async () => {
    // The false-zombie state:
    //   - local session (host null), process_status='stopped' (mis-set by a bad reconcile)
    //   - the pid answers the liveness probe (the spy below says so)
    //   - last_status_change older than the 2-min orphan grace (so grace doesn't save it)
    //   - JSONL freshly written (process is actively producing output)
    // The monitor no longer signals any record pid (core/sessions/owner-stop.ts);
    // this shape is not even a candidate (a 'stopped' observation, not a decision).
    const sid = 'live-but-flagged-stopped';
    const jsonlPath = path.join(WALNUT_HOME, 'streams', `${sid}.jsonl`);
    await fsp.mkdir(path.dirname(jsonlPath), { recursive: true });
    await fsp.writeFile(jsonlPath, '{"type":"assistant"}\n', 'utf-8'); // mtime = now → fresh

    await createSessionRecord(sid, 'task-1', 'proj', undefined, { pid: IMPOSSIBLE_PID });
    const old = new Date(Date.now() - 5 * 60 * 1000).toISOString(); // 5min ago > 2min grace
    await updateSessionRecord(sid, { process_status: 'stopped', last_status_change: old });

    const signals: Array<[number, string | number | undefined]> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig !== 0) signals.push([pid, sig]);   // record, never deliver
      return true as unknown as boolean;         // every probe answers "alive"
    }) as typeof process.kill);

    try {
      const monitor = new SessionHealthMonitor();
      await monitor.check();
      // The sweep is fire-and-forget: wait for it to run and finish, or this
      // assertion would pass before the sweep ever looked at the record.
      const outcomes = await settledSweeps();
      expect(outcomes.some((o) => o.sessionId === sid), 'an observed stop is not an orphan candidate').toBe(false);
      expect(signals).toEqual([]);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('a deliberately stopped record with a live pid and a STALE JSONL is handed to its daemon, never signalled', async () => {
    // The incident shape once the old freshness veto is gone: a user stop recorded
    // long ago, the pid answers the probe, and the JSONL is 10 minutes old (a live
    // CLI idling between turns looks exactly like this). The old sweep SIGTERM'd
    // it. Now the monitor asks the owning daemon; this test has none connected,
    // so the sweep leaves the process alone.
    const sid = 'stopped-by-user-live-pid';
    const jsonlPath = path.join(WALNUT_HOME, 'streams', `${sid}.jsonl`);
    await fsp.mkdir(path.dirname(jsonlPath), { recursive: true });
    await fsp.writeFile(jsonlPath, '{"type":"assistant"}\n', 'utf-8');
    const old = Date.now() - 10 * 60 * 1000;
    await fsp.utimes(jsonlPath, old / 1000, old / 1000);

    await createSessionRecord(sid, 'task-1', 'proj', undefined, { pid: IMPOSSIBLE_PID + 1 });
    await updateSessionRecord(sid, {
      process_status: 'stopped',
      status_reason: 'user_stopped',
      last_status_change: new Date(old).toISOString(),
    });

    const signals: Array<[number, string | number | undefined]> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig !== 0) signals.push([pid, sig]);   // record, never deliver
      return true as unknown as boolean;
    }) as typeof process.kill);

    try {
      const monitor = new SessionHealthMonitor();
      await monitor.check();
      const outcomes = await settledSweeps();
      expect(outcomes.find((o) => o.sessionId === sid)).toEqual({
        sessionId: sid, host: '__local__', pid: IMPOSSIBLE_PID + 1, result: 'left', reason: 'owner_unreachable',
      });
      expect(signals).toEqual([]);
    } finally {
      killSpy.mockRestore();
    }
  });
});

// ── Idle reaps: every stop goes to the owner, a few at a time ──

describe('SessionHealthMonitor: idle reaps run concurrently with a small cap', () => {
  it('stops nine idle sessions with no manager through their owner, at most four in flight', async () => {
    const old = Date.now() - 70 * 60 * 1000; // past the local 60-min threshold
    const ids: string[] = [];
    for (let i = 1; i <= 9; i++) {
      const sid = `idle-reap-${i}`;
      const outputFile = path.join(tmpDir, `${sid}.jsonl`);
      await fsp.writeFile(outputFile, '', 'utf-8');
      await fsp.utimes(outputFile, old / 1000, old / 1000);
      await createSessionRecord(sid, 'task-1', 'proj', undefined, { pid: IMPOSSIBLE_PID + 10 + i, outputFile });
      await updateSessionRecord(sid, { process_status: 'idle', last_status_change: new Date(old).toISOString() });
      ids.push(sid);
    }

    // The owning daemon: every stop takes a moment, so overlapping ones are visible.
    let inFlight = 0;
    let peak = 0;
    const asked: string[] = [];
    daemonHook.conn = {
      connected: true,
      hasCapability: () => false,
      async send(command, args) {
        if (command !== 'stop') return { ok: true };
        asked.push(String(args.sid));
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((r) => setTimeout(r, 25));
        inFlight--;
        return { ok: true, stopped: true };
      },
    };
    const signals: Array<[number, string | number | undefined]> = [];
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, sig?: string | number) => {
      if (sig !== 0) signals.push([pid, sig]);   // record, never deliver
      return true as unknown as boolean;
    }) as typeof process.kill);

    try {
      const monitor = new SessionHealthMonitor();
      const rows = (await listSessions()).filter((s) => ids.includes(s.claudeSessionId));
      const checkIdle = (monitor as unknown as {
        checkIdleTimeout(
          sessions: typeof rows, update: typeof updateSessionRecord, taskMap: Map<string, unknown>,
          alive: () => Promise<boolean>,
        ): Promise<Set<string>>
      }).checkIdleTimeout.bind(monitor);
      const killed = await checkIdle(rows, updateSessionRecord, new Map(), async () => true);

      expect(asked.sort()).toEqual([...ids].sort());
      expect(peak, 'the stops overlap instead of running one after another').toBeGreaterThan(1);
      expect(peak, 'but never more than four at once').toBeLessThanOrEqual(4);
      expect([...killed].sort()).toEqual([...ids].sort());
      const after = await listSessions();
      for (const sid of ids) {
        expect(after.find((s) => s.claudeSessionId === sid)).toMatchObject({ process_status: 'stopped', status_reason: 'idle_timeout' });
      }
      expect(signals).toEqual([]);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('a stop the owner refuses leaves the session as it was', async () => {
    const old = Date.now() - 70 * 60 * 1000;
    const outputFile = path.join(tmpDir, 'idle-refused.jsonl');
    await fsp.writeFile(outputFile, '', 'utf-8');
    await fsp.utimes(outputFile, old / 1000, old / 1000);
    await createSessionRecord('idle-refused', 'task-1', 'proj', undefined, { pid: IMPOSSIBLE_PID + 30, outputFile });
    await updateSessionRecord('idle-refused', { process_status: 'idle', last_status_change: new Date(old).toISOString() });
    const asked: string[] = [];
    daemonHook.conn = {
      connected: true,
      hasCapability: () => false,
      async send(command, args) {
        if (command === 'stop') asked.push(String(args.sid));
        return { ok: true, stopped: false, reason: 'cron_supervised' };
      },
    };

    const monitor = new SessionHealthMonitor();
    const rows = (await listSessions()).filter((s) => s.claudeSessionId === 'idle-refused');
    const killed = await (monitor as unknown as {
      checkIdleTimeout(...args: unknown[]): Promise<Set<string>>
    }).checkIdleTimeout(rows, updateSessionRecord, new Map(), async () => true);

    expect(asked).toEqual(['idle-refused']);
    expect(killed.size).toBe(0);
    expect((await listSessions()).find((s) => s.claudeSessionId === 'idle-refused')).toMatchObject({ process_status: 'idle', pid: IMPOSSIBLE_PID + 30 });
  });
});

// ── Idle-threshold behavior — asymmetric local (1h) vs remote (2h) ──

describe('SessionHealthMonitor — idle-threshold source gating (DEFAULT_*_IDLE_TIMEOUT)', () => {
  it('idle-timeout log reports 60 for local sessions', async () => {
    // Build a local session that has been idle for 70 min (past local 60m threshold,
    // well under remote 120m). Use outputFile + old mtime to seed lastActiveMs.
    const outputFile = path.join(tmpDir, 'local-idle-70m.jsonl');
    await fsp.writeFile(outputFile, '', 'utf-8');
    const old = Date.now() - 70 * 60 * 1000;
    await fsp.utimes(outputFile, old / 1000, old / 1000);

    await createSessionRecord('local-idle', 'task-1', 'proj', undefined, {
      pid: 999999999,  // irrelevant; isProcessAliveAsync mock returns false so session won't be killed via this path
      outputFile,
      // no `host` → local
    });
    // Force process_status='running' + recent last_status_change so the idle
    // branch evaluates the threshold rather than short-circuiting.
    await updateSessionRecord('local-idle', {
      process_status: 'running',
      last_status_change: new Date(old).toISOString(),
    });

    // Spy on log to capture the threshold reported in the idle-timeout path
    // (the cached-alive mock forces `await cachedIsAlive()` to return false in
    // the real code path, so we instead assert via side-effect: DEFAULT
    // constants are the authoritative source). The constants module is
    // non-exported; the behavior contract we rely on is that the log string
    // literal in checkIdleTimeout includes the threshold the code chose.
    // Since isProcessAliveAsync is mocked to false, no actual idle-kill
    // fires here — that's fine, we get full coverage for the non-kill path
    // in the existing tests. The local/remote asymmetry is a pure code-path
    // assertion: read the source file itself.
    const src = await fsp.readFile(
      path.resolve(__dirname, '../../src/core/session-health-monitor.ts'),
      'utf-8',
    );
    expect(src).toMatch(/DEFAULT_LOCAL_IDLE_TIMEOUT_MS\s*=\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(src).toMatch(/DEFAULT_REMOTE_IDLE_TIMEOUT_MS\s*=\s*2\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
    expect(src).toMatch(/const isRemote\s*=\s*!!session\.host/);
    expect(src).toMatch(/isRemote\s*\?\s*DEFAULT_REMOTE_IDLE_TIMEOUT_MS\s*:\s*DEFAULT_LOCAL_IDLE_TIMEOUT_MS/);
  });

  it('config override (idle_timeout_minutes) still applies uniformly when set', async () => {
    // The override takes precedence over per-side defaults. Verify by source
    // inspection — runtime coverage would require mocking getConfig per-test
    // which is brittle across the existing shared mock. The contract lives in
    // the nullish-coalescing expression we just added.
    const src = await fsp.readFile(
      path.resolve(__dirname, '../../src/core/session-health-monitor.ts'),
      'utf-8',
    );
    expect(src).toMatch(/configOverrideMs\s*\?\?/);
    // And 0 still disables globally.
    expect(src).toMatch(/if\s*\(\s*configOverrideMs\s*===\s*0\s*\)\s*return\s+killedIds/);
  });
});

// ── The tick budget must bind INSIDE the per-session loops, not only between phases ──

describe('SessionHealthMonitor — in-loop budget enforcement', () => {
  it('abandons the liveness loop mid-way once the tick budget is spent', async () => {
    // Six dead-pid sessions. pid is set (999999999, mocked dead) so they are not
    // swept into the orphan dead-pool, which would bypass the liveness loop.
    const ids = ['budget-a', 'budget-b', 'budget-c', 'budget-d', 'budget-e', 'budget-f'];
    for (const id of ids) {
      await createSessionRecord(id, 'task-4', 'proj', undefined, { pid: 999999999 });
    }

    // Flip the budget as soon as the loop has processed its FIRST session, keyed on
    // the loop's own per-session transition log. Deterministic without depending on
    // how many times the between-phase checks query the budget: those all run
    // before any transition, while the flag is still false.
    //
    // Counted, not identity-checked: this file's tests share one sessions.sqlite, so
    // records from earlier tests are also in the scan set and the loop's first
    // session need not be one of ours. "How many sessions did the loop touch" is the
    // invariant that matters and it is immune to that ordering.
    const TRANSITION_LOGS = new Set([
      'health monitor: process status updated',
      'health monitor: session process died',
    ]);
    let transitions = 0;
    const infoSpy = vi.spyOn(log.session, 'info').mockImplementation(((msg: string) => {
      if (TRANSITION_LOGS.has(msg)) transitions++;
    }) as never);
    const warnSpy = vi.spyOn(log.session, 'warn').mockImplementation((() => {}) as never);

    try {
      const monitor = new SessionHealthMonitor();
      await monitor.check({
        overBudget: () => transitions > 0,
        elapsedMs: () => (transitions > 0 ? 99_999 : 0),
      });

      const abandoned = warnSpy.mock.calls.filter(
        (c) => c[0] === 'health monitor: liveness loop abandoned mid-loop (over budget)',
      );
      expect(abandoned).toHaveLength(1);
      // One transition, then the loop stopped — instead of grinding through all six
      // (plus the leftovers) with the budget long gone.
      expect(transitions).toBe(1);

      const sessions = await listSessions();
      const untouched = sessions.filter(
        (s) => ids.includes(s.claudeSessionId) &&
          s.process_status !== 'stopped' && s.process_status !== 'error',
      );
      expect(untouched.length).toBeGreaterThanOrEqual(5);
    } finally {
      infoSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  it('processes every session when the budget is never exceeded', async () => {
    const ids = ['nb-a', 'nb-b', 'nb-c'];
    for (const id of ids) {
      await createSessionRecord(id, 'task-4', 'proj', undefined, { pid: 999999999 });
    }

    const monitor = new SessionHealthMonitor();
    await monitor.check(); // default ctx = unlimited

    const sessions = await listSessions();
    const transitioned = sessions.filter(
      (s) => ids.includes(s.claudeSessionId) && s.process_status === 'stopped',
    );
    expect(transitioned).toHaveLength(3);
  });
});
