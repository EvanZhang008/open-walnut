/**
 * The idle reaper's clock (checkIdleTimeout), as measured on 2026-10-25: 35 live
 * CLIs held 9.9 GB on the Mac and none was ever reaped, several of them silent
 * for 4 hours, because
 *   - the clock lives in memory and starts at 0 on a server start, and a session
 *     at 0 was skipped until its CLI wrote again (an idle CLI writes nothing);
 *   - Walnut's own control traffic at every start moved it (stream-activity.ts);
 *   - a status change into idle counted as activity.
 * And under memory pressure an idle CLI is reclaimed after 15 minutes.
 * Same seams as session-health-monitor-will-reap.test.ts.
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
  outlivingWork: new Set<string>(),
};

let shedding = false;
vi.mock('../../src/core/memory-pressure.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/memory-pressure.js')>()),
  memoryPressureShedding: () => shedding,
}));

/** Fake SessionManagers keyed by sid — lastEventAt drives the idle clock. */
interface FakeManager {
  lastEventAt: number; kill: ReturnType<typeof vi.fn>; isAlive: () => Promise<boolean>
  cliState?: 'running' | 'idle' | 'requires_action' | null; attachedAt?: number
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
import { SessionHealthMonitor, PRESSURE_IDLE_TIMEOUT_MS, TRANSCRIPT_SEED_GRACE_MS, OUTLIVING_WORK_IDLE_TIMEOUT_MS } from '../../src/core/session-health-monitor.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { canonicalJsonlPath } from '../../src/core/session-file-reader.js';
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
  taskId?: string; host?: string; statusChangeAgeMs?: number; status?: 'idle' | 'running'; cwd?: string;
} = {}): Promise<FakeManager> {
  const kill = vi.fn();
  const mgr: FakeManager = {
    lastEventAt: Date.now() - idleMs,
    kill,
    isAlive: async () => true,
  };
  managers.set(sid, mgr);
  seeded.push(sid);
  await createSessionRecord(sid, opts.taskId ?? '', 'proj', opts.cwd, {
    pid: DEAD_PID,
    ...(opts.host ? { host: opts.host } : {}),
  });
  await updateSessionRecord(sid, {
    process_status: opts.status ?? 'idle',
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
  exemptions.outlivingWork.clear();
  processAlive = true;
  idleTimeoutMinutes = 60;
  shedding = false;
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


const CWD = '/work/idle-clock-repo';

/** A transcript whose newest CLI entry is `ageMs` old, then lines without a
 *  timestamp (another writer's) after it. */
async function writeTranscript(sid: string, ageMs: number): Promise<void> {
  const file = canonicalJsonlPath(sid, CWD);
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const at = new Date(Date.now() - ageMs).toISOString();
  const lines = [
    { type: 'user', message: { role: 'user', content: 'hi' }, timestamp: new Date(Date.now() - ageMs - MIN).toISOString() },
    { type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'done' }] }, timestamp: at },
    { type: 'cost-state', state: null },
  ];
  await fsp.writeFile(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

const killed = (mgr: FakeManager) => mgr.kill.mock.calls.length > 0 || warnings.some((w) => w.remainingMs === 0);

describe('idle clock after a server start', () => {
  it('a session the server has heard nothing from is timed from its transcript', async () => {
    const mgr = await seedIdleSession('restart-idle', 61 * MIN, { cwd: CWD });
    mgr.lastEventAt = 0;
    await writeTranscript('restart-idle', 61 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings.map((w) => w.sessionId)).toEqual(['restart-idle']);
    expect(warnings[0].remainingMs).toBe(0);
    expect(warnings[0].idleDurationMs).toBeGreaterThanOrEqual(61 * MIN);
  });

  it('a recent transcript entry keeps it', async () => {
    const mgr = await seedIdleSession('restart-recent', 61 * MIN, { cwd: CWD });
    mgr.lastEventAt = 0;
    await writeTranscript('restart-recent', 10 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
  });

  it('no transcript found: skipped, as before', async () => {
    const mgr = await seedIdleSession('restart-nofile', 61 * MIN, { cwd: CWD });
    mgr.lastEventAt = 0;

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
  });

  it('waits out the grace after an attach before reading the transcript', async () => {
    const mgr = await seedIdleSession('restart-grace', 61 * MIN, { cwd: CWD });
    mgr.lastEventAt = 0;
    // A long tool running at the restart beats into the stream within 30 s,
    // never into the transcript, so a just-attached silence proves nothing.
    mgr.attachedAt = Date.now() - 30_000;
    await writeTranscript('restart-grace', 61 * MIN);

    await new SessionHealthMonitor().check();
    expect(warnings).toHaveLength(0);

    mgr.attachedAt = Date.now() - TRANSCRIPT_SEED_GRACE_MS - 1000;
    await new SessionHealthMonitor().check();
    expect(warnings.map((w) => w.sessionId)).toEqual(['restart-grace']);
  });

  it('a remote session at 0 is still skipped (its transcript is on the other host)', async () => {
    const mgr = await seedIdleSession('restart-remote', 61 * MIN, { cwd: CWD, host: 'devbox' });
    mgr.lastEventAt = 0;
    await writeTranscript('restart-remote', 61 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings).toHaveLength(0);
  });
});

describe('idle timeout under memory pressure', () => {
  it('a local session idle 16 min is reclaimed while pressure lasts, not before', async () => {
    await seedIdleSession('pressure-idle', 16 * MIN);

    await new SessionHealthMonitor().check();
    expect(warnings).toHaveLength(0);

    shedding = true;
    await new SessionHealthMonitor().check();
    expect(warnings.map((w) => w.sessionId)).toEqual(['pressure-idle']);
    expect(warnings[0].remainingMs).toBe(0);
    expect(warnings[0].idleTimeoutMs).toBe(PRESSURE_IDLE_TIMEOUT_MS);
  });

  it('reads the CLI\'s own word that its turn is over when it has one', async () => {
    shedding = true;
    const done = await seedIdleSession('pressure-cli-idle', 16 * MIN, { status: 'running', statusChangeAgeMs: 61 * MIN });
    done.cliState = 'idle';

    await new SessionHealthMonitor().check();

    expect(warnings.map((w) => w.sessionId)).toEqual(['pressure-cli-idle']);
    expect(warnings[0].idleTimeoutMs).toBe(PRESSURE_IDLE_TIMEOUT_MS);
  });

  it('spares a turn still running however long it has been silent, a permission wait, a cron-armed one, and a remote one', async () => {
    shedding = true;
    // A long MCP tool: 16 min with no conversation line, the turn far older than a minute.
    const longTool = await seedIdleSession('pressure-turn', 16 * MIN, { statusChangeAgeMs: 61 * MIN });
    longTool.cliState = 'running';
    const asking = await seedIdleSession('pressure-asking', 16 * MIN);
    asking.cliState = 'requires_action';
    // Nothing heard since an attach: the record says the turn is running.
    await seedIdleSession('pressure-unheard', 16 * MIN, { status: 'running', statusChangeAgeMs: 61 * MIN });
    await seedIdleSession('pressure-cron', 16 * MIN);
    exemptions.cronArmed.add('pressure-cron');
    await seedIdleSession('pressure-remote', 16 * MIN, { host: 'devbox' });
    const quiet = await seedIdleSession('pressure-young', 12 * MIN);

    await new SessionHealthMonitor().check();

    expect(warnings.map((w) => w.sessionId).sort()).toEqual(['pressure-young']);
    expect(warnings[0].remainingMs).toBeGreaterThan(2 * MIN);
    expect(killed(quiet)).toBe(false);
  });
});

describe('work that runs on after the turn', () => {
  // 2026-10-27: a session whose two queued test runs were detached background commands. Its
  // turn was over (the CLI said idle, the record still said running for the detached work), the
  // Mac was under memory pressure, and 20 quiet minutes later the reap killed it and both runs.
  it('spares a session with a detached command in flight, under pressure too', async () => {
    shedding = true;
    const busy = await seedIdleSession('detached-tests', 20 * MIN, { status: 'running', statusChangeAgeMs: 4 * 60 * MIN });
    busy.cliState = 'idle';
    exemptions.outlivingWork.add('detached-tests');
    const done = await seedIdleSession('detached-none', 20 * MIN, { status: 'running', statusChangeAgeMs: 4 * 60 * MIN });
    done.cliState = 'idle';

    await new SessionHealthMonitor().check();

    expect(warnings.map((w) => w.sessionId)).toEqual(['detached-none']);
    expect(busy.kill).not.toHaveBeenCalled();
  });

  it('is extended, not disabled: a day without a word ends it anyway', async () => {
    const forever = await seedIdleSession('detached-dev-server', OUTLIVING_WORK_IDLE_TIMEOUT_MS + 5 * MIN);
    exemptions.outlivingWork.add('detached-dev-server');
    const young = await seedIdleSession('detached-young', 3 * 60 * MIN);
    exemptions.outlivingWork.add('detached-young');

    await new SessionHealthMonitor().check();

    expect(warnings.map((w) => w.sessionId)).toEqual(['detached-dev-server']);
    expect(killed(forever)).toBe(true);
    expect(young.kill).not.toHaveBeenCalled();
  });
});
