/**
 * The remote-identity invariant is STRUCTURAL, not procedural (2026-09-02).
 *
 * "One remote item maps to at most one local task" was enforced three times by a
 * racy read (`findTaskByExtId` then insert), and forked tasks three times: Apr
 * 2026, Aug 2026 (the ledger), and Sep 2026 (this round, 3 tasks in one sync
 * tick). This file pins the replacements:
 *
 *   A. The partial UNIQUE ext-id index — the constraint itself, its default
 *      (paths[0] is unique), the pre-existing-duplicate fallback, and the
 *      violation report that fallback produces.
 *   B. isRemoteIdClaimedByLiveTask — the gate isRemoteIdBlocked was missing. An
 *      id a LIVE task owns must never mint a second task; a stale 'owned' row
 *      whose task is gone must NOT block forever.
 *   C. addTasksBulk's conflict handling — it used INSERT OR REPLACE, which with
 *      the new index would DELETE the survivor instead of merely forking it.
 *   D. deleteTask's shared-id guard — deleting a duplicate that carries the
 *      SURVIVOR's remote id must not tombstone the id (the ledger PK would
 *      overwrite the survivor's 'owned' row) and must not remote-delete the
 *      survivor's twin.
 *
 * The task store is the real SQLite-backed task-manager; only the session
 * tracker and the plugin's remote hooks are mocked.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('remote-id-uniqueness'));

vi.mock('../../src/core/session-tracker.js', () => ({
  listSessions: vi.fn(async () => []),
  unlinkSessionsFromTasks: vi.fn(async () => 0),
  relinkSessionsToTask: vi.fn(async () => 0),
  completeTaskSessions: vi.fn(async () => 0),
}));

import { SYNC_DIR, WALNUT_HOME } from '../../src/constants.js';
import {
  _resetForTesting,
  addTasksBulk,
  listTasks,
  deleteTask,
  mergeTaskInto,
  findTaskByExtId,
} from '../../src/core/task-manager.js';
import {
  closeDb,
  getDb,
  ensureExtIndexes,
  listExtIdViolations,
  getExtIndexUniquenessGaps,
} from '../../src/core/task-db.js';
import {
  getRemoteLink,
  recordRemoteLink,
  isRemoteIdClaimedByLiveTask,
  findLiveClaimants,
} from '../../src/core/task-remote-links.js';
import { setExtIndexes, _resetForTesting as resetExtRegistry } from '../../src/core/ext-index-registry.js';
import { registry } from '../../src/core/integration-registry.js';
import type { RegisteredPlugin } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

const SOURCE = 'ms-todo';
const JSON_PATH = '$."ms-todo".id';

const SPEC = { source: SOURCE, paths: [{ key: 'id', json: JSON_PATH }] };

function makeTask(id: string, remoteId: string | undefined, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Task ${id}`,
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    project: 'Proj',
    source: SOURCE,
    session_ids: [],
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    description: '',
    summary: '',
    note: '',
    ext: remoteId ? { 'ms-todo': { id: remoteId, list_id: 'list-A' } } : {},
    ...overrides,
  } as unknown as Task;
}

/** Insert rows bypassing addTasksBulk's constraint handling, so a test can
 *  create the ALREADY-BROKEN shape the repair has to cope with.
 *
 *  Ends with `_resetForTesting()` to drop the whole-store read cache: this INSERT
 *  runs on task-manager's OWN connection, so `PRAGMA data_version` does not move
 *  and readStore()'s staleness check cannot see it (same reason
 *  invalidateRowShadow exists for the per-row fast paths). */
function forceInsertDuplicate(task: Task): void {
  const db = getDb()!;
  db.prepare(
    `INSERT INTO tasks (id, title, project, status, phase, priority, source, ext,
                        session_ids, created_at, updated_at, note, summary, description)
     VALUES (@id, @title, @project, @status, @phase, @priority, @source, @ext,
             @session_ids, @created_at, @updated_at, '', '', '')`,
  ).run({
    id: task.id, title: task.title, project: task.project, status: task.status,
    phase: task.phase, priority: task.priority, source: task.source,
    ext: JSON.stringify(task.ext ?? {}), session_ids: JSON.stringify(task.session_ids ?? []),
    created_at: task.created_at, updated_at: task.updated_at,
  });
  _resetForTesting();
}

const deleteTaskHook = vi.fn();

function registerPlugin(): void {
  registry.clear();
  const plugin = {
    id: SOURCE,
    name: 'Microsoft To-Do',
    config: {},
    sync: {
      deleteTask: deleteTaskHook,
      pushTask: vi.fn(),
      extractRemoteId: (t: Task) => (t.ext?.[SOURCE] as any)?.id,
      extractRemoteIdAliases: (t: Task) => {
        const prev = (t.ext?.[SOURCE] as any)?.previous_ids;
        return Array.isArray(prev) ? prev : [];
      },
    },
    migrations: [],
    httpRoutes: [],
  } as unknown as RegisteredPlugin;
  registry.registerOrReplace?.(SOURCE, plugin) ?? registry.register(SOURCE, plugin);
}

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  resetExtRegistry();
  deleteTaskHook.mockReset();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(SYNC_DIR, { recursive: true });
  setExtIndexes([SPEC]);
  registerPlugin();
  // Touch the store so the DB + schema exist before any raw SQL runs.
  await listTasks();
});

afterEach(() => {
  closeDb();
  _resetForTesting();
  resetExtRegistry();
  registry.clear();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ═══════════════════════════════════════════════════════════════════════════
// A. The constraint
// ═══════════════════════════════════════════════════════════════════════════

describe('A. partial UNIQUE ext-id index', () => {
  it('A1: paths[0] is UNIQUE by default — no plugin opt-in required', () => {
    ensureExtIndexes([SPEC]);
    const rows = getDb()!.pragma('index_list(tasks)') as Array<{ name: string; unique: number }>;
    const idx = rows.find((r) => r.name === 'idx_tasks_ext_ms_todo_id');
    expect(idx, 'index should exist').toBeTruthy();
    expect(idx!.unique).toBe(1);
  });

  it('A2: an explicit unique:false opts out, and secondary paths stay non-unique', () => {
    ensureExtIndexes([{
      source: SOURCE,
      paths: [
        { key: 'id', json: JSON_PATH, unique: false },
        { key: 'short', json: '$."ms-todo".short' },
      ],
    }]);
    const rows = getDb()!.pragma('index_list(tasks)') as Array<{ name: string; unique: number }>;
    expect(rows.find((r) => r.name === 'idx_tasks_ext_ms_todo_id')!.unique).toBe(0);
    expect(rows.find((r) => r.name === 'idx_tasks_ext_ms_todo_short')!.unique).toBe(0);
  });

  it('A3: UPGRADES an existing non-unique index (the shape every pre-fix DB has)', () => {
    // Simulate the old release: a plain index of the same name already exists.
    // `CREATE UNIQUE INDEX IF NOT EXISTS` is a NO-OP against it, so the old one
    // has to be dropped first — without that, no existing install ever gains
    // the constraint.
    ensureExtIndexes([{ source: SOURCE, paths: [{ key: 'id', json: JSON_PATH, unique: false }] }]);
    expect(
      (getDb()!.pragma('index_list(tasks)') as Array<{ name: string; unique: number }>)
        .find((r) => r.name === 'idx_tasks_ext_ms_todo_id')!.unique,
    ).toBe(0);

    ensureExtIndexes([SPEC]);
    expect(
      (getDb()!.pragma('index_list(tasks)') as Array<{ name: string; unique: number }>)
        .find((r) => r.name === 'idx_tasks_ext_ms_todo_id')!.unique,
    ).toBe(1);
  });

  it('A4: the constraint REFUSES a second task holding the same remote id', async () => {
    ensureExtIndexes([SPEC]);
    await addTasksBulk([makeTask('t-keep', 'R1')]);
    expect(() => forceInsertDuplicate(makeTask('t-fork', 'R1'))).toThrow(/UNIQUE constraint failed/);
    expect((await listTasks()).filter((t) => t.source === SOURCE)).toHaveLength(1);
  });

  it('A5: NULL remote ids are unconstrained — unsynced rows are all distinct', async () => {
    ensureExtIndexes([SPEC]);
    await addTasksBulk([makeTask('t-a', undefined), makeTask('t-b', undefined)]);
    expect((await listTasks()).filter((t) => t.source === SOURCE)).toHaveLength(2);
  });

  it('A6: pre-existing duplicates do NOT break boot — falls back and REPORTS them', async () => {
    // The state the live DB was in: 38 duplicate groups. A throw here would take
    // the whole server down on start, which is strictly worse than an unenforced
    // index — so the failure degrades and becomes a report instead.
    forceInsertDuplicate(makeTask('t-1', 'DUP'));
    forceInsertDuplicate(makeTask('t-2', 'DUP'));

    expect(() => ensureExtIndexes([SPEC])).not.toThrow();

    const rows = getDb()!.pragma('index_list(tasks)') as Array<{ name: string; unique: number }>;
    expect(rows.find((r) => r.name === 'idx_tasks_ext_ms_todo_id')!.unique).toBe(0);

    const gaps = getExtIndexUniquenessGaps();
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ source: SOURCE, path: JSON_PATH, groups: 1 });

    const violations = listExtIdViolations(SOURCE, JSON_PATH);
    expect(violations).toHaveLength(1);
    expect(violations[0].remoteId).toBe('DUP');
    expect(violations[0].taskIds.sort()).toEqual(['t-1', 't-2']);
  });

  it('A7: once the duplicates are gone, the next boot reports no gap and enforces', async () => {
    forceInsertDuplicate(makeTask('t-1', 'DUP'));
    forceInsertDuplicate(makeTask('t-2', 'DUP'));
    ensureExtIndexes([SPEC]);
    expect(getExtIndexUniquenessGaps()).toHaveLength(1);

    await mergeTaskInto('t-1', 't-2');

    ensureExtIndexes([SPEC]);
    expect(getExtIndexUniquenessGaps()).toHaveLength(0);
    expect(listExtIdViolations(SOURCE, JSON_PATH)).toHaveLength(0);
    expect(
      (getDb()!.pragma('index_list(tasks)') as Array<{ name: string; unique: number }>)
        .find((r) => r.name === 'idx_tasks_ext_ms_todo_id')!.unique,
    ).toBe(1);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// B. The claim gate
// ═══════════════════════════════════════════════════════════════════════════

describe('B. isRemoteIdClaimedByLiveTask', () => {
  it('B1: an id owned by a live task is claimed — this is the gate the fork slipped through', async () => {
    await addTasksBulk([makeTask('t-owner', 'R1')]);
    recordRemoteLink({ source: SOURCE, remoteId: 'R1', taskId: 't-owner', state: 'owned' });
    expect(isRemoteIdClaimedByLiveTask(SOURCE, 'R1')).toEqual({ claimed: true, byTaskId: 't-owner' });
  });

  it('B2: a claim written BEFORE the owner carries the id still blocks (the migration window)', async () => {
    // Exactly the 5-second window that forked mtizcojk-c15a: the remote POST has
    // returned, so the ledger row exists, but the local row still holds the OLD
    // id. A pull landing here must be refused even though findTaskByExtId misses.
    await addTasksBulk([makeTask('t-owner', 'OLD')]);
    recordRemoteLink({ source: SOURCE, remoteId: 'NEW', taskId: 't-owner', state: 'owned' });

    expect(await findTaskByExtId(SOURCE, 'NEW')).toBeUndefined();
    expect(isRemoteIdClaimedByLiveTask(SOURCE, 'NEW').claimed).toBe(true);
  });

  it('B3: a STALE owned row whose task is gone does NOT block forever', async () => {
    recordRemoteLink({ source: SOURCE, remoteId: 'R9', taskId: 't-vanished', state: 'owned' });
    expect(isRemoteIdClaimedByLiveTask(SOURCE, 'R9').claimed).toBe(false);
  });

  it('B4: excludeTaskId answers "does anyone ELSE hold this?"', async () => {
    await addTasksBulk([makeTask('t-owner', 'R1')]);
    recordRemoteLink({ source: SOURCE, remoteId: 'R1', taskId: 't-owner', state: 'owned' });
    expect(isRemoteIdClaimedByLiveTask(SOURCE, 'R1', 't-owner').claimed).toBe(false);
    expect(isRemoteIdClaimedByLiveTask(SOURCE, 'R1', 't-other').claimed).toBe(true);
  });

  it('B5: the check is scoped per source — same id under another provider is unrelated', async () => {
    await addTasksBulk([makeTask('t-owner', 'SHARED')]);
    recordRemoteLink({ source: SOURCE, remoteId: 'SHARED', taskId: 't-owner', state: 'owned' });
    expect(isRemoteIdClaimedByLiveTask('other-provider', 'SHARED').claimed).toBe(false);
  });

  it('B6: findLiveClaimants reports every shared id, excluding the asker', async () => {
    await addTasksBulk([makeTask('t-keep', 'R1')]);
    recordRemoteLink({ source: SOURCE, remoteId: 'R1', taskId: 't-keep', state: 'owned' });
    expect(findLiveClaimants(SOURCE, ['R1', 'R2'], 't-fork'))
      .toEqual([{ remoteId: 'R1', taskId: 't-keep' }]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// C. addTasksBulk conflict handling
// ═══════════════════════════════════════════════════════════════════════════

describe('C. addTasksBulk never destroys a row on conflict', () => {
  it('C1: a pulled row carrying a live task\'s remote id is SKIPPED, not REPLACED', async () => {
    ensureExtIndexes([SPEC]);
    await addTasksBulk([makeTask('t-keep', 'R1', { note: 'the real one' })]);

    const created = await addTasksBulk([makeTask('t-fork', 'R1')]);

    // The old INSERT OR REPLACE would have deleted t-keep and inserted t-fork.
    expect(created).toHaveLength(0);
    const rows = (await listTasks()).filter((t) => t.source === SOURCE);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('t-keep');
    expect(rows[0].note).toBe('the real one');
  });

  it('C2: one conflicting row does not abort the rest of the batch', async () => {
    ensureExtIndexes([SPEC]);
    await addTasksBulk([makeTask('t-keep', 'R1')]);

    const created = await addTasksBulk([
      makeTask('t-fork', 'R1'),
      makeTask('t-new', 'R2'),
    ]);

    expect(created.map((t) => t.id)).toEqual(['t-new']);
    expect((await listTasks()).filter((t) => t.source === SOURCE).map((t) => t.id).sort())
      .toEqual(['t-keep', 't-new']);
  });

  it('C3: a duplicate LOCAL id no longer silently overwrites the earlier row', async () => {
    // generateId() collides ~1.85% of the time in a 50-row batch
    // (tests/core/generate-id-collision.test.ts). OR REPLACE reported success
    // while storing 49 of 50.
    await addTasksBulk([makeTask('same-id', 'R1', { note: 'first' })]);
    const created = await addTasksBulk([makeTask('same-id', 'R2', { note: 'second' })]);
    expect(created).toHaveLength(0);
    const rows = (await listTasks()).filter((t) => t.id === 'same-id');
    expect(rows).toHaveLength(1);
    expect(rows[0].note).toBe('first');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// D. deleteTask's shared-id guard
// ═══════════════════════════════════════════════════════════════════════════

describe('D. deleting a duplicate never damages the survivor', () => {
  beforeEach(async () => {
    // The broken shape: two rows, one remote id. The survivor carries the ledger
    // 'owned' row; the fork has NO ledger row at all (measured on the live DB).
    forceInsertDuplicate(makeTask('t-keep', 'R1'));
    forceInsertDuplicate(makeTask('t-fork', 'R1'));
    recordRemoteLink({
      source: SOURCE, remoteId: 'R1', taskId: 't-keep', remoteList: 'list-A', state: 'owned',
    });
  });

  it('D1: does NOT overwrite the survivor\'s owned row with a deleted tombstone', async () => {
    await deleteTask('t-fork');
    const link = getRemoteLink(SOURCE, 'R1');
    expect(link?.state).toBe('owned');
    expect(link?.task_id).toBe('t-keep');
  });

  it('D2: does NOT ask the provider to delete the survivor\'s remote twin', async () => {
    await deleteTask('t-fork');
    expect(deleteTaskHook).not.toHaveBeenCalled();
  });

  it('D3: still deletes the local row (the delete is not silently refused)', async () => {
    await deleteTask('t-fork');
    const ids = (await listTasks()).filter((t) => t.source === SOURCE).map((t) => t.id);
    expect(ids).toEqual(['t-keep']);
  });

  it('D4: an UNSHARED id is still tombstoned and still remote-deleted', async () => {
    // The guard must be narrow: normal deletes keep their remote semantics.
    await addTasksBulk([makeTask('t-solo', 'R-SOLO')]);
    recordRemoteLink({
      source: SOURCE, remoteId: 'R-SOLO', taskId: 't-solo', remoteList: 'list-A', state: 'owned',
    });

    await deleteTask('t-solo');

    expect(getRemoteLink(SOURCE, 'R-SOLO')?.state).toBe('deleted');
    expect(deleteTaskHook).toHaveBeenCalledTimes(1);
  });

  it('D5: mergeTaskInto is safe for the same reason — the shared id keeps its owner', async () => {
    await mergeTaskInto('t-keep', 't-fork');
    const link = getRemoteLink(SOURCE, 'R1');
    expect(link?.state).toBe('owned');
    expect(link?.task_id).toBe('t-keep');
    expect(deleteTaskHook).not.toHaveBeenCalled();
    expect((await listTasks()).filter((t) => t.source === SOURCE).map((t) => t.id)).toEqual(['t-keep']);
  });
});
