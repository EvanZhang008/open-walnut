/**
 * The task-fork race, exercised as a RACE (2026-09-02).
 *
 * Every previous guard for this bug family was a single-threaded component test,
 * so the interleaving that actually forks tasks was never executed. On
 * 2026-09-01 three tasks forked inside one sync tick and all 103 existing
 * edge-case tests stayed green.
 *
 * ON THE CONCURRENCY MODEL — this is not a thread test and does not pretend to
 * be. Walnut is one event loop, and the bug is AWAIT-INTERLEAVING inside it: a
 * pull `await`s between "does a local task own this remote id?" and "insert",
 * and another pull's writes land in that gap. vitest expresses that faithfully,
 * because it is the same scheduler the production code runs on. What it cannot
 * cover is the CROSS-PROCESS half (the file lock, the "database is locked"
 * retries a second process causes); that needs two real processes and is a
 * separate live test.
 *
 * `reconcilePulledTasks` makes no HTTP calls of its own (the `token` argument is
 * vestigial since checklist sync was removed), so these tests drive the real pull
 * path against the real SQLite store with no transport mock at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('ms-todo-fork-concurrency'));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => []),
  unlinkSessionsFromTasks: vi.fn(async () => 0),
  relinkSessionsToTask: vi.fn(async () => 0),
  completeTaskSessions: vi.fn(async () => 0),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import { reconcilePulledTasks } from '../../src/integrations/microsoft-todo.js';
import {
  _resetForTesting,
  addTasksBulk,
  updateTasksBulk,
  listTasks,
} from '../../src/core/task-manager.js';
import { closeDb, ensureExtIndexes } from '../../src/core/task-db.js';
import { recordRemoteLink, getRemoteLink } from '../../src/core/task-remote-links.js';
import { setExtIndexes, _resetForTesting as resetExtRegistry } from '../../src/core/ext-index-registry.js';
import type { Task } from '../../src/core/types.js';

const SPEC = { source: 'ms-todo', paths: [{ key: 'id', json: '$."ms-todo".id' }] };

/** Two lists that both map to importable projects. */
const LIST_A = { id: 'list-A', displayName: 'Alpha' };
const LIST_B = { id: 'list-B', displayName: 'Beta' };

function msTask(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: 'Shared Remote Item',
    status: 'notStarted',
    importance: 'normal',
    createdDateTime: '2026-01-01T00:00:00Z',
    lastModifiedDateTime: '2026-09-01T00:00:00Z',
    ...overrides,
  } as any;
}

/** Real store writes, so the UNIQUE index and the ledger both apply. */
const updateLocalTask = async (id: string, updates: Partial<Task>) => {
  await updateTasksBulk([{ id, patch: updates }]);
};
const addLocalTask = async (data: Omit<Task, 'id'>) => {
  const [created] = await addTasksBulk([data as any]);
  return created as Task;
};

function seedOwner(taskId: string, remoteId: string, listId: string): Promise<Task[]> {
  return addTasksBulk([{
    id: taskId,
    title: 'Shared Remote Item',
    status: 'todo', phase: 'TODO', priority: 'none',
    project: 'Alpha', source: 'ms-todo', session_ids: [],
    created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    description: '', summary: '', note: '',
    ext: { 'ms-todo': { id: remoteId, list_id: listId } },
  } as any]);
}

const msRows = async () => (await listTasks()).filter((t) => t.source === 'ms-todo');

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  resetExtRegistry();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  setExtIndexes([SPEC]);
  await listTasks();
  ensureExtIndexes([SPEC]);
});

afterEach(() => {
  closeDb();
  _resetForTesting();
  resetExtRegistry();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('two overlapping pulls carrying ONE remote id', () => {
  it('R1: two lists pulled concurrently create exactly ONE task, not two', async () => {
    // The 2026-09-01 shape: the same remote id visible from two list pulls in one
    // tick (a list migration leaves the item reachable from both for a moment).
    // Both pulls miss on findTaskByExtId, both decide to create.
    const SHARED = 'remote-shared-1';

    await Promise.all([
      reconcilePulledTasks([msTask(SHARED)], LIST_A, updateLocalTask, addLocalTask),
      reconcilePulledTasks([msTask(SHARED)], LIST_B, updateLocalTask, addLocalTask),
    ]);

    const rows = await msRows();
    expect(rows).toHaveLength(1);
    expect((rows[0].ext?.['ms-todo'] as any).id).toBe(SHARED);
  });

  it('R2: interleaved so BOTH pulls resolve "not found" before either inserts', async () => {
    // Force the exact ordering the racy check-then-insert needs: neither pull
    // commits until BOTH have looked up and missed. Only a structural constraint
    // can save this — no amount of reading can.
    //
    // The rendezvous is a bounded spin rather than a mutual barrier on purpose: if
    // a future gate refuses the second pull BEFORE it reaches the insert point,
    // the second arrival never happens, and a barrier would deadlock the suite
    // (it did, and the 30s timeout then poisoned every later test in the file via
    // the shared DB handle). Bounded means "wait if it's coming, proceed if not".
    const SHARED = 'remote-shared-2';
    const arrived: number[] = [];
    const gatedAdd = async (data: Omit<Task, 'id'>) => {
      arrived.push(1);
      for (let i = 0; i < 50 && arrived.length < 2; i++) {
        await new Promise((r) => setImmediate(r));
      }
      const [created] = await addTasksBulk([data as any]);
      return created as Task;
    };

    await Promise.all([
      reconcilePulledTasks([msTask(SHARED)], LIST_A, updateLocalTask, gatedAdd),
      reconcilePulledTasks([msTask(SHARED)], LIST_B, updateLocalTask, gatedAdd),
    ]);

    // Both reached the insert point with a clean lookup — the interleaving the
    // bug needs was genuinely executed, not merely simulated.
    expect(arrived.length).toBe(2);
    expect(await msRows()).toHaveLength(1);
  });

  it('R3: the same remote id twice in ONE pull payload creates one task', async () => {
    const SHARED = 'remote-shared-3';
    await reconcilePulledTasks(
      [msTask(SHARED), msTask(SHARED)], LIST_A, updateLocalTask, addLocalTask,
    );
    expect(await msRows()).toHaveLength(1);
  });
});

describe('the list-migration claim window', () => {
  it('R4: a pull inside the window is REFUSED — the claim beats the stale lookup', async () => {
    // Reproduces mtizcojk-c15a exactly. pushTask has POSTed the new remote item
    // and ledgered the claim; the local row still carries the OLD id because the
    // framework's ext write has not landed yet (measured gap: ~5s). A pull of the
    // new list arrives now.
    const OLD = 'remote-old-4';
    const NEW = 'remote-new-4';
    await seedOwner('owner-4', OLD, LIST_A.id);
    recordRemoteLink({
      source: 'ms-todo', remoteId: NEW, taskId: 'owner-4',
      remoteList: LIST_B.id, state: 'owned', reason: 'list-migration-claim',
    });

    await reconcilePulledTasks([msTask(NEW)], LIST_B, updateLocalTask, addLocalTask);

    const rows = await msRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('owner-4');
    // Still on the old id: the pull neither created nor hijacked it.
    expect((rows[0].ext?.['ms-todo'] as any).id).toBe(OLD);
  });

  it('R5: WITHOUT the claim the same pull would fork — proves the claim is what stops it', async () => {
    // Control for R4. Same setup, no ledger row: the pull cannot know the id is
    // owned, so it creates. This is the pre-fix behavior, kept as a test so a
    // future refactor that drops the claim write fails R4 rather than passing
    // both by accident.
    const OLD = 'remote-old-5';
    const NEW = 'remote-new-5';
    await seedOwner('owner-5', OLD, LIST_A.id);

    await reconcilePulledTasks([msTask(NEW)], LIST_B, updateLocalTask, addLocalTask);

    expect(await msRows()).toHaveLength(2);
  });

  it('R6: a released id is still refused, and an owned-by-dead-task id is not', async () => {
    const RELEASED = 'remote-released-6';
    const ORPHANED = 'remote-orphan-6';
    recordRemoteLink({
      source: 'ms-todo', remoteId: RELEASED, taskId: 'gone', state: 'released', reason: 'test',
    });
    recordRemoteLink({
      source: 'ms-todo', remoteId: ORPHANED, taskId: 'also-gone', state: 'owned', reason: 'test',
    });

    await reconcilePulledTasks(
      [msTask(RELEASED), msTask(ORPHANED)], LIST_A, updateLocalTask, addLocalTask,
    );

    const rows = await msRows();
    // released → never re-imported; owned-by-a-task-that-no-longer-exists → not
    // a live claim, so a legitimate re-import proceeds.
    expect(rows.map((t) => (t.ext?.['ms-todo'] as any).id)).toEqual([ORPHANED]);
    expect(getRemoteLink('ms-todo', RELEASED)?.state).toBe('released');
  });
});

describe('identity is never written in pieces', () => {
  it('R7: a pull that UPDATES a matched task records the list alongside the id', async () => {
    // mapToLocal emits ext as { id } only. The delta-pull update path used to pass
    // that straight through, so an update could leave a row holding an id with no
    // list — and a later push would then PATCH a list the item is not in (404
    // forever). Both keys must always be present together.
    const RID = 'remote-7';
    await seedOwner('owner-7', RID, LIST_A.id);

    await reconcilePulledTasks(
      [msTask(RID, { lastModifiedDateTime: '2027-01-01T00:00:00Z' })],
      LIST_B, updateLocalTask, addLocalTask,
    );

    const rows = await msRows();
    expect(rows).toHaveLength(1);
    const ext = rows[0].ext?.['ms-todo'] as any;
    expect(ext.id).toBe(RID);
    expect(ext.list_id).toBe(LIST_B.id);
  });

  it('R8: a freshly created row carries id AND list_id', async () => {
    await reconcilePulledTasks([msTask('remote-8')], LIST_A, updateLocalTask, addLocalTask);
    const ext = (await msRows())[0].ext?.['ms-todo'] as any;
    expect(ext).toMatchObject({ id: 'remote-8', list_id: LIST_A.id });
  });
});
