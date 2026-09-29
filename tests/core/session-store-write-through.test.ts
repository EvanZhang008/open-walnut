/**
 * The session store cache is WRITE-THROUGH: a locked section that wrote rows by
 * id patches exactly those rows into the cached snapshot; a section that wrote a
 * SET of rows it never enumerated, a section that threw, or a commit from another
 * connection drops the snapshot so the next reader rescans.
 *
 * Why: dropping on every write made the next reader rebuild the snapshot with a
 * full `SELECT *` + rowToSession over ~5.6k rows (12% of main-thread CPU on the
 * live server, 2026-09-29). The invariants here are the ones that keep the
 * cheaper path honest: nothing a writer did may be invisible to a reader.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-session-write-through'));
vi.mock('../../src/utils/process.js', () => ({
  isProcessAlive: () => false,
  isProcessAliveAsync: async () => false,
}));
vi.mock('../../src/providers/daemon-connection.js', () => ({
  isDaemonConnected: () => true,
  getDaemonDisconnectedSince: () => null,
}));

import {
  batchUpdateSessionRecords,
  createSessionRecord,
  deleteSessionRecords,
  getSessionByClaudeId,
  listSessions,
  renameSessionId,
  unlinkSessionsFromTasks,
  updateSessionRecord,
  _dropSessionStoreCacheForTesting,
  _resetSessionTrackerForTesting,
  _sessionStoreStatsForTesting,
} from '../../src/core/session-tracker.js';
import { closeDb, SESSION_DB_PATH } from '../../src/core/session-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

const scans = () => _sessionStoreStatsForTesting().fullScans;

beforeEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  closeDb();
  _resetSessionTrackerForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => undefined);
});

describe('session store write-through', () => {
  it('create, update, rename and delete are visible at once without a rescan', async () => {
    await createSessionRecord('s-a', 'task-1', 'proj', '/tmp');
    await listSessions();
    const before = scans();

    await createSessionRecord('s-b', 'task-1', 'proj', '/tmp');
    expect((await listSessions()).map((s) => s.claudeSessionId).sort()).toEqual(['s-a', 's-b']);

    await updateSessionRecord('s-a', { title: 'renamed title' });
    expect((await getSessionByClaudeId('s-a'))?.title).toBe('renamed title');
    expect((await listSessions()).find((s) => s.claudeSessionId === 's-a')?.title).toBe('renamed title');

    await renameSessionId('s-b', 's-c');
    const ids = (await listSessions()).map((s) => s.claudeSessionId).sort();
    expect(ids).toEqual(['s-a', 's-c']);

    await deleteSessionRecords(new Set(['s-c']));
    expect((await listSessions()).map((s) => s.claudeSessionId)).toEqual(['s-a']);
    expect(await getSessionByClaudeId('s-c')).toBeNull();

    expect(scans()).toBe(before);
  });

  it('a batch update patches every written row and no other', async () => {
    for (const id of ['b-1', 'b-2', 'b-3']) await createSessionRecord(id, 'task-b', 'proj', '/tmp');
    await listSessions();
    const before = scans();
    const written = await batchUpdateSessionRecords(['b-1', 'b-3'], { title: 'batched' });
    expect(written.sort()).toEqual(['b-1', 'b-3']);
    const titles = Object.fromEntries((await listSessions()).map((s) => [s.claudeSessionId, s.title]));
    expect(titles['b-1']).toBe('batched');
    expect(titles['b-3']).toBe('batched');
    expect(titles['b-2']).not.toBe('batched');
    expect(scans()).toBe(before);
  });

  it('a set-based update the section never enumerated drops the snapshot instead of patching', async () => {
    await createSessionRecord('u-1', 'task-u', 'proj', '/tmp');
    await createSessionRecord('u-2', 'task-u', 'proj', '/tmp');
    await createSessionRecord('u-3', 'task-other', 'proj', '/tmp');
    await listSessions();
    const before = scans();
    expect(await unlinkSessionsFromTasks(['task-u'])).toBe(2);
    const byId = Object.fromEntries((await listSessions()).map((s) => [s.claudeSessionId, s.taskId]));
    expect(byId['u-1']).toBeUndefined();
    expect(byId['u-2']).toBeUndefined();
    expect(byId['u-3']).toBe('task-other');
    expect(scans()).toBe(before + 1);
  });

  it('a commit from another connection forces a rescan', async () => {
    await createSessionRecord('f-1', 'task-f', 'proj', '/tmp');
    await listSessions();
    const before = scans();
    const other = new Database(SESSION_DB_PATH);
    try {
      other.prepare('UPDATE sessions SET title = ? WHERE claude_session_id = ?').run('from outside', 'f-1');
    } finally {
      other.close();
    }
    // The cached list must notice (data_version moved) and rescan once.
    expect((await listSessions()).find((s) => s.claudeSessionId === 'f-1')?.title).toBe('from outside');
    expect(scans()).toBe(before + 1);
    expect((await getSessionByClaudeId('f-1'))?.title).toBe('from outside');
  });

  it('a refused rename (target id taken) changes nothing in the snapshot or on disk', async () => {
    await createSessionRecord('t-1', 'task-t', 'proj', '/tmp');
    await createSessionRecord('t-2', 'task-t', 'proj', '/tmp');
    await listSessions();
    expect(await renameSessionId('t-1', 't-2')).toBeNull();
    const cached = (await listSessions()).map((s) => s.claudeSessionId).sort();
    _dropSessionStoreCacheForTesting();
    const fresh = (await listSessions()).map((s) => s.claudeSessionId).sort();
    expect(cached).toEqual(['t-1', 't-2']);
    expect(fresh).toEqual(cached);
  });

  it('hands out copies: mutating a listed record never reaches the snapshot', async () => {
    await createSessionRecord('c-1', 'task-c', 'proj', '/tmp', { title: 'original' });
    const listed = (await listSessions()).find((s) => s.claudeSessionId === 'c-1')!;
    listed.title = 'mutated';
    expect((await getSessionByClaudeId('c-1'))?.title).toBe('original');
  });
});
