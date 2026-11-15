/**
 * Health monitor tick: the daemon probe runs for SUSPECTS, not for every session.
 *
 * check() runs every 30s ON the web event loop, and `isBackgroundWorkActive`
 * reaches the daemon (reconcileFromDaemon; ~90ms typical, 30s worst case).
 * Both per-session loops used to call it BEFORE the free in-memory checks that
 * would skip the session anyway:
 *
 *   - checkIdleTimeout probed every session before looking at how idle it was,
 *     even though the thresholds are 1-2 HOURS
 *   - checkHungSessions probed every running session before reading the
 *     timestamps that say whether a message is even outstanding
 *
 * Serial × 71 live sessions = 6.0-6.6s (idle) + 1.3-2.2s (hung) inside a single
 * check(), which is what "I type and Walnut freezes" was on 2026-09-01 (206 of
 * 220 event-loop stalls named health-monitor.check, worst 2.7s).
 *
 * The probe can only ever SUPPRESS an action, so deferring it behind the cheap
 * gates changes no outcome — these tests pin both halves of that claim: zero
 * probes for a session nothing could happen to, and a probe (still honoured)
 * for one that is genuinely a candidate.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-health-probe-order'));

/** Sessions the runner should report as busy with background work. */
const backgroundActive = new Set<string>();
let connected = true;
let duringProbe: (() => void) | undefined;
/** Every sid isBackgroundWorkActive was asked about, in call order. */
let probed: string[] = [];
/** Runner timestamps per sid (drives checkHungSessions). */
const timestamps = new Map<string, { lastClaudeOutputAt: number; lastMessageDeliveryAt: number }>();

interface FakeManager { lastEventAt: number; kill: ReturnType<typeof vi.fn>; isAlive: () => Promise<boolean> }
const managers = new Map<string, FakeManager>();

vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => false,
  isProcessAliveAsync: async () => false,
}));
vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => true,
  isLocalJsonlFresh: () => 'unknown' as const,
}));
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => connected,
  getDaemonDisconnectedSince: () => null,
  probeDaemonSession: async () => null,
  getPooledSnapshotConnection: () => null,
}));
vi.mock('../../src/providers/session-manager.js', () => ({
  getRegisteredSessionManager: (sid: string) => managers.get(sid) ?? null,
}));
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: async () => ({ session: { idle_timeout_minutes: 60, local_idle_exit_minutes: 0, local_live_limit: 0 } }),
  updateConfig: async () => undefined,
  seedConfigDefaults: async () => undefined,
}));
vi.mock('../../src/core/session-snapshot-gate.js', () => ({
  getSnapshotStatusMode: () => 'off',
}));
vi.mock('../../src/core/phase.js', () => ({
  applySessionPhase: vi.fn(async () => undefined),
  TERMINAL_PHASES: new Set(['COMPLETE', 'CANCELLED']),
}));

vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    isTeamActive: () => false,
    isCronArmed: () => false,
    isBackgroundWorkActive: (sid: string) => {
      probed.push(sid);
      duringProbe?.();
      return Promise.resolve(backgroundActive.has(sid));
    },
    hasPendingPermission: () => false,
    getSessionTimestamps: (sid: string) => timestamps.get(sid),
    markExpectedTeardown: vi.fn(),
    reconcilePendingBackgroundTasks: async () => undefined,
    findSessionByClaudeId: () => undefined,
  },
}));

import {
  createSessionRecord,
  updateSessionRecord,
} from '../../src/core/session-tracker.js';
import { SessionHealthMonitor } from '../../src/core/session-health-monitor.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { log } from '../../src/logging/index.js';

const MIN = 60_000;
const DEAD_PID = 999999999;
let seeded: string[] = [];

/** Seed a session whose idle clock is `idleMs` old. */
async function seedSession(sid: string, idleMs: number, status = 'idle'): Promise<FakeManager> {
  const mgr: FakeManager = { lastEventAt: Date.now() - idleMs, kill: vi.fn(), isAlive: async () => true };
  managers.set(sid, mgr);
  seeded.push(sid);
  await createSessionRecord(sid, '', 'proj', undefined, { pid: DEAD_PID });
  await updateSessionRecord(sid, {
    process_status: status,
    last_status_change: new Date(Date.now() - idleMs).toISOString(),
  });
  return mgr;
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  managers.clear();
  timestamps.clear();
  backgroundActive.clear();
  connected = true;
  duringProbe = undefined;
  probed = [];
  seeded = [];
});

afterEach(async () => {
  for (const sid of seeded) {
    try {
      await updateSessionRecord(sid, { archived: true, process_status: 'error', pid: undefined });
    } catch { /* store torn down */ }
  }
  for (let i = 0; i < 3; i++) {
    try { await fsp.rm(WALNUT_HOME, { recursive: true, force: true }); break; }
    catch { await new Promise(r => setTimeout(r, 50)); }
  }
});

describe('checkIdleTimeout: daemon probe only for reap candidates', () => {
  it('a session nowhere near the 1h threshold is never probed', async () => {
    await seedSession('fresh', 3 * MIN);

    await new SessionHealthMonitor().check();

    expect(probed).toEqual([]);
  });

  it('a session inside the 5-min warn window IS probed, and the probe still exempts it', async () => {
    const mgr = await seedSession('almost-reaped', 57 * MIN);

    await new SessionHealthMonitor().check();
    expect(probed).toContain('almost-reaped');
    expect(mgr.kill).not.toHaveBeenCalled(); // warn window, not the threshold yet

    // Past the threshold, but the daemon says background work is running:
    // the deferred probe must still veto the kill.
    probed = [];
    backgroundActive.add('almost-reaped');
    mgr.lastEventAt = Date.now() - 70 * MIN;
    await updateSessionRecord('almost-reaped', {
      last_status_change: new Date(Date.now() - 70 * MIN).toISOString(),
    });

    await new SessionHealthMonitor().check();
    expect(probed).toContain('almost-reaped');
    expect(mgr.kill).not.toHaveBeenCalled();
  });

  it('scales with candidates, not with session count', async () => {
    for (let i = 0; i < 12; i++) await seedSession(`bulk-${i}`, (i + 1) * MIN);
    await seedSession('candidate', 58 * MIN);

    await new SessionHealthMonitor().check();

    expect(probed).toEqual(['candidate']);
  });
});

describe('checkHungSessions: daemon probe only for real suspects', () => {
  type HungMonitor = { checkHungSessions(sessions: unknown[], update: typeof updateSessionRecord): Promise<Set<string>> };
  const scan = async (monitor: SessionHealthMonitor, sid: string) => {
    const { getSessionByClaudeId } = await import('../../src/core/session-tracker.js');
    return (monitor as unknown as HungMonitor).checkHungSessions([await getSessionByClaudeId(sid)], updateSessionRecord);
  };

  it('never calls an unconfirmed delivery or a disconnected host hung', async () => {
    await seedSession('unsent', 2 * MIN, 'running');
    timestamps.set('unsent', { lastMessageDeliveryAt: 0, lastClaudeOutputAt: 0 });
    const monitor = new SessionHealthMonitor();
    expect((await scan(monitor, 'unsent')).size).toBe(0);
    timestamps.set('unsent', { lastMessageDeliveryAt: Date.now() - 9 * MIN, lastClaudeOutputAt: 0 });
    connected = false;
    expect((await scan(monitor, 'unsent')).size).toBe(0);
    expect(probed).toEqual([]);
    connected = true;
    expect((await scan(monitor, 'unsent')).size).toBe(1);
  });

  it.each(['output', 'new-delivery', 'disconnect'])('a %s racing the probe cancels the stale warning', async (event) => {
    await seedSession('racing', 2 * MIN, 'running');
    const delivery = Date.now() - 9 * MIN;
    timestamps.set('racing', { lastMessageDeliveryAt: delivery, lastClaudeOutputAt: 0 });
    duringProbe = () => {
      if (event === 'disconnect') connected = false;
      else timestamps.set('racing', { lastMessageDeliveryAt: event === 'new-delivery' ? Date.now() : delivery,
        lastClaudeOutputAt: event === 'output' ? Date.now() : 0 });
    };
    expect((await scan(new SessionHealthMonitor(), 'racing')).size).toBe(0);
  });

  it('warns once per delivery while keeping the gauge flagged on every tick', async () => {
    await seedSession('repeat', 2 * MIN, 'running');
    const delivery = Date.now() - 9 * MIN;
    timestamps.set('repeat', { lastMessageDeliveryAt: delivery, lastClaudeOutputAt: 0 });
    const warn = vi.spyOn(log.session, 'warn');
    const warnings = () => warn.mock.calls.filter(([message]) => String(message).startsWith('health monitor: possible hung session'));
    try {
      const monitor = new SessionHealthMonitor();
      for (let i = 0; i < 4; i++) expect((await scan(monitor, 'repeat')).size).toBe(1);
      expect(warnings()).toHaveLength(1);
      timestamps.set('repeat', { lastMessageDeliveryAt: delivery + 1, lastClaudeOutputAt: 0 });
      expect((await scan(monitor, 'repeat')).size).toBe(1);
      expect(warnings()).toHaveLength(2);
      timestamps.set('repeat', { lastMessageDeliveryAt: delivery + 1, lastClaudeOutputAt: Date.now() });
      expect((await scan(monitor, 'repeat')).size).toBe(0);
    } finally { warn.mockRestore(); }
  });
  it('a running session with no outstanding message is never probed', async () => {
    await seedSession('running-quiet', 2 * MIN, 'running');
    timestamps.set('running-quiet', { lastClaudeOutputAt: Date.now(), lastMessageDeliveryAt: Date.now() - MIN });

    await new SessionHealthMonitor().check();

    expect(probed).toEqual([]);
  });

  it('a running session silent >5min after a delivered message IS probed', async () => {
    await seedSession('running-hung', 2 * MIN, 'running');
    timestamps.set('running-hung', {
      lastMessageDeliveryAt: Date.now() - 9 * MIN,
      lastClaudeOutputAt: Date.now() - 20 * MIN,
    });

    await new SessionHealthMonitor().check();

    expect(probed).toContain('running-hung');
  });
});
