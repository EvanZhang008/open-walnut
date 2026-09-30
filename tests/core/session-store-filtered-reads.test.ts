/**
 * Filtered session-store helpers read the canonical cached rows and copy only
 * the rows they return (or the few candidates they probe for liveness), never
 * the whole store.
 *
 * Why: readStore() copies every row (~5.6k on the live server) and those
 * helpers keep a few dozen of them. On a 10 minute CPU profile the copy alone
 * was 0.6% of main-thread time (2026-09-29). The invariants here keep the
 * cheaper read honest: the same rows in the same order as before, copies a
 * caller may mutate, and a snapshot that a write landing mid-helper cannot
 * change.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

const liveness = vi.hoisted(() => ({
  dead: new Set<string>(),
  onProbe: null as null | ((sessionId: string) => Promise<void>),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-session-filtered-reads'));
vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => false,
  isProcessAliveAsync: async () => false,
}));
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}));
vi.mock('../../src/utils/session-liveness.js', async (orig) => ({
  ...(await orig<typeof import('../../src/utils/session-liveness.js')>()),
  isSessionProcessAlive: async (s: { claudeSessionId: string }) => {
    const hook = liveness.onProbe;
    if (hook) {
      liveness.onProbe = null;
      await hook(s.claudeSessionId);
    }
    return !liveness.dead.has(s.claudeSessionId);
  },
}));

import {
  checkSessionLimit,
  createSessionRecord,
  getActiveSessionsByHost,
  getAllAliveSessionsByHost,
  getRecentSessions,
  getSessionByClaudeId,
  listNonTerminalSessions,
  listSessions,
  listSessionsForTasks,
  querySessions,
  updateSessionRecord,
  updateSessionRecordConditionally,
  _resetSessionTrackerForTesting,
  _sessionStoreStatsForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb } from '../../src/core/session-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import type { SessionRecord } from '../../src/core/types.js';

const STOPPED_ROWS = 40;

/** A store shaped like the live one: mostly stopped rows, a few live ones of every kind. */
async function seedStore(): Promise<void> {
  for (let i = 0; i < STOPPED_ROWS; i++) {
    await createSessionRecord(`stopped-${i}`, `task-old-${i % 7}`, 'proj', '/tmp', { initialProcessStatus: 'stopped' });
  }
  await createSessionRecord('err-1', 'task-a', 'proj', '/tmp', { initialProcessStatus: 'error' });
  await createSessionRecord('arch-1', 'task-a', 'proj', '/tmp');
  await updateSessionRecord('arch-1', { archived: true });
  await createSessionRecord('run-local', 'task-a', 'proj', '/tmp', { title: 'alpha runner' });
  await createSessionRecord('idle-local', 'task-a', 'proj', '/tmp', { initialProcessStatus: 'idle' });
  await createSessionRecord('run-remote', 'task-b', 'proj', '/tmp', { host: 'devbox', title: 'alpha remote' });
  await createSessionRecord('idle-remote', 'task-b', 'proj', '/tmp', { host: 'devbox', initialProcessStatus: 'idle' });
  await createSessionRecord('side-1', 'task-b', 'proj', '/tmp', { lane: 'side:run-local' });
  await createSessionRecord('lane-1', 'task-c', 'proj', '/tmp', { lane: 'chat:general:one', initialProcessStatus: 'idle' });
  await createSessionRecord('emb-1', 'task-a', 'proj', '/tmp', { provider: 'embedded' });
  // Distinct activity stamps, newer than every other row, so newest-first order
  // is a real order and not a tie.
  const stamps: Record<string, string> = {
    'run-local': '2099-01-01T10:00:00.000Z',
    'idle-local': '2099-01-01T11:00:00.000Z',
    'run-remote': '2099-01-01T09:00:00.000Z',
    'idle-remote': '2099-01-01T12:00:00.000Z',
    'side-1': '2099-01-01T13:00:00.000Z',
    'lane-1': '2099-01-01T14:00:00.000Z',
  };
  for (const [id, setLastActiveAt] of Object.entries(stamps)) {
    await updateSessionRecordConditionally(id, {}, () => true, { setLastActiveAt });
  }
}

const ids = (rows: readonly SessionRecord[]) => rows.map((s) => s.claudeSessionId);
const grouped = (byHost: Record<string, SessionRecord[]>) =>
  Object.fromEntries(Object.entries(byHost).map(([host, rows]) => [host, ids(rows)]));

/** Counter deltas across one call. */
async function measure<T>(fn: () => Promise<T>): Promise<{ value: T; cloneReads: number; viewReads: number; clonedRows: number }> {
  const before = _sessionStoreStatsForTesting();
  const value = await fn();
  const after = _sessionStoreStatsForTesting();
  return {
    value,
    cloneReads: after.cloneReads - before.cloneReads,
    viewReads: after.viewReads - before.viewReads,
    clonedRows: after.clonedRows - before.clonedRows,
  };
}

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  liveness.dead.clear();
  liveness.onProbe = null;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  await seedStore();
});

afterEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('filtered session reads', () => {
  it('return the same rows in the same order as filtering the whole store', async () => {
    const all = await listSessions();
    const byHost = (rows: SessionRecord[]) => {
      const out: Record<string, string[]> = {};
      for (const s of rows) (out[s.host || 'local'] ??= []).push(s.claudeSessionId);
      return out;
    };
    const noProcess = (s: SessionRecord) => s.provider === 'embedded' || s.provider === 'sdk';

    expect(ids(await listNonTerminalSessions()))
      .toEqual(ids(all.filter((s) => s.process_status !== 'error' && !s.archived)));
    expect(grouped(await getActiveSessionsByHost())).toEqual(byHost(all.filter((s) =>
      !s.archived && s.process_status === 'running' && !noProcess(s) && !s.lane?.startsWith('side:'))));
    expect(grouped(await getAllAliveSessionsByHost())).toEqual(byHost(all.filter((s) =>
      !s.archived && s.process_status !== 'stopped' && s.process_status !== 'error' && !noProcess(s))));
    const newestFirst = (rows: SessionRecord[]) => [...rows].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt));
    expect(ids(await getRecentSessions(3))).toEqual(['idle-remote', 'idle-local', 'run-local']);
    expect(ids(await getRecentSessions(3))).toEqual(ids(newestFirst(all.filter((s) => !s.lane)).slice(0, 3)));
    expect(ids(await getRecentSessions(2, { includeLanes: true }))).toEqual(['lane-1', 'side-1']);
    expect(ids(await getRecentSessions(100, { includeLanes: true }))).toEqual(ids(newestFirst(all)));

    const limit = await checkSessionLimit('local', undefined, { max_idle: 0 });
    expect(ids(limit.runningSessions)).toEqual(['run-local']);
    expect(limit.idleCount).toBe(1);
    const remote = await checkSessionLimit('devbox', undefined, { max_idle: 0 });
    expect(ids(remote.runningSessions)).toEqual(['run-remote']);

    const page = await querySessions({ query: 'alpha', limit: 1 });
    expect(ids(page.sessions)).toEqual(['run-local']);
    expect(page).toMatchObject({ total: 2, limit: 1, hasMore: true });
    const exact = await querySessions({ query: 'run-remote' });
    expect(ids(exact.sessions)[0]).toBe('run-remote');
  });

  it('copy only what they return, never the whole store', async () => {
    const total = (await listSessions()).length;
    expect(total).toBeGreaterThan(STOPPED_ROWS);

    const calls: Array<[string, () => Promise<number>]> = [
      ['listNonTerminalSessions', async () => (await listNonTerminalSessions()).length],
      ['getActiveSessionsByHost', async () => Object.values(await getActiveSessionsByHost()).flat().length],
      ['getAllAliveSessionsByHost', async () => Object.values(await getAllAliveSessionsByHost()).flat().length],
      ['getRecentSessions', async () => (await getRecentSessions(3)).length],
      ['querySessions', async () => (await querySessions({ query: 'alpha', limit: 1 })).sessions.length],
      ['listSessionsForTasks', async () => (await listSessionsForTasks(new Set(['task-b']), new Set(['run-local']))).length],
    ];
    for (const [name, call] of calls) {
      const m = await measure(call);
      expect({ name, cloneReads: m.cloneReads, viewReads: m.viewReads, clonedRows: m.clonedRows })
        .toEqual({ name, cloneReads: 0, viewReads: 1, clonedRows: m.value });
      expect(m.value).toBeGreaterThan(0);
    }

    // The capacity check probes every live candidate on every host, and copies
    // exactly those: 6 alive rows (run/idle local and remote, side-1, lane-1).
    const limit = await measure(() => checkSessionLimit('local', undefined, { max_idle: 0 }));
    expect(limit).toMatchObject({ cloneReads: 0, viewReads: 1, clonedRows: 6 });

    // The whole-store list still pays one full copy per call.
    const listed = await measure(() => listSessions());
    expect(listed).toMatchObject({ cloneReads: 1, viewReads: 0, clonedRows: total });
  });

  it('hand out copies: mutating a result never reaches the next read', async () => {
    const results: Array<[string, () => Promise<SessionRecord[]>]> = [
      ['listNonTerminalSessions', () => listNonTerminalSessions()],
      ['getActiveSessionsByHost', async () => Object.values(await getActiveSessionsByHost()).flat()],
      ['getAllAliveSessionsByHost', async () => Object.values(await getAllAliveSessionsByHost()).flat()],
      ['getRecentSessions', () => getRecentSessions(10)],
      ['querySessions', async () => (await querySessions({})).sessions],
      ['checkSessionLimit', async () => (await checkSessionLimit('local', undefined, { max_idle: 0 })).runningSessions],
      ['listSessionsForTasks', () => listSessionsForTasks(new Set(['task-a', 'task-b']))],
    ];
    for (const [name, read] of results) {
      const first = await read();
      expect(first.length, name).toBeGreaterThan(0);
      const originals = new Map(first.map((s) => [s.claudeSessionId, { title: s.title, status: s.process_status }]));
      for (const s of first) {
        s.title = `mutated by ${name}`;
        s.process_status = 'archived-by-test' as SessionRecord['process_status'];
      }
      first.reverse();
      const again = await read();
      expect(ids(again), name).toEqual(ids([...first].reverse()));
      for (const s of again) {
        expect({ title: s.title, status: s.process_status }, name).toEqual(originals.get(s.claudeSessionId));
      }
      expect((await getSessionByClaudeId(first[0].claudeSessionId))?.title, name)
        .toBe(originals.get(first[0].claudeSessionId)!.title);
    }
  });

  it('a write that lands while a helper awaits liveness does not change what it returns', async () => {
    // The first liveness probe creates a new running local session. A write
    // appends to the cached array in place, so a helper that walked the live
    // array across its awaits would return the newcomer. They take their
    // candidates before awaiting, as the old whole-store copy did, so the
    // newcomer shows up on the NEXT read, not in this one.
    const reads: Array<[string, () => Promise<string[]>]> = [
      ['getActiveSessionsByHost', async () => Object.values(grouped(await getActiveSessionsByHost())).flat()],
      ['getAllAliveSessionsByHost', async () => Object.values(grouped(await getAllAliveSessionsByHost())).flat()],
      ['checkSessionLimit', async () => ids((await checkSessionLimit('local', undefined, { max_idle: 0 })).runningSessions)],
    ];
    for (const [name, read] of reads) {
      const before = await read();
      liveness.onProbe = async () => {
        await createSessionRecord(`late-${name}`, 'task-a', 'proj', '/tmp');
      };
      const during = await read();
      expect(liveness.onProbe, name).toBeNull();
      expect(during, name).toEqual(before);
      const after = await read();
      expect([...after].sort(), name).toEqual([...before, `late-${name}`].sort());
    }
  });

  it('listSessionsForTasks keeps sessions linked by taskId or named by id, in store order', async () => {
    const rows = await listSessionsForTasks(new Set(['task-b', 'task-old-3']), new Set(['lane-1', 'err-1', 'no-such']));
    const all = await listSessions();
    const expected = all.filter((s) =>
      s.taskId === 'task-b' || s.taskId === 'task-old-3' || s.claudeSessionId === 'lane-1' || s.claudeSessionId === 'err-1');
    expect(ids(rows)).toEqual(ids(expected));
    expect(rows).toEqual(expected);
    expect(await listSessionsForTasks(new Set())).toEqual([]);
  });

  it('a dead candidate is left out and repaired, as before', async () => {
    liveness.dead.add('run-local');
    const active = grouped(await getActiveSessionsByHost());
    expect(active.local).toBeUndefined();
    expect(active.devbox).toEqual(['run-remote']);
    await vi.waitFor(async () => {
      expect((await getSessionByClaudeId('run-local'))?.process_status).toBe('stopped');
    });
  });
});
