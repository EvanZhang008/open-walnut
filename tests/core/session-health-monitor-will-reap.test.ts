/**
 * session:will-reap — the idle reaper's pre-death warning.
 *
 * The event exists because `session:ended` is NOT process death (it fires after
 * every turn — docs/decision/no-session-end-gist.md). checkIdleTimeout is the
 * authoritative idle reaper, so the warning is emitted there, and these tests
 * pin the properties that make it trustworthy:
 *
 *   - it only fires for a session THIS tick would genuinely reap (all four
 *     exemptions + the last_status_change freshness protection are respected)
 *   - remainingMs is real (0…5 min) and measured against the same clocks the
 *     reap uses
 *   - once per idle episode, not once per tick
 *   - real activity re-arms it
 *   - it lands BEFORE the kill
 *
 * Everything is driven through the real checkIdleTimeout: the seams mocked here
 * are the ones the monitor itself treats as external facts (liveness, session
 * manager, runner probes, config).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

// ── Controllable seams ──────────────────────────────────────────────────────

/** Idle threshold the monitor should read (minutes). 60 keeps the maths obvious. */
let idleTimeoutMinutes: number | undefined = 60;

/** Per-session runner exemptions (team / background work / pending permission). */
const exemptions = {
  teamActive: new Set<string>(),
  backgroundActive: new Set<string>(),
  pendingPermission: new Set<string>(),
  cronArmed: new Set<string>(),
};

/** Fake SessionManagers keyed by sid — lastEventAt drives the idle clock. */
interface FakeManager { lastEventAt: number; kill: ReturnType<typeof vi.fn>; isAlive: () => Promise<boolean> }
const managers = new Map<string, FakeManager>();

/** Liveness verdict for every session (the reaper's last exemption). */
let processAlive = true;

vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => false,
  isProcessAliveAsync: async () => false,
}));

vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => processAlive,
  isLocalJsonlFresh: () => 'unknown' as const,
}));

vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => false,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
  getPooledSnapshotConnection: () => null,
}));

vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: (sid: string) => managers.get(sid) ?? null,
}));

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ session: { idle_timeout_minutes: idleTimeoutMinutes } }),
  // task-manager's store init reaches these; without them the task lookup phase
  // logs a mock-shape warning that has nothing to do with what we're testing.
  updateConfig: async () => undefined,
  seedConfigDefaults: async () => undefined,
}));

// Snapshot pull off — it would dial daemon RPCs that have nothing to do with the reaper.
vi.mock('../../src/core/session-snapshot-gate.js', () => ({
  getSnapshotStatusMode: () => 'off',
}));

// Phase sync is a downstream effect of the kill, not of the warning.
vi.mock('../../src/core/phase.js', () => ({
  applySessionPhase: vi.fn(async () => undefined),
  TERMINAL_PHASES: new Set(['COMPLETE', 'CANCELLED']),
}));

vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    isTeamActive: (sid: string) => exemptions.teamActive.has(sid),
    isCronArmed: (sid: string) => exemptions.cronArmed.has(sid),
    isBackgroundWorkActive: (sid: string) => exemptions.backgroundActive.has(sid),
    hasPendingPermission: (sid: string) => exemptions.pendingPermission.has(sid),
    getSessionTimestamps: () => undefined,
    markExpectedTeardown: vi.fn(),
    reconcilePendingBackgroundTasks: async () => undefined,
    findSessionByClaudeId: () => undefined,
  },
}));

import {
  createSessionRecord,
  listSessions,
  updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { SessionWillReapEvent } from '../../src/core/event-types.js';

const MIN = 60_000;
const TIMEOUT_MS = 60 * MIN;
/** Never a live process: the reap paths signal a PID, and 999999999 can't exist. */
const DEAD_PID = 999999999;

let warnings: SessionWillReapEvent[] = [];
/** kill() calls already made when each warning arrived — proves the ordering. */
let killsAtWarnTime: number[] = [];
/** Sids seeded by the current test, retired in afterEach (see the note there). */
let seeded: string[] = [];

/**
 * Seed an idle-candidate session: process_status 'idle' (the normal post-turn
 * state), a registered manager whose lastEventAt is `idleMs` old, and a
 * last_status_change of the same age so the freshness guard doesn't veto.
 */
async function seedIdleSession(sid: string, idleMs: number, opts: {
  taskId?: string; host?: string; statusChangeAgeMs?: number;
} = {}): Promise<FakeManager> {
  const kill = vi.fn();
  const mgr: FakeManager = {
    lastEventAt: Date.now() - idleMs,
    kill,
    isAlive: async () => true,
  };
  managers.set(sid, mgr);
  seeded.push(sid);
  await createSessionRecord(sid, opts.taskId ?? '', 'proj', undefined, {
    pid: DEAD_PID,
    ...(opts.host ? { host: opts.host } : {}),
  });
  await updateSessionRecord(sid, {
    process_status: 'idle',
    last_status_change: new Date(Date.now() - (opts.statusChangeAgeMs ?? idleMs)).toISOString(),
  });
  return mgr;
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  managers.clear();
  exemptions.teamActive.clear();
  exemptions.backgroundActive.clear();
  exemptions.pendingPermission.clear();
  exemptions.cronArmed.clear();
  processAlive = true;
  idleTimeoutMinutes = 60;
  warnings = [];
  killsAtWarnTime = [];
  seeded = [];
  bus.subscribe('will-reap-probe', (event) => {
    if (event.name !== EventNames.SESSION_WILL_REAP) return;
    warnings.push(event.data as SessionWillReapEvent);
    killsAtWarnTime.push([...managers.values()].reduce((n, m) => n + m.kill.mock.calls.length, 0));
  }, { global: true, interest: [EventNames.SESSION_WILL_REAP] });
});

afterEach(async () => {
  bus.unsubscribe('will-reap-probe');
  // Records outlive the directory wipe (the sqlite handle is cached in-module and
  // survives the rm), and every test builds a FRESH monitor with an empty
  // episode memory — so an idle candidate left behind would warn all over again
  // in the next test. Retire them explicitly instead of relying on that.
  for (const sid of seeded) {
    try {
      await updateSessionRecord(sid, { archived: true, process_status: 'error', pid: undefined });
    } catch { /* store already torn down */ }
  }
  for (let i = 0; i < 3; i++) {
    try {
      await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise(r => setTimeout(r, 50));
    }
  }
});

describe('session:will-reap — warn window', () => {
  it('fires with real numbers inside the 5-min window, and does NOT kill yet', async () => {
    const mgr = await seedIdleSession('warn-soon', 57 * MIN, { taskId: 'task-warn' });

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(1);
    const w = warnings[0];
    expect(w.sessionId).toBe('warn-soon');
    expect(w.taskId).toBe('task-warn');
    expect(w.host).toBeUndefined();
    expect(w.reason).toBe('idle_timeout');
    expect(w.idleTimeoutMs).toBe(TIMEOUT_MS);
    // ~3 min left, ~57 min idle (a second of test runtime is fine).
    expect(w.remainingMs).toBeGreaterThan(2.5 * MIN);
    expect(w.remainingMs).toBeLessThanOrEqual(3 * MIN);
    expect(w.idleDurationMs).toBeGreaterThanOrEqual(57 * MIN);
    expect(w.idleDurationMs).toBeLessThan(58 * MIN);
    expect(Number.isNaN(Date.parse(w.warnedAt))).toBe(false);

    // Warning only — the CLI is still alive and the record untouched.
    expect(mgr.kill).not.toHaveBeenCalled();
    const session = (await listSessions()).find(s => s.claudeSessionId === 'warn-soon');
    expect(session!.process_status).toBe('idle');
  });

  it('stays silent while the reap is further out than the window', async () => {
    await seedIdleSession('warn-far', 40 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
  });

  it('carries host for a remote session', async () => {
    idleTimeoutMinutes = 60; // override applies to local + remote alike
    await seedIdleSession('warn-remote', 58 * MIN, { host: 'devbox' });

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(1);
    expect(warnings[0].host).toBe('devbox');
  });
});

describe('session:will-reap — one per idle episode', () => {
  it('does not re-announce the same episode on later ticks', async () => {
    await seedIdleSession('dedupe-me', 57 * MIN);
    const monitor = new SessionHealthMonitor();

    await monitor.check();
    await monitor.check();
    await monitor.check();

    expect(warnings).toHaveLength(1);
  });

  it('re-arms after real activity moves the idle clock forward', async () => {
    const mgr = await seedIdleSession('re-arm', 57 * MIN);
    const monitor = new SessionHealthMonitor();

    await monitor.check();
    expect(warnings).toHaveLength(1);

    // Activity: a fresh event resets the clock — no warning, episode forgotten.
    mgr.lastEventAt = Date.now();
    await updateSessionRecord('re-arm', { last_status_change: new Date().toISOString() });
    await monitor.check();
    expect(warnings).toHaveLength(1);

    // Idle again, later: this is a NEW episode and deserves its own warning.
    mgr.lastEventAt = Date.now() - 58 * MIN;
    await updateSessionRecord('re-arm', {
      last_status_change: new Date(Date.now() - 58 * MIN).toISOString(),
    });
    await monitor.check();
    expect(warnings).toHaveLength(2);
    expect(warnings[1].sessionId).toBe('re-arm');
  });
});

describe('session:will-reap — fires before the kill', () => {
  it('warns with remainingMs 0 on the tick that reaps, before the process dies', async () => {
    const mgr = await seedIdleSession('reap-now', 61 * MIN, { taskId: 'task-reap' });

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(1);
    expect(warnings[0].remainingMs).toBe(0);
    expect(warnings[0].idleDurationMs).toBeGreaterThanOrEqual(61 * MIN);
    // The warning was emitted while kill() had not been called yet.
    expect(killsAtWarnTime[0]).toBe(0);
    // ...and the reap itself still happened on this tick.
    expect(mgr.kill).toHaveBeenCalledTimes(1);
    const session = (await listSessions()).find(s => s.claudeSessionId === 'reap-now');
    expect(session!.process_status).toBe('stopped');
    expect(session!.status_reason).toBe('idle_timeout');
  });
});

describe('session:will-reap — never fires for a session the reaper spares', () => {
  it('pending permission (blocked on a human, not idle)', async () => {
    exemptions.pendingPermission.add('perm-wait');
    const mgr = await seedIdleSession('perm-wait', 61 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
    expect(mgr.kill).not.toHaveBeenCalled();
  });

  it('background work / dynamic workflow active', async () => {
    exemptions.backgroundActive.add('bg-busy');
    const mgr = await seedIdleSession('bg-busy', 61 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
    expect(mgr.kill).not.toHaveBeenCalled();
  });

  it('team-active lead session', async () => {
    exemptions.teamActive.add('team-lead');
    await seedIdleSession('team-lead', 61 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
  });

  it('dead process (nothing left to reap)', async () => {
    processAlive = false;
    await seedIdleSession('already-dead', 61 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
  });

  it('cron-armed session on the extended 7-day ceiling', async () => {
    exemptions.cronArmed.add('cron-loop');
    await seedIdleSession('cron-loop', 61 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
  });

  it('idle timeout disabled by config (0)', async () => {
    idleTimeoutMinutes = 0;
    await seedIdleSession('never-reaped', 61 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
  });

  it('a stale stream clock but a FRESH last_status_change (the reap would be vetoed)', async () => {
    // The reap needs BOTH clocks past the threshold. A session whose record just
    // moved (e.g. a new user message landed, first response not in yet) is not
    // about to die — announcing it would be a confident wrong answer.
    const mgr = await seedIdleSession('fresh-record', 61 * MIN, { statusChangeAgeMs: 1 * MIN });

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
    expect(mgr.kill).not.toHaveBeenCalled();
  });

  it('warns once the freshness protection itself is about to expire', async () => {
    // Same session as above, but the record write is now 57 min old: both clocks
    // land inside the window, so the deadline is real and the warning is honest.
    await seedIdleSession('fresh-then-stale', 61 * MIN, { statusChangeAgeMs: 57 * MIN });

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(1);
    // Deadline comes from the FRESHER clock (the record), not the stream file.
    expect(warnings[0].remainingMs).toBeGreaterThan(2.5 * MIN);
    expect(warnings[0].remainingMs).toBeLessThanOrEqual(3 * MIN);
    expect(warnings[0].idleDurationMs).toBeGreaterThanOrEqual(61 * MIN);
  });
});

describe('session:will-reap — file-mtime fallback (no registered manager)', () => {
  it('uses the output file mtime when no SessionManager is registered', async () => {
    const outputFile = path.join(WALNUT_HOME, 'mtime-idle.jsonl');
    await fsp.writeFile(outputFile, '', 'utf-8');
    const old = Date.now() - 57 * MIN;
    await fsp.utimes(outputFile, old / 1000, old / 1000);

    seeded.push('mtime-idle');
    await createSessionRecord('mtime-idle', '', 'proj', undefined, { pid: DEAD_PID, outputFile });
    await updateSessionRecord('mtime-idle', {
      process_status: 'idle',
      last_status_change: new Date(old).toISOString(),
    });

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(1);
    expect(warnings[0].sessionId).toBe('mtime-idle');
    expect(warnings[0].remainingMs).toBeGreaterThan(2.5 * MIN);
  });
});
