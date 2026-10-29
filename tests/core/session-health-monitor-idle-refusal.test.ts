/**
 * An idle stop the owner declines is its answer, not a blip to retry on the next
 * 30 s tick. 2026-10-28: the local daemon had never recorded one CLI's start time
 * (its `ps` timed out under load at spawn), so it refused every stop of that
 * process ("process identity is unknown"), and the health monitor asked again
 * every tick for over a day: about 115 refusals an hour in the daemon log.
 * Same seams as session-health-monitor-idle-clock.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
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
  outlivingWork: new Set<string>(),
};


/** Fake SessionManagers keyed by sid — lastEventAt drives the idle clock. */
interface FakeManager {
  lastEventAt: number; kill: ReturnType<typeof vi.fn>; isAlive: () => Promise<boolean>
  stopForIdle: ReturnType<typeof vi.fn>
}
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
    hasWorkOutlivingTurn: (sid: string) => exemptions.outlivingWork.has(sid),
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
import { SessionHealthMonitor, IDLE_REAP_RETRY_BACKOFF_MS } from '../../src/core/session-health-monitor.js';
import { WALNUT_HOME } from '../../src/constants.js';

const MIN = 60_000;
const DEAD_PID = 999999999;
let seeded: string[] = [];

type Outcome = 'stopped' | 'refused' | 'unreachable' | 'unknown';

async function seedIdleSession(sid: string, idleMs: number, outcome: Outcome, pid: number | null = DEAD_PID, host?: string): Promise<FakeManager> {
  const mgr: FakeManager = {
    lastEventAt: Date.now() - idleMs,
    kill: vi.fn(),
    isAlive: async () => true,
    stopForIdle: vi.fn(async () => outcome),
  };
  managers.set(sid, mgr);
  seeded.push(sid);
  await createSessionRecord(sid, '', 'proj', undefined, { ...(pid === null ? {} : { pid }), ...(host ? { host } : {}) });
  await updateSessionRecord(sid, {
    process_status: 'idle',
    last_status_change: new Date(Date.now() - idleMs).toISOString(),
  });
  return mgr;
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  managers.clear();
  for (const set of Object.values(exemptions)) set.clear();
  processAlive = true;
  idleTimeoutMinutes = 60;
  seeded = [];
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const sid of seeded) {
    try { await updateSessionRecord(sid, { archived: true, process_status: 'error', pid: undefined }); } catch { /* torn down */ }
  }
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('idle stop declined by the owner', () => {
  it('is not asked again on the next ticks, and is asked again after the backoff', async () => {
    const mgr = await seedIdleSession('declined-idle', 61 * MIN, 'refused');
    const monitor = new SessionHealthMonitor();

    await monitor.check();
    expect(mgr.stopForIdle).toHaveBeenCalledTimes(1);

    // The next ticks, 30 s apart: the refusal stands.
    await monitor.check();
    await monitor.check();
    expect(mgr.stopForIdle).toHaveBeenCalledTimes(1);

    // Past the backoff the owner is asked once more.
    const later = Date.now() + IDLE_REAP_RETRY_BACKOFF_MS + 1000;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    mgr.lastEventAt = later - 61 * MIN;
    await updateSessionRecord('declined-idle', { last_status_change: new Date(later - 61 * MIN).toISOString() });
    await monitor.check();
    expect(mgr.stopForIdle).toHaveBeenCalledTimes(2);
  });

  it('a new process for the session is asked at once', async () => {
    const mgr = await seedIdleSession('declined-respawn', 61 * MIN, 'refused');
    const monitor = new SessionHealthMonitor();
    await monitor.check();
    expect(mgr.stopForIdle).toHaveBeenCalledTimes(1);

    await updateSessionRecord('declined-respawn', { pid: DEAD_PID - 1 });
    await monitor.check();
    expect(mgr.stopForIdle).toHaveBeenCalledTimes(2);
  });

  it.each<[Outcome]>([['unreachable'], ['unknown']])('no answer (%s) is asked again on the next tick', async (outcome) => {
    const mgr = await seedIdleSession(`no-answer-${outcome}`, 61 * MIN, outcome);
    const monitor = new SessionHealthMonitor();
    await monitor.check();
    await monitor.check();
    expect(mgr.stopForIdle).toHaveBeenCalledTimes(2);
  });

  it('a refusal for a record with no pid is not held: there is no process to key it on', async () => {
    // Remote: a LOCAL record without a pid is drained as an orphan on the first tick.
    const mgr = await seedIdleSession('declined-no-pid', 61 * MIN, 'refused', null, 'devbox');
    const monitor = new SessionHealthMonitor();
    await monitor.check();
    await monitor.check();
    expect(mgr.stopForIdle).toHaveBeenCalledTimes(2);
  });

  it('a confirmed stop is not held back', async () => {
    const mgr = await seedIdleSession('stopped-idle', 61 * MIN, 'stopped');
    await new SessionHealthMonitor().check();
    expect(mgr.stopForIdle).toHaveBeenCalledTimes(1);
  });
});
