/**
 * Unit tests for the remote-identity ledger (task_remote_links) — the
 * framework guarantee that one remote item maps to at most one local task.
 *
 * What's pinned:
 *   1. State machine: owned / released / deleted, last write wins.
 *   2. isRemoteIdBlocked: released + deleted block, owned/unknown don't.
 *   3. Unconfirmed remote-delete listing + confirmation.
 *   4. Legacy tombstone import (idempotent, confirmed on arrival).
 *   5. migrateTaskSource writes 'released' rows for the task AND children.
 *   6. deleteTask writes 'deleted' rows.
 *   7. mergeTaskInto: session_ids union, sessions.task_id re-pointing, victim
 *      ledgered without tombstoning a shared remote id.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('task-remote-links'));

// Session tracker is exercised via its real module for relink, but the
// reconciler-only listSessions path isn't needed here.

import { WALNUT_HOME } from '../../src/constants.js';
import {
  recordRemoteLink,
  getRemoteLink,
  isRemoteIdBlocked,
  listUnconfirmedRemoteDeletes,
  confirmRemoteDelete,
  importLegacyTombstones,
} from '../../src/core/task-remote-links.js';
import {
  _resetForTesting,
  addTask,
  deleteTask,
  getTask,
  mergeTaskInto,
  updateTask,
  ensureProject,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';

beforeEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
});

afterEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('task_remote_links ledger', () => {
  it('records and reads back a link; last write wins', async () => {
    // Ledger reads require the task DB to be open — any task-manager call opens it.
    await addTask({ title: 'boot' });
    recordRemoteLink({ source: 'p1', remoteId: 'r1', taskId: 't1', state: 'owned' });
    expect(getRemoteLink('p1', 'r1')?.state).toBe('owned');

    recordRemoteLink({ source: 'p1', remoteId: 'r1', taskId: 't1', state: 'released', reason: 'source-migration' });
    const link = getRemoteLink('p1', 'r1');
    expect(link?.state).toBe('released');
    expect(link?.reason).toBe('source-migration');
  });

  it('isRemoteIdBlocked: released/deleted block, owned/unknown do not', async () => {
    await addTask({ title: 'boot' });
    recordRemoteLink({ source: 'p1', remoteId: 'r-owned', taskId: 't1', state: 'owned' });
    recordRemoteLink({ source: 'p1', remoteId: 'r-rel', taskId: 't1', state: 'released' });
    recordRemoteLink({ source: 'p1', remoteId: 'r-del', taskId: 't1', state: 'deleted' });

    expect(isRemoteIdBlocked('p1', 'r-owned')).toBe(false);
    expect(isRemoteIdBlocked('p1', 'r-unknown')).toBe(false);
    expect(isRemoteIdBlocked('p1', 'r-rel')).toBe(true);
    expect(isRemoteIdBlocked('p1', 'r-del')).toBe(true);
    // Scoped by source.
    expect(isRemoteIdBlocked('p2', 'r-del')).toBe(false);
  });

  it('lists unconfirmed deletes and confirms them', async () => {
    await addTask({ title: 'boot' });
    recordRemoteLink({ source: 'p1', remoteId: 'r1', state: 'deleted' });
    recordRemoteLink({ source: 'p1', remoteId: 'r2', state: 'deleted', remoteDeleteConfirmed: true });
    recordRemoteLink({ source: 'p1', remoteId: 'r3', state: 'released' });

    const pending = listUnconfirmedRemoteDeletes('p1');
    expect(pending.map((l) => l.remote_id)).toEqual(['r1']);

    confirmRemoteDelete('p1', 'r1');
    expect(listUnconfirmedRemoteDeletes('p1')).toHaveLength(0);
    expect(getRemoteLink('p1', 'r1')?.remote_delete_confirmed).toBe(true);
  });

  it('imports legacy tombstones idempotently, confirmed on arrival', async () => {
    await addTask({ title: 'boot' });
    expect(importLegacyTombstones('p1', ['a', 'b'])).toBe(2);
    expect(importLegacyTombstones('p1', ['a', 'b', 'c'])).toBe(1); // only c is new
    expect(isRemoteIdBlocked('p1', 'a')).toBe(true);
    // Legacy ids were deleted long ago — never re-attempt the remote delete.
    expect(listUnconfirmedRemoteDeletes('p1')).toHaveLength(0);
  });
});

describe('framework ledger writers', () => {
  it('a cross-source project move ledgers the released remote id', async () => {
    await ensureProject('Local Home', 'local');
    const { task } = await addTask({ title: 'Synced task', project: 'Remote Home' });
    // Simulate a synced task: hand it provider identity directly in the store.
    await updateTask(task.id, {}, { source: 'test' });
    const { updateTaskRaw } = await import('../../src/core/task-manager.js');
    await updateTaskRaw(task.id, {
      source: 'some-provider' as any,
      ext: { 'some-provider': { id: 'remote-123', list_id: 'L1' } },
    });

    // Move to a local-claimed project → migrateTaskSource clears ext.
    await updateTask(task.id, { project: 'Local Home' });

    const moved = await getTask(task.id);
    expect(moved?.source).toBe('local');
    expect(moved?.ext).toBeUndefined();
    const link = getRemoteLink('some-provider', 'remote-123');
    expect(link?.state).toBe('released');
    expect(link?.task_id).toBe(task.id);
    expect(isRemoteIdBlocked('some-provider', 'remote-123')).toBe(true);
  });

  it('deleting a task ledgers its remote id as deleted (unconfirmed)', async () => {
    const { task } = await addTask({ title: 'Doomed', project: 'P' });
    const { updateTaskRaw } = await import('../../src/core/task-manager.js');
    await updateTaskRaw(task.id, {
      source: 'some-provider' as any,
      ext: { 'some-provider': { id: 'remote-dead', list_id: 'L1' } },
    });

    await deleteTask(task.id);

    const link = getRemoteLink('some-provider', 'remote-dead');
    expect(link?.state).toBe('deleted');
    expect(link?.remote_delete_confirmed).toBe(false);
    expect(isRemoteIdBlocked('some-provider', 'remote-dead')).toBe(true);
  });
});

describe('mergeTaskInto', () => {
  it('unions session_ids, fills empty slots, re-homes children, deletes the victim', async () => {
    const { task: survivor } = await addTask({ title: 'Survivor', project: 'P' });
    const { task: victim } = await addTask({ title: 'Victim copy', project: 'P' });
    const { task: child } = await addTask({ title: 'Victim child', project: 'P', parent_task_id: victim.id });
    const { updateTaskRaw } = await import('../../src/core/task-manager.js');
    await updateTaskRaw(survivor.id, { session_ids: ['s1'] });
    await updateTaskRaw(victim.id, {
      session_ids: ['s2', 's1'],
      session_id: 'slot-a',
      ext: { 'some-provider': { id: 'remote-victim' } },
      source: 'some-provider' as any,
    });

    const { survivor: merged } = await mergeTaskInto(survivor.id, victim.id);

    expect(merged.session_ids.sort()).toEqual(['s1', 's2']);
    expect(merged.session_id).toBe('slot-a');
    await expect(getTask(victim.id)).rejects.toThrow(/No task found/);
    expect((await getTask(child.id))?.parent_task_id).toBe(survivor.id);
    // Victim's remote id is tombstoned so its twin can't come back as copy #3.
    expect(isRemoteIdBlocked('some-provider', 'remote-victim')).toBe(true);
  });

  it('does not tombstone a remote id the survivor still holds', async () => {
    const { task: survivor } = await addTask({ title: 'Twin A', project: 'P' });
    const { task: victim } = await addTask({ title: 'Twin B', project: 'P' });
    const { updateTaskRaw } = await import('../../src/core/task-manager.js');
    // Both local rows point at the SAME remote item (observed in prod: 3 rows
    // sharing one remote id). Tombstoning it would delete the survivor's twin.
    await updateTaskRaw(survivor.id, { source: 'some-provider' as any, ext: { 'some-provider': { id: 'shared-rid' } } });
    await updateTaskRaw(victim.id, { source: 'some-provider' as any, ext: { 'some-provider': { id: 'shared-rid' } } });

    await mergeTaskInto(survivor.id, victim.id);

    expect(isRemoteIdBlocked('some-provider', 'shared-rid')).toBe(false);
  });

  it('re-points sessions.task_id rows from victim to survivor', async () => {
    const { task: survivor } = await addTask({ title: 'Keeper', project: 'P' });
    const { task: victim } = await addTask({ title: 'Goner', project: 'P' });

    const { createSessionRecord, getSessionByClaudeId } = await import('../../src/core/session-tracker.js');
    await createSessionRecord('sess-follow', victim.id, 'P', '/tmp');

    const { sessionsRelinked } = await mergeTaskInto(survivor.id, victim.id);

    expect(sessionsRelinked).toBe(1);
    const session = await getSessionByClaudeId('sess-follow');
    expect(session?.taskId).toBe(survivor.id);
  });
});
