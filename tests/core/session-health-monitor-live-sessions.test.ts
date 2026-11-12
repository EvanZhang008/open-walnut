/**
 * The idle exit and the live limit of this machine (src/core/sessions/live-sessions.ts), through
 * the health monitor's real tick. 2026-11-11, the Operations VP: about 50 live CLIs on the Mac,
 * load 215 to 328 from paging; the pressure rule had also reaped both VPs at 15 minutes.
 * Same seams as session-health-monitor-idle-clock.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

let sessionConfig: Record<string, unknown> = {};

const exemptions = {
  teamActive: new Set<string>(),
  backgroundActive: new Set<string>(),
  pendingPermission: new Set<string>(),
  cronArmed: new Set<string>(),
  outlivingWork: new Set<string>(),
  inTurn: new Set<string>(),
};

let shedding = false;
vi.mock('../../src/core/memory-pressure.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/memory-pressure.js')>()),
  memoryPressureShedding: () => shedding,
}));

interface FakeManager {
  lastEventAt: number; kill: ReturnType<typeof vi.fn>; isAlive: () => Promise<boolean>
  cliState?: 'running' | 'idle' | 'requires_action' | null
}
const managers = new Map<string, FakeManager>();

/** Tasks the monitor reads (id → org role). */
const tasks = new Map<string, { id: string; title: string; phase: string; org_role?: string }>();

vi.mock('../../src/core/task-manager.js', async (orig) => ({
  ...(await orig<typeof import('../../src/core/task-manager.js')>()),
  listTasksByIds: async (ids: string[]) => ids.map((id) => tasks.get(id)).filter(Boolean),
  getTask: async (id: string) => { const t = tasks.get(id); if (!t) throw new Error('no task'); return t; },
}));

vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => false,
  isProcessAliveAsync: async () => false,
}));

vi.mock('../../src/utils/session-liveness.js', () => ({
  isSessionProcessAlive: async () => true,
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
  getConfig: async () => ({ session: { idle_timeout_minutes: 60, ...sessionConfig } }),
  updateConfig: async () => undefined,
  seedConfigDefaults: async () => undefined,
}));

vi.mock('../../src/core/session-snapshot-gate.js', () => ({
  getSnapshotStatusMode: () => 'off',
}));

vi.mock('../../src/core/phase.js', () => ({
  applySessionPhase: vi.fn(async () => undefined),
  standingRoutineWaits: async () => false,
  TERMINAL_PHASES: new Set(['COMPLETE', 'CANCELLED']),
}));

vi.mock('../../src/providers/claude-code-session.js', () => ({
  sessionRunner: {
    isTeamActive: (sid: string) => exemptions.teamActive.has(sid),
    isCronArmed: (sid: string) => exemptions.cronArmed.has(sid),
    isBackgroundWorkActive: (sid: string) => exemptions.backgroundActive.has(sid),
    hasWorkOutlivingTurn: (sid: string) => exemptions.outlivingWork.has(sid),
    hasPendingPermission: (sid: string) => exemptions.pendingPermission.has(sid),
    isInTurn: (sid: string) => exemptions.inTurn.has(sid),
    getSessionTimestamps: () => undefined,
    markExpectedTeardown: vi.fn(),
    reconcilePendingBackgroundTasks: async () => undefined,
    findSessionByClaudeId: () => undefined,
  },
}));

import { createSessionRecord, getSessionByClaudeId, updateSessionRecord } from '../../src/core/session-tracker.js';
import { SessionHealthMonitor, LIVE_LIMIT_WARN_MS } from '../../src/core/session-health-monitor.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { noteSeen, _resetUserAwayForTest } from '../../src/core/org/user-away.js';
import { WALNUT_HOME } from '../../src/constants.js';

const MIN = 60_000;
const DEAD_PID = 999999999;
let seeded: string[] = [];

async function seed(sid: string, quietMs: number, opts: {
  taskId?: string; orgRole?: string; host?: string; status?: 'idle' | 'running'; chatInputAgoMs?: number;
} = {}): Promise<FakeManager> {
  const mgr: FakeManager = { lastEventAt: Date.now() - quietMs, kill: vi.fn(), isAlive: async () => true, cliState: 'idle' };
  managers.set(sid, mgr);
  seeded.push(sid);
  const taskId = opts.taskId ?? `task-${sid}`;
  tasks.set(taskId, { id: taskId, title: sid, phase: 'IN_PROGRESS', ...(opts.orgRole ? { org_role: opts.orgRole } : {}) });
  await createSessionRecord(sid, taskId, 'proj', undefined, { pid: DEAD_PID, ...(opts.host ? { host: opts.host } : {}) });
  await updateSessionRecord(sid, {
    process_status: opts.status ?? 'idle',
    last_status_change: new Date(Date.now() - quietMs).toISOString(),
    ...(opts.chatInputAgoMs != null ? { chatInputAt: new Date(Date.now() - opts.chatInputAgoMs).toISOString() } : {}),
  });
  return mgr;
}

const stopped = (m: FakeManager) => m.kill.mock.calls.length > 0;

/** A clock the test moves: Date.now() is the real time plus this offset. */
const realNow = Date.now.bind(Date);
let offset = 0;
const advance = (ms: number) => { offset += ms; };

/** The live limit announces a stop on one tick and makes it on the next (at least LIVE_LIMIT_WARN_MS later). */
async function twoTicks(monitor = new SessionHealthMonitor()): Promise<SessionHealthMonitor> {
  await monitor.check();
  advance(LIVE_LIMIT_WARN_MS + 1000);
  await monitor.check();
  return monitor;
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  managers.clear();
  tasks.clear();
  for (const s of Object.values(exemptions)) s.clear();
  sessionConfig = {};
  shedding = false;
  seeded = [];
  _resetUserAwayForTest();
  offset = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const sid of seeded) {
    try { await updateSessionRecord(sid, { archived: true, process_status: 'error', pid: undefined }); } catch { /* torn down */ }
  }
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {});
});

describe('idle exit on this machine', () => {
  it('a session whose turn is over exits after the set quiet minutes, not before; the record says why', async () => {
    sessionConfig = { local_idle_exit_minutes: 15, local_live_limit: 0 };
    const old = await seed('exit-old', 16 * MIN);
    const young = await seed('exit-young', 10 * MIN);
    await new SessionHealthMonitor().check();
    expect(stopped(old)).toBe(true);
    expect(stopped(young)).toBe(false);
    const rec = await getSessionByClaudeId('exit-old');
    expect(rec?.process_status).toBe('stopped');
    expect(rec?.status_reason).toBe('idle_timeout');
  });

  it('defaults to 30 minutes, and 0 turns it off (the plain idle timeout stays)', async () => {
    sessionConfig = { local_live_limit: 0 };
    const m31 = await seed('default-31', 31 * MIN);
    const m20 = await seed('default-20', 20 * MIN);
    await new SessionHealthMonitor().check();
    expect([stopped(m31), stopped(m20)]).toEqual([true, false]);

    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 0 };
    const off = await seed('off-45', 45 * MIN);
    const plain = await seed('off-61', 61 * MIN);
    await new SessionHealthMonitor().check();
    expect([stopped(off), stopped(plain)]).toEqual([false, true]);
  });

  it('spares own work after the turn, a /loop, a prompt, a team, a turn in flight and a remote session', async () => {
    sessionConfig = { local_idle_exit_minutes: 15, local_live_limit: 0 };
    const own = await seed('spare-own', 20 * MIN); exemptions.outlivingWork.add('spare-own');
    const loop = await seed('spare-loop', 20 * MIN); exemptions.cronArmed.add('spare-loop');
    const prompt = await seed('spare-prompt', 20 * MIN); exemptions.pendingPermission.add('spare-prompt');
    const team = await seed('spare-team', 20 * MIN); exemptions.teamActive.add('spare-team');
    const turn = await seed('spare-turn', 20 * MIN, { status: 'running' }); turn.cliState = 'running';
    const remote = await seed('spare-remote', 20 * MIN, { host: 'devbox' });
    await new SessionHealthMonitor().check();
    for (const m of [own, loop, prompt, team, turn, remote]) expect(stopped(m)).toBe(false);
  });

  it('Main, a VP and a chat the user is in keep the plain timeout, under memory pressure too', async () => {
    sessionConfig = { local_idle_exit_minutes: 15, local_live_limit: 0 };
    shedding = true;
    const main = await seed('keep-main', 40 * MIN, { orgRole: 'main' });
    const vp = await seed('keep-vp', 40 * MIN, { orgRole: 'lead' });
    const typed = await seed('keep-typed', 40 * MIN, { chatInputAgoMs: 5 * MIN });
    const watched = await seed('keep-watched', 40 * MIN);
    noteSeen('session:keep-watched', Date.now() - 2 * MIN);
    const left = await seed('gone-typed', 40 * MIN, { chatInputAgoMs: 30 * MIN });
    await new SessionHealthMonitor().check();
    expect([stopped(main), stopped(vp), stopped(typed), stopped(watched)]).toEqual([false, false, false, false]);
    expect(stopped(left)).toBe(true);

    // Past the plain timeout even Main exits (the next message resumes it).
    const mainOld = await seed('main-old', 61 * MIN, { orgRole: 'main' });
    await new SessionHealthMonitor().check();
    expect(stopped(mainOld)).toBe(true);
  });
});

describe('live limit on this machine', () => {
  it('past the limit, the longest-quiet idle sessions exit until it is met; busy ones never', async () => {
    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 3 };
    const busyA = await seed('lim-turn', 50 * MIN, { status: 'running' }); busyA.cliState = 'running'; exemptions.inTurn.add('lim-turn');
    const busyB = await seed('lim-own', 50 * MIN); exemptions.outlivingWork.add('lim-own');
    const q40 = await seed('lim-q40', 40 * MIN);
    const q20 = await seed('lim-q20', 20 * MIN);
    const q10 = await seed('lim-q10', 10 * MIN);
    const fresh = await seed('lim-fresh', 2 * MIN);
    await twoTicks();
    // 6 live, limit 3: three stop, the longest quiet first; the 2-minute one is too fresh.
    expect([stopped(q40), stopped(q20), stopped(q10)]).toEqual([true, true, true]);
    expect([stopped(busyA), stopped(busyB), stopped(fresh)]).toEqual([false, false, false]);
    expect((await getSessionByClaudeId('lim-q40'))?.errorMessage).toMatch(/free memory: 6 sessions were live on this machine \(limit 3\)/);
  });

  it('stops Main and the VPs last, and never a chat the user is in', async () => {
    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 2 };
    const vp = await seed('last-vp', 50 * MIN, { orgRole: 'lead' });
    const here = await seed('last-here', 50 * MIN, { chatInputAgoMs: 3 * MIN });
    const worker = await seed('last-worker', 10 * MIN);
    const worker2 = await seed('last-worker2', 8 * MIN);
    await twoTicks();
    // 4 live, limit 2: both workers go before the longer-quiet VP; the chat is never a candidate.
    expect([stopped(worker), stopped(worker2), stopped(vp), stopped(here)]).toEqual([true, true, false, false]);
  });

  it('a VP goes when nothing else can, and a background workflow is skipped', async () => {
    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 1 };
    const vp = await seed('vp-only', 50 * MIN, { orgRole: 'lead' });
    const wf = await seed('wf', 50 * MIN); exemptions.backgroundActive.add('wf');
    await twoTicks();
    expect([stopped(vp), stopped(wf)]).toEqual([true, false]);
  });

  it('no limit (0) and under the limit stop nothing; remote sessions do not count', async () => {
    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 0 };
    const a = await seed('nolim-a', 20 * MIN);
    const b = await seed('nolim-b', 20 * MIN);
    await twoTicks();
    expect([stopped(a), stopped(b)]).toEqual([false, false]);

    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 2 };
    const r = await seed('remote-c', 20 * MIN, { host: 'devbox' });
    await twoTicks();
    expect([stopped(a), stopped(b), stopped(r)]).toEqual([false, false, false]);
  });
  it('announces the stop first (session:will-reap), and a session that spoke since is not stopped', async () => {
    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 1 };
    const heard: string[] = [];
    bus.subscribe('live-limit-probe', (e) => { if (e.name === EventNames.SESSION_WILL_REAP) heard.push((e.data as { sessionId: string }).sessionId); },
      { global: true, interest: [EventNames.SESSION_WILL_REAP] });
    try {
      const a = await seed('ann-a', 40 * MIN);
      const b = await seed('ann-b', 30 * MIN);
      const monitor = new SessionHealthMonitor();
      await monitor.check();
      expect(heard).toEqual(['ann-a']);
      expect(stopped(a)).toBe(false);
      // It wrote something in between: a new quiet clock, announced again, not stopped.
      a.lastEventAt = Date.now() - 6 * MIN;
      advance(LIVE_LIMIT_WARN_MS + 1000);
      await monitor.check();
      expect(stopped(a)).toBe(false);
      expect(stopped(b)).toBe(false);
      // b is now the longest quiet: announced on that tick, stopped on the next.
      expect(heard).toContain('ann-b');
      advance(LIVE_LIMIT_WARN_MS + 1000);
      await monitor.check();
      expect(stopped(b)).toBe(true);
      expect(stopped(a)).toBe(false);
    } finally {
      bus.unsubscribe('live-limit-probe');
    }
  });

  it('a session this server just attached is judged by its transcript after the grace, never at 0', async () => {
    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 1 };
    const unheard = await seed('attach-0', 40 * MIN);
    unheard.lastEventAt = 0;
    (unheard as { attachedAt?: number }).attachedAt = Date.now();
    const other = await seed('attach-other', 20 * MIN);
    await twoTicks();
    // Inside the grace the unheard one is no candidate; the other one goes.
    expect(stopped(unheard)).toBe(false);
    expect(stopped(other)).toBe(true);
  });

  it('idle_timeout_minutes 0 (never stop a quiet session) turns the default limit off; a set limit still holds', async () => {
    sessionConfig = { idle_timeout_minutes: 0 };
    const a = await seed('never-a', 40 * MIN);
    const b = await seed('never-b', 40 * MIN);
    const c = await seed('never-c', 40 * MIN);
    const d = await seed('never-d', 40 * MIN);
    const e = await seed('never-e', 40 * MIN);
    await twoTicks();
    expect([a, b, c, d, e].some(stopped)).toBe(false);
    sessionConfig = { idle_timeout_minutes: 0, local_live_limit: 4 };
    await twoTicks();
    expect([a, b, c, d, e].filter(stopped)).toHaveLength(1);
  });

  it('a session whose task could not be read goes last, like an org node', async () => {
    sessionConfig = { local_idle_exit_minutes: 0, local_live_limit: 1 };
    const unknown = await seed('unk-task', 50 * MIN);
    tasks.delete('task-unk-task');
    const worker = await seed('unk-worker', 10 * MIN);
    await twoTicks();
    expect([stopped(worker), stopped(unknown)]).toEqual([true, false]);
  });
});

