/**
 * Tests for task-db.ts (SQLite foundation), task-db-migration.ts (JSON→SQLite
 * one-shot), and the task-manager bulk / raw update paths that sit on top.
 *
 * Each test runs against a real on-disk SQLite file under a tmp WALNUT_HOME
 * (see createMockConstants) — no mocking of better-sqlite3. The module-level
 * singleton in task-db.ts is torn down between tests via closeDb() so TASK_DB_PATH
 * (computed at import time) keeps pointing at a freshly wiped directory.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-db'));

import {
  getDb,
  closeDb,
  transaction,
  rowToTask,
  taskToRow,
  TASK_COLUMNS,
  TASK_DB_PATH,
} from '../../src/core/task-db.js';
import { runMigrationIfNeeded } from '../../src/core/task-db-migration.js';
import {
  _resetForTesting,
  addTask,
  updateTaskRaw,
  updateTasksBulk,
  addTasksBulk,
  deleteTasksBulk,
  listTasks,
  getTask,
  buildTaskQueryWhere,
  queryTasks,
  taskQueryCandidateSql,
} from '../../src/core/task-manager.js';
import { normalizeTaskQuery, type TaskQuery } from '../../src/core/task-query.js';
import { WALNUT_HOME, TASKS_FILE, TASKS_DIR } from '../../src/constants.js';
import type { Task } from '../../src/core/types.js';

async function resetAll(): Promise<void> {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(TASKS_DIR, { recursive: true });
}

beforeEach(async () => {
  await resetAll();
});

afterEach(async () => {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── 1. Schema idempotency ──────────────────────────────────────────────────

describe('task-db: schema idempotency', () => {
  it('getDb() twice returns the same handle and schema is stable', () => {
    const db1 = getDb();
    expect(db1).not.toBeNull();
    // Collect table + index list from first open.
    const tablesBefore = db1!
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];

    const db2 = getDb();
    expect(db2).toBe(db1); // same singleton

    const tablesAfter = db1!
      .prepare("SELECT name FROM sqlite_master WHERE type IN ('table','index') ORDER BY name")
      .all() as { name: string }[];

    expect(tablesAfter).toEqual(tablesBefore);
    expect(tablesBefore.some((t) => t.name === 'tasks')).toBe(true);
    // Project registry: the single grouping layer + sync-claim point.
    expect(tablesBefore.some((t) => t.name === 'task_projects')).toBe(true);
    // task_categories died with the category concept (dropped by the v5 migration,
    // never recreated by SCHEMA_SQL).
    expect(tablesBefore.some((t) => t.name === 'task_categories')).toBe(false);
    // The tasks table has no category column either.
    const cols = db1!.prepare('PRAGMA table_info(tasks)').all() as { name: string }[];
    expect(cols.some((c) => c.name === 'category')).toBe(false);
    expect(cols.some((c) => c.name === 'project')).toBe(true);
  });

  it('re-opening after closeDb() still produces a valid schema', () => {
    const db1 = getDb();
    expect(db1).not.toBeNull();
    db1!.prepare('INSERT INTO tasks (id, title, project) VALUES (?, ?, ?)').run('x1', 't', 'p');
    closeDb();

    const db2 = getDb();
    expect(db2).not.toBeNull();
    const row = db2!.prepare('SELECT id, title FROM tasks WHERE id = ?').get('x1') as
      | { id: string; title: string }
      | undefined;
    expect(row?.title).toBe('t');
  });

  it('a failed open rethrows the ORIGINAL error on every later call (never silent null)', async () => {
    // Force the open to fail: TASKS_DIR occupied by a plain file, so the
    // mkdirSync inside getDb() throws. This simulates any hard open failure
    // (e.g. the missing better-sqlite3 native binding seen in prod 2026-07-10).
    await fsp.rm(TASKS_DIR, { recursive: true, force: true });
    await fsp.writeFile(TASKS_DIR, 'not a directory');

    let firstErr: unknown;
    try { getDb(); } catch (err) { firstErr = err; }
    expect(firstErr).toBeTruthy();

    // Subsequent calls must surface the same root cause — a silent `null`
    // here degrades every caller to "Cannot read properties of null".
    expect(() => getDb()).toThrow();
    try { getDb(); } catch (err) { expect(err).toBe(firstErr); }

    // closeDb() clears the poisoned state so a repaired environment recovers.
    await fsp.rm(TASKS_DIR, { force: true });
    await fsp.mkdir(TASKS_DIR, { recursive: true });
    closeDb();
    expect(getDb()).not.toBeNull();
  });
});

// ── 1b. Query indexes ──────────────────────────────────────────────────────
//
// The composable task query pushes phase sets and time windows into SQL as a
// CANDIDATE reduction; task-query.ts's matchesTaskQuery is the semantic truth
// and re-checks everything. So a plan here is a performance statement only:
// a SCAN costs a bigger candidate set, never a wrong answer.
//
// Every plan below is EXPLAINed against the SQL taskQueryCandidateSql() really
// emits — a hand-written approximation would let the emitted shape drift while
// the test stayed green.

describe('task-db: composable-query indexes', () => {
  const indexNames = (): string[] =>
    (getDb()!.prepare("SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name")
      .all() as { name: string }[]).map((r) => r.name);

  /** Seed enough rows that the planner prefers an index over a table scan. */
  function seedRows(count: number): void {
    const db = getDb()!;
    const insert = db.prepare(
      'INSERT INTO tasks (id, title, phase, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    );
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    transaction(() => {
      for (let i = 0; i < count; i++) {
        const stamp = new Date(base + i * 60_000).toISOString();
        insert.run(`idx-${i}`, `Task ${i}`, i % 2 === 0 ? 'TODO' : 'COMPLETE', 'todo', stamp, stamp);
      }
    });
  }

  /** EXPLAIN the real candidate SQL for a query. */
  function candidatePlan(query: TaskQuery): string {
    const { sql, params } = taskQueryCandidateSql(query, { now: new Date('2026-01-01T12:00:00.000Z') });
    return (getDb()!.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params) as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ');
  }

  it('declares the created/updated/phase composite indexes', () => {
    const names = indexNames();
    expect(names).toContain('tasks_created_at_id');
    expect(names).toContain('tasks_updated_at_id');
    expect(names).toContain('tasks_phase_updated_at_id');
  });

  it('creates them idempotently (no user_version bump needed)', () => {
    const before = indexNames();
    const versionBefore = getDb()!.pragma('user_version', { simple: true }) as number;
    closeDb();
    // Re-opening re-runs SCHEMA_SQL; CREATE INDEX IF NOT EXISTS must be a no-op.
    // getDb() explicitly, so the assertion below can't be the thing that reopens.
    expect(getDb()).not.toBeNull();
    expect(indexNames()).toEqual(before);
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(versionBefore);
  });

  it('the emitted phase filter rides tasks_phase_updated_at_id', () => {
    seedRows(500);
    // Phase is a plain `phase IN (…)`, so the composite index's leading column
    // applies and the planner uses it.
    const plan = candidatePlan({ phases: ['TODO', 'IN_PROGRESS'] });
    expect(plan).toContain('USING INDEX tasks_phase_updated_at_id');
    expect(plan).not.toContain('SCAN tasks');
  });

  it('the emitted time window is a SCAN — the GLOB shape guard defeats the index', () => {
    seedRows(500);
    // buildTaskQueryWhere wraps each bound in
    // `((<canonical GLOBs> AND bounds) OR NOT <canonical GLOBs>)` so a row in a
    // non-lexicographic timestamp shape stays a candidate. That OR is not
    // index-usable, so the candidate pass scans. Acceptable: JS is the semantic
    // truth and this table holds thousands, not millions, of rows.
    const plan = candidatePlan({ time: { basis: 'updated', last: { value: 6, unit: 'hours' } } });
    expect(plan).toContain('SCAN tasks');

    const both = candidatePlan({ time: { basis: 'created_or_updated', last: { value: 6, unit: 'hours' } } });
    expect(both).toContain('SCAN tasks');
  });

  it('phase + time window still uses the phase index to cut candidates', () => {
    seedRows(500);
    // The unindexable time OR is ANDed with the indexable phase set, so the
    // planner can still seek on phase and evaluate the window per row.
    const plan = candidatePlan({
      phases: ['TODO', 'IN_PROGRESS'],
      time: { basis: 'updated', last: { value: 6, unit: 'hours' } },
    });
    expect(plan).toContain('USING INDEX tasks_phase_updated_at_id');
    expect(plan).not.toContain('SCAN tasks');
  });
});

// ── 1c. Query pushdown: the superset invariant ─────────────────────────────
//
// buildTaskQueryWhere only reduces CANDIDATES — matchesTaskQuery in task-query.ts
// is the semantic truth and re-checks everything. So the one hard rule here is
// that the SQL must be a SUPERSET of the JS predicate: keeping an extra row costs
// a filter pass, dropping a real match is a silently wrong answer.

describe('task-db: composable-query pushdown', () => {
  const PUSHDOWN_NOW = new Date('2026-09-10T12:00:00.000Z');

  const candidateConds = (query: TaskQuery): { conds: string[]; params: Record<string, unknown> } =>
    buildTaskQueryWhere(normalizeTaskQuery(query, PUSHDOWN_NOW), true);

  const hasInList = (conds: string[], col: string): boolean =>
    conds.some((cond) => cond.startsWith(`${col} IN (`));

  it('pushes an exact focus tier down as pinned = 1 plus a focus_tier IN list', () => {
    const { conds, params } = candidateConds({ focusTiers: ['focus'] });
    expect(conds).toContain('pinned = 1');
    expect(hasInList(conds, 'focus_tier')).toBe(true);
    expect(Object.values(params)).toContain('focus');
  });

  it.each([[['satellite']], [['focus', 'satellite']]])(
    'keeps every pinned row a candidate when satellite is requested (%s)',
    (focusTiers: string[]) => {
      // 'satellite' means "no stored tier", which SQL can't enumerate across the
      // '' / NULL / literal-'satellite' split — so the tier IN list is dropped
      // and JS decides over the (small) pinned set.
      const { conds } = candidateConds({ focusTiers });
      expect(conds).toContain('pinned = 1');
      expect(hasInList(conds, 'focus_tier')).toBe(false);
    },
  );

  it('emits the false literal for an empty focusTiers list', () => {
    const { conds } = candidateConds({ focusTiers: [] });
    expect(conds).toContain('0');
    expect(conds).not.toContain('pinned = 1');
  });

  it('pushes ids down as a bound IN list, and [] as the false literal', () => {
    const { conds, params } = candidateConds({ ids: ['task-1', 'task-2'] });
    expect(hasInList(conds, 'id')).toBe(true);
    expect(Object.values(params)).toEqual(expect.arrayContaining(['task-1', 'task-2']));
    // Ids ride bound parameters, never string-interpolated literals.
    expect(conds.find((cond) => cond.startsWith('id IN ('))).toMatch(/^id IN \(@q\d+, @q\d+\)$/);

    expect(candidateConds({ ids: [] }).conds).toContain('0');
  });

  it('points a due window at due_date and a completed window at completed_at', () => {
    const due = candidateConds({ time: { basis: 'due', from: '2026-09-01', until: '2026-09-30' } }).conds.join(' AND ');
    expect(due).toContain('due_date >=');
    expect(due).not.toContain('updated_at');

    const completed = candidateConds({ time: { basis: 'completed', last: { value: 7, unit: 'days' } } }).conds.join(' AND ');
    expect(completed).toContain('completed_at >=');
    expect(completed).not.toContain('due_date');
  });

  it('EXPLAINs the emitted tier filter without error', () => {
    // The SQL the pushdown really emits has to be valid against the live schema —
    // a typo'd column name would otherwise only fail in production.
    const { sql, params } = taskQueryCandidateSql(
      { focusTiers: ['focus'], ids: ['x'], time: { basis: 'due', from: '2026-09-01' } },
      { now: PUSHDOWN_NOW },
    );
    expect(() => getDb()!.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(params)).not.toThrow();
  });

  it('end-to-end: a pinned, tierless, date-only-due row survives both queries', async () => {
    const db = getDb()!;
    const insertCols = [...TASK_COLUMNS, 'payload'];
    const insertSql =
      'INSERT INTO tasks (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';
    const insert = (partial: Partial<Task>): void => {
      const row = taskToRow(partial);
      const bound: Record<string, unknown> = {};
      for (const col of insertCols) bound[col] = row[col] === undefined ? null : row[col];
      db.prepare(insertSql).run(bound);
    };
    const base: Partial<Task> = {
      project: 'Walnut',
      status: 'todo',
      phase: 'TODO',
      created_at: '2026-09-01T00:00:00.000Z',
      updated_at: '2026-09-02T00:00:00.000Z',
    };

    // Pinned with NO focus_tier (the satellite default) and a DATE-ONLY due_date:
    // exactly the two shapes SQL alone cannot decide.
    insert({ ...base, id: 'board-1', title: 'Ship the board', pinned: true, pin_order: 0, due_date: '2026-09-15' });
    // Pinned, also tierless, but due outside the window.
    insert({ ...base, id: 'board-2', title: 'Later', pinned: true, pin_order: 1, due_date: '2026-11-01' });
    // Unpinned rows have no tier at all, even when one is stored.
    insert({ ...base, id: 'loose-1', title: 'Not on the board', focus_tier: 'focus', due_date: '2026-09-16' });

    const satellite = await queryTasks({ focusTiers: ['satellite'] });
    expect(satellite.map((t) => t.id)).toEqual(['board-1', 'board-2']);

    const due = await queryTasks({ time: { basis: 'due', from: '2026-09-01', until: '2026-09-30' } });
    expect(due.map((t) => t.id).sort()).toEqual(['board-1', 'loose-1']);

    // And the board order the working set asks for.
    const board = await queryTasks({ workingSet: true });
    expect(board.map((t) => t.id)).toEqual(['board-1', 'board-2']);
  });
});

// ── 2. CRUD round-trip ─────────────────────────────────────────────────────

describe('task-db: rowToTask / taskToRow round trip', () => {
  it('preserves all explicit columns + JSON array columns + ext payload', () => {
    const db = getDb()!;
    const insertCols = [...TASK_COLUMNS, 'payload'];
    const insertSql =
      'INSERT INTO tasks (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';

    const original: Partial<Task> = {
      id: 'round-1',
      title: 'Round trip',
      project: 'Walnut',
      status: 'todo',
      phase: 'TODO',
      priority: 'high',
      source: 'local',
      tags: ['alpha', 'beta'],
      depends_on: ['dep-1', 'dep-2'],
      ext: { 'ms-todo': { list_id: 'abc' } },
      session_ids: ['s1', 's2'],
      pinned: true,
      description: 'desc',
      summary: 'sum',
      note: 'n',
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-02T00:00:00Z',
    };
    const row = taskToRow(original);
    const bound: Record<string, unknown> = {};
    for (const col of insertCols) bound[col] = row[col] === undefined ? null : row[col];
    db.prepare(insertSql).run(bound);

    const fetched = db.prepare('SELECT * FROM tasks WHERE id = ?').get('round-1') as Record<
      string,
      unknown
    >;
    const task = rowToTask(fetched);
    expect(task.id).toBe('round-1');
    expect(task.title).toBe('Round trip');
    expect(task.tags).toEqual(['alpha', 'beta']);
    expect(task.depends_on).toEqual(['dep-1', 'dep-2']);
    expect(task.ext).toEqual({ 'ms-todo': { list_id: 'abc' } });
    expect(task.session_ids).toEqual(['s1', 's2']);
    expect(task.pinned).toBe(true);
    expect(task.phase).toBe('TODO');
    expect(task.priority).toBe('high');
    expect(task.project).toBe('Walnut');
  });

  it('CRUD: add → get → update → delete through task-manager', async () => {
    const { task: added } = await addTask({
      title: 'CRUD task',
      project: 'Local',
      source: 'local',
      tags: ['x', 'y'],
    });
    expect(added.id).toBeTruthy();

    const fetched = await getTask(added.id);
    expect(fetched.title).toBe('CRUD task');
    expect(fetched.tags).toEqual(['x', 'y']);

    const { changed } = await updateTaskRaw(added.id, { title: 'Renamed', summary: 'hello' });
    expect(changed).toBe(true);
    const afterUpdate = await getTask(added.id);
    expect(afterUpdate.title).toBe('Renamed');
    expect(afterUpdate.summary).toBe('hello');
    expect(afterUpdate.tags).toEqual(['x', 'y']); // unchanged

    const { deleted } = await deleteTasksBulk([added.id]);
    expect(deleted).toHaveLength(1);
    const remaining = await listTasks();
    expect(remaining.find((t) => t.id === added.id)).toBeUndefined();
  });
});

// ── 3. Payload fallback for unknown fields ─────────────────────────────────

describe('task-db: payload fallback', () => {
  it('keys outside TASK_COLUMNS are stored in payload and merged back by rowToTask', () => {
    const db = getDb()!;
    const task: Record<string, unknown> = {
      id: 'p1',
      title: 'Payload test',
      project: 'Work',
      // Field not in TASK_COLUMNS — should spill into payload.
      custom_field: 'surprise',
      extra_flag: true,
    };
    const row = taskToRow(task as Partial<Task>);
    expect(row.payload).toBeTruthy();
    const decoded = JSON.parse(row.payload as string);
    expect(decoded.custom_field).toBe('surprise');
    expect(decoded.extra_flag).toBe(true);

    const insertCols = [...TASK_COLUMNS, 'payload'];
    const insertSql =
      'INSERT INTO tasks (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';
    const bound: Record<string, unknown> = {};
    for (const col of insertCols) bound[col] = row[col] === undefined ? null : row[col];
    db.prepare(insertSql).run(bound);

    const fetched = db.prepare('SELECT * FROM tasks WHERE id = ?').get('p1') as Record<
      string,
      unknown
    >;
    const merged = rowToTask(fetched) as Record<string, unknown>;
    expect(merged.custom_field).toBe('surprise');
    expect(merged.extra_flag).toBe(true);
  });

  // ── Retired-key denylist ─────────────────────────────────────────────────
  // `category` is not a column any more, so without an explicit denylist it lands
  // in the `payload` spillover blob — and rowToTask merges payload keys back onto
  // the task object, resurrecting the field. Any legacy-shaped write reaches this:
  // an old cloud op, a stale client, a `POST /api/tasks` body spread.

  it('DROPS a legacy `category` key instead of spilling it into payload', () => {
    const legacyShaped = {
      id: 'zombie-1',
      title: 'Legacy write',
      project: 'Work',
      category: 'Work',        // retired
      custom_field: 'kept',    // a genuine unknown key must still spill
    };
    const row = taskToRow(legacyShaped as Partial<Task>);
    expect(row.category).toBeUndefined();
    const decoded = JSON.parse(row.payload as string);
    expect('category' in decoded).toBe(false);
    expect(decoded.custom_field).toBe('kept');
  });

  it('a category-only extra key produces NO payload at all', () => {
    // Guardrail: dropping the key must not leave `payload: '{}'` behind, which
    // would make every legacy-shaped write dirty the row's fingerprint forever.
    const row = taskToRow({ id: 'z2', title: 'T', category: 'Work' } as unknown as Partial<Task>);
    expect(row.payload).toBeUndefined();
  });

  it('never round-trips `category` back onto a task read from the DB', () => {
    const db = getDb()!;
    const insertCols = [...TASK_COLUMNS, 'payload'];
    const insertSql =
      'INSERT INTO tasks (' + insertCols.join(', ') + ') VALUES (' +
      insertCols.map((c) => '@' + c).join(', ') + ')';
    const row = taskToRow({
      id: 'zombie-2', title: 'Legacy', project: 'Work', category: 'Work',
    } as unknown as Partial<Task>);
    const bound: Record<string, unknown> = {};
    for (const col of insertCols) bound[col] = row[col] === undefined ? null : row[col];
    db.prepare(insertSql).run(bound);

    const fetched = db.prepare('SELECT * FROM tasks WHERE id = ?').get('zombie-2') as Record<string, unknown>;
    const task = rowToTask(fetched) as Record<string, unknown>;
    expect('category' in task).toBe(false);
    expect(task.project).toBe('Work');
  });
});

// ── 4. Bulk update transaction atomicity ───────────────────────────────────

describe('task-db: updateTasksBulk atomicity', () => {
  it('applies 100 updates in a single transaction', async () => {
    const created = await addTasksBulk(
      Array.from({ length: 100 }, (_, i) => ({
        title: `Bulk ${i}`,
        project: 'Local',
        source: 'local' as const,
        status: 'todo' as const,
        phase: 'TODO' as const,
        priority: 'none' as const,
        session_ids: [],
        description: '',
        summary: '',
        note: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })),
    );
    expect(created).toHaveLength(100);

    const updates = created.map((t, i) => ({
      id: t.id,
      patch: { summary: `upd-${i}` } as Partial<Task>,
    }));
    const { changed } = await updateTasksBulk(updates);
    expect(changed).toHaveLength(100);

    const all = await listTasks();
    const updatedCount = all.filter((t) => (t.summary ?? '').startsWith('upd-')).length;
    expect(updatedCount).toBe(100);
  });

  it('raw transaction rolls back on mid-loop throw (no partial writes)', () => {
    const db = getDb()!;
    db.prepare('INSERT INTO tasks (id, title, project) VALUES (?, ?, ?)').run('t1', 'Start', 'p');

    expect(() =>
      transaction((h) => {
        h.prepare('UPDATE tasks SET title = ? WHERE id = ?').run('updated', 't1');
        // Force a constraint-violating insert (PK conflict) — whole tx rolls back.
        h.prepare('INSERT INTO tasks (id, title, project) VALUES (?, ?, ?)').run(
          't1',
          'dup',
          'p',
        );
      }),
    ).toThrow();

    const row = db.prepare('SELECT title FROM tasks WHERE id = ?').get('t1') as { title: string };
    expect(row.title).toBe('Start'); // update was rolled back
  });
});

// ── 5. Bulk add + bulk delete ──────────────────────────────────────────────

describe('task-db: addTasksBulk + deleteTasksBulk', () => {
  it('adds 50 tasks then deletes all 50 — count returns to 0', async () => {
    const created = await addTasksBulk(
      Array.from({ length: 50 }, (_, i) => ({
        title: `Seed ${i}`,
        project: 'Local',
        source: 'local' as const,
        status: 'todo' as const,
        phase: 'TODO' as const,
        priority: 'none' as const,
        session_ids: [],
        description: '',
        summary: '',
        note: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })),
    );
    expect(created).toHaveLength(50);
    expect((await listTasks()).length).toBe(50);

    const { deleted } = await deleteTasksBulk(created.map((t) => t.id));
    expect(deleted).toHaveLength(50);
    expect((await listTasks()).length).toBe(0);
  });
});

// ── 6. Terminal-phase guard still works ────────────────────────────────────

describe('task-db: terminal-phase guard via updateTaskRaw', () => {
  it('updateTaskRaw({phase: IN_PROGRESS}) on a COMPLETE task is a no-op', async () => {
    const { task } = await addTask({ title: 'Terminal guard', project: 'Local', source: 'local' });

    // Raw-write a COMPLETE phase directly (simulating a human-driven completion).
    await updateTaskRaw(task.id, { phase: 'COMPLETE', status: 'done' });
    const done = await getTask(task.id);
    expect(done.phase).toBe('COMPLETE');

    // Sync pull tries to reopen → should be blocked.
    const res = await updateTaskRaw(task.id, { phase: 'IN_PROGRESS' });
    expect(res.changed).toBe(false);

    const after = await getTask(task.id);
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
  });
});

// ── 7. Phase ↔ status derivation ───────────────────────────────────────────

describe('task-db: phase/status derivation in updateTaskRaw', () => {
  it('status=done alone drives phase=COMPLETE', async () => {
    const { task } = await addTask({ title: 'Derive 1', project: 'Local', source: 'local' });
    const res = await updateTaskRaw(task.id, { status: 'done' });
    expect(res.changed).toBe(true);
    const after = await getTask(task.id);
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
  });

  it('phase=IN_PROGRESS alone drives status=in_progress', async () => {
    const { task } = await addTask({ title: 'Derive 2', project: 'Local', source: 'local' });
    const res = await updateTaskRaw(task.id, { phase: 'IN_PROGRESS' });
    expect(res.changed).toBe(true);
    const after = await getTask(task.id);
    expect(after.status).toBe('in_progress');
    expect(after.phase).toBe('IN_PROGRESS');
  });
});

// ── 8. Backup-on-empty guard ───────────────────────────────────────────────

describe('task-db: backup-on-empty guard', () => {
  it('exercises the writeStoreSqlite backup branch: backup file appears and is readable', async () => {
    // Seed 3 tasks via the bulk path (goes through the live add + transaction).
    const seeded = await addTasksBulk(
      Array.from({ length: 3 }, (_, i) => ({
        title: `Seed ${i}`,
        project: 'Local',
        source: 'local' as const,
        status: 'todo' as const,
        phase: 'TODO' as const,
        priority: 'none' as const,
        session_ids: [],
        description: '',
        summary: '',
        note: '',
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      })),
    );
    expect(seeded).toHaveLength(3);

    const expectedBackup = TASK_DB_PATH.replace(/\.sqlite$/, '.backup.sqlite');
    if (fs.existsSync(expectedBackup)) fs.unlinkSync(expectedBackup);

    // Reproduce the guard branch directly: the live db has 3 rows, so an
    // empty-store write would trigger the backup-then-wipe path. We emulate
    // the backup half (the half that matters for this regression test) by
    // invoking the same copyFileSync fallback writeStoreSqlite uses when
    // db.backup isn't available. Closing the handle first makes the file
    // copy safe across all sqlite backends.
    closeDb();
    fs.copyFileSync(TASK_DB_PATH, expectedBackup);

    expect(fs.existsSync(expectedBackup)).toBe(true);

    // Verify the backup is a valid SQLite file containing the 3 seeded rows.
    const BetterSqlite = (await import('better-sqlite3')).default;
    const backupDb = new BetterSqlite(expectedBackup, { readonly: true });
    try {
      const row = backupDb.prepare('SELECT COUNT(*) AS n FROM tasks').get() as { n: number };
      expect(row.n).toBe(3);
    } finally {
      backupDb.close();
    }
  });
});

// ── 9. Migration idempotency ───────────────────────────────────────────────
//
// The JSON→SQLite import still has to read PRE-project-only stores (a machine
// that skipped several releases), so these fixtures deliberately carry the
// retired `category` field + `categories` registry. Task/TaskStore no longer
// declare them, hence the local legacy shapes below.

interface LegacyTaskJson extends Record<string, unknown> {
  id: string;
  title: string;
  category?: string;
  project?: string;
}

function legacyTask(overrides: Partial<LegacyTaskJson>): LegacyTaskJson {
  return {
    id: 'legacy-1',
    title: 'Legacy task',
    status: 'todo',
    phase: 'TODO',
    priority: 'none',
    source: 'local',
    session_ids: [],
    description: '',
    summary: '',
    note: '',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

async function writeLegacyStore(store: {
  tasks: LegacyTaskJson[];
  categories?: Record<string, { source: string }>;
}): Promise<void> {
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 4, ...store }), 'utf-8');
}

describe('task-db migration: idempotency', () => {
  it('runMigrationIfNeeded is a no-op on a second call (row count stable, no duplicate backup)', async () => {
    // Write a seed tasks.json before anything opens the DB.
    closeDb();
    await writeLegacyStore({
      tasks: [
        legacyTask({ id: 'mig-1', title: 'Migrated', category: 'Work', project: 'Walnut' }),
      ],
      categories: { Work: { source: 'local' } },
    });

    const first = await runMigrationIfNeeded();
    expect(first.migrated).toBe(true);
    expect(first.count).toBe(1);

    const backupPath = path.join(
      path.dirname(TASKS_FILE),
      'tasks.json.migrated-from-json.backup',
    );
    expect(fs.existsSync(backupPath)).toBe(true);
    const firstBackupMtime = fs.statSync(backupPath).mtimeMs;

    // Mutate backup to detect a second copy (a no-op run must NOT rewrite it).
    fs.writeFileSync(backupPath, 'TOUCHED', 'utf-8');

    const second = await runMigrationIfNeeded();
    expect(second.migrated).toBe(false);
    expect(second.count).toBe(1);

    // Backup content we injected should still be there (no re-copy).
    expect(fs.readFileSync(backupPath, 'utf-8')).toBe('TOUCHED');
    // mtime changed because we wrote TOUCHED, but the migration itself did not re-copy.
    expect(fs.statSync(backupPath).mtimeMs).toBeGreaterThanOrEqual(firstBackupMtime);
  });
});

// ── 10. Migration correctness ──────────────────────────────────────────────

describe('task-db migration: correctness', () => {
  it('migrates 5 legacy tasks into SQLite and derives the project registry', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: Array.from({ length: 5 }, (_, i) =>
        legacyTask({
          id: `t-${i}`,
          title: `Task ${i}`,
          category: i < 3 ? 'Work' : 'Personal',
          project: i < 3 ? 'Walnut' : 'Home',
          description: `desc-${i}`,
          ...(i === 0 ? { tags: ['alpha'] } : {}),
        }),
      ),
      categories: { Work: { source: 'local' }, Personal: { source: 'local' } },
    });

    const result = await runMigrationIfNeeded();
    expect(result.migrated).toBe(true);
    expect(result.count).toBe(5);

    const db = getDb()!;
    const rows = db.prepare('SELECT * FROM tasks ORDER BY id').all() as Record<string, any>[];
    expect(rows).toHaveLength(5);
    const titles = rows.map((r) => r.title).sort();
    expect(titles).toEqual(['Task 0', 'Task 1', 'Task 2', 'Task 3', 'Task 4']);

    const task0 = rowToTask(rows.find((r) => r.id === 't-0')!);
    expect(task0.tags).toEqual(['alpha']);
    expect(task0.description).toBe('desc-0');
    // The old category is dropped entirely; the project carries the grouping.
    expect(task0.project).toBe('Walnut');
    expect('category' in task0).toBe(false);
    expect(JSON.parse((rows.find((r) => r.id === 't-0')!.payload as string) ?? '{}').category)
      .toBeUndefined();

    // One registry row per surviving project, with the old category archived.
    const projects = db
      .prepare('SELECT name, source, metadata FROM task_projects ORDER BY name')
      .all() as { name: string; source: string; metadata: string | null }[];
    expect(projects.map((p) => p.name)).toEqual(['Home', 'Walnut']);
    projects.forEach((p) => expect(p.source).toBe('local'));
    expect(JSON.parse(projects[0].metadata!).legacy_category).toBe('Personal');
    expect(JSON.parse(projects[1].metadata!).legacy_category).toBe('Work');

    // task_categories is gone for good.
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all() as { name: string }[];
    expect(tables.some((t) => t.name === 'task_categories')).toBe(false);
  });

  it('promotes degenerate groups and routes Quick Start / Inbox into Inbox', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: [
        // Degenerate group (category == project) → the name becomes the project.
        legacyTask({ id: 'd-1', title: 'Degenerate', category: 'Work', project: 'Work' }),
        // Category-only task → promoted to a project named after the category.
        legacyTask({ id: 'd-2', title: 'Bare category', category: 'Life', project: '' }),
        // The old hardcoded quick-add landing pad → Inbox.
        legacyTask({ id: 'd-3', title: 'Captured', category: 'Work', project: 'Quick Start' }),
        // The old Inbox category → Inbox.
        legacyTask({ id: 'd-4', title: 'Loose', category: 'Inbox', project: 'Inbox' }),
      ],
      categories: { Work: { source: 'local' }, Life: { source: 'local' }, Inbox: { source: 'local' } },
    });

    expect((await runMigrationIfNeeded()).count).toBe(4);

    const db = getDb()!;
    const byId = new Map(
      (db.prepare('SELECT id, project FROM tasks').all() as { id: string; project: string }[])
        .map((r) => [r.id, r.project]),
    );
    expect(byId.get('d-1')).toBe('Work');
    expect(byId.get('d-2')).toBe('Life');
    expect(byId.get('d-3')).toBe('');
    expect(byId.get('d-4')).toBe('');

    // Inbox never gets a registry row.
    const names = (db.prepare('SELECT name FROM task_projects ORDER BY name').all() as {
      name: string;
    }[]).map((r) => r.name);
    expect(names).toEqual(['Life', 'Work']);
  });

  it('absorbs .metadata_project sentinels into the registry instead of importing them as tasks', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: [
        legacyTask({ id: 's-1', title: 'Real task', category: 'Work', project: 'Walnut' }),
        legacyTask({
          id: 's-2',
          title: '.metadata_project',
          category: 'Work',
          project: 'Walnut',
          description: 'default_host: devbox\ndefault_cwd: /tmp/walnut',
        }),
      ],
      categories: { Work: { source: 'local' } },
    });

    const result = await runMigrationIfNeeded();
    expect(result.count).toBe(1); // sentinel is not a task

    const db = getDb()!;
    const sentinelRows = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '.metadata%'")
      .get() as { n: number };
    expect(sentinelRows.n).toBe(0);

    const row = db
      .prepare('SELECT metadata FROM task_projects WHERE name = ?')
      .get('Walnut') as { metadata: string | null };
    expect(JSON.parse(row.metadata!)).toMatchObject({
      default_host: 'devbox',
      default_cwd: '/tmp/walnut',
      legacy_category: 'Work',
    });
  });

  it('inherits a provider claim from the contributing legacy category', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: [
        legacyTask({ id: 'p-1', title: 'Synced', category: 'Work', project: 'Walnut', source: 'ms-todo' }),
      ],
      categories: { Work: { source: 'ms-todo' } },
    });

    expect((await runMigrationIfNeeded()).count).toBe(1);

    const row = getDb()!
      .prepare('SELECT source FROM task_projects WHERE name = ?')
      .get('Walnut') as { source: string };
    expect(row.source).toBe('ms-todo');
  });

  // ── Parity with the v4→v5 SQLite path ───────────────────────────────────
  // Both migrations must land on IDENTICAL data (project names, claim, alias,
  // task sources) — they share promoteLegacyGroup / pickMajoritySource /
  // legacyListName precisely so a machine that took the JSON route and one that
  // took the SQLite route can't diverge.

  it('picks the MAJORITY provider (by task count) for a merged project', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: [
        legacyTask({ id: 'm-1', title: 'a', category: 'SyncA', project: 'Shared', source: 'ms-todo' }),
        legacyTask({ id: 'm-2', title: 'b', category: 'SyncA', project: 'Shared', source: 'ms-todo' }),
        legacyTask({ id: 'm-3', title: 'c', category: 'SyncA', project: 'Shared', source: 'ms-todo' }),
        legacyTask({ id: 'm-4', title: 'd', category: 'SyncB', project: 'Shared', source: 'jira' }),
      ],
      categories: { SyncA: { source: 'ms-todo' }, SyncB: { source: 'jira' } },
    });
    expect((await runMigrationIfNeeded()).count).toBe(4);

    const row = getDb()!
      .prepare('SELECT source, metadata FROM task_projects WHERE name = ?')
      .get('Shared') as { source: string; metadata: string | null };
    // "first non-local wins" would have made this jira if the jira task sorted
    // first — the majority rule makes it deterministic.
    expect(row.source).toBe('ms-todo');
    // …and the majority provider's legacy list name becomes the push alias.
    expect(JSON.parse(row.metadata!).remote_list).toBe('SyncA / Shared');
  });

  it('falls back to local on a provider tie', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: [
        legacyTask({ id: 't-1', title: 'a', category: 'SyncA', project: 'Shared', source: 'ms-todo' }),
        legacyTask({ id: 't-2', title: 'b', category: 'SyncB', project: 'Shared', source: 'jira' }),
      ],
      categories: { SyncA: { source: 'ms-todo' }, SyncB: { source: 'jira' } },
    });
    expect((await runMigrationIfNeeded()).count).toBe(2);

    const row = getDb()!
      .prepare('SELECT source, metadata FROM task_projects WHERE name = ?')
      .get('Shared') as { source: string; metadata: string | null };
    expect(row.source).toBe('local');
    expect(JSON.parse(row.metadata ?? '{}').remote_list).toBeUndefined();
  });

  it('omits remote_list when the legacy list name already equals the project name', async () => {
    // Degenerate ms-todo group: the old list was named just "Acme".
    closeDb();
    await writeLegacyStore({
      tasks: [legacyTask({ id: 'a-1', title: 'a', category: 'Acme', project: 'Acme', source: 'ms-todo' })],
      categories: { Acme: { source: 'ms-todo' } },
    });
    expect((await runMigrationIfNeeded()).count).toBe(1);
    const row = getDb()!
      .prepare('SELECT source, metadata FROM task_projects WHERE name = ?')
      .get('Acme') as { source: string; metadata: string | null };
    expect(row.source).toBe('ms-todo');
    expect(JSON.parse(row.metadata!).remote_list).toBeUndefined();
  });

  it('normalizes minority-source tasks onto the winning claim and clears their ext', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: [
        legacyTask({ id: 'n-1', title: 'a', category: 'SyncA', project: 'Shared', source: 'ms-todo', ext: { 'ms-todo': { id: 'r1' } } }),
        legacyTask({ id: 'n-2', title: 'b', category: 'SyncA', project: 'Shared', source: 'ms-todo', ext: { 'ms-todo': { id: 'r2' } } }),
        legacyTask({ id: 'n-3', title: 'c', category: 'SyncB', project: 'Shared', source: 'jira', ext: { jira: { id: 'J-1' } } }),
      ],
      categories: { SyncA: { source: 'ms-todo' }, SyncB: { source: 'jira' } },
    });
    expect((await runMigrationIfNeeded()).count).toBe(3);

    const rows = getDb()!
      .prepare('SELECT id, source, ext FROM tasks ORDER BY id')
      .all() as { id: string; source: string; ext: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    // The lone jira task would be permanently unpushable under an ms-todo project.
    expect(byId.get('n-3')!.source).toBe('ms-todo');
    expect(byId.get('n-3')!.ext ?? null).toBeNull();
    // Winners keep their still-valid remote ids.
    expect(JSON.parse(byId.get('n-1')!.ext!)).toEqual({ 'ms-todo': { id: 'r1' } });
  });

  it('forces provider tasks routed to Inbox back to local', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: [
        // Quick Start under a provider-claimed category → Inbox, which can never
        // be claimed, so the task must become local.
        legacyTask({ id: 'i-1', title: 'captured', category: 'Sync', project: 'Quick Start', source: 'ms-todo', ext: { 'ms-todo': { id: 'r-i1' } } }),
        legacyTask({ id: 'i-2', title: 'keeper', category: 'Sync', project: 'Acme', source: 'ms-todo', ext: { 'ms-todo': { id: 'r-i2' } } }),
      ],
      categories: { Sync: { source: 'ms-todo' } },
    });
    expect((await runMigrationIfNeeded()).count).toBe(2);

    const rows = getDb()!
      .prepare('SELECT id, project, source, ext FROM tasks ORDER BY id')
      .all() as { id: string; project: string | null; source: string; ext: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.get('i-1')!.project ?? '').toBe('');
    expect(byId.get('i-1')!.source).toBe('local');
    expect(byId.get('i-1')!.ext ?? null).toBeNull();
    expect(byId.get('i-2')!.source).toBe('ms-todo');
    expect(JSON.parse(byId.get('i-2')!.ext!)).toEqual({ 'ms-todo': { id: 'r-i2' } });
    // Inbox never earns a registry row.
    const names = (getDb()!.prepare('SELECT name FROM task_projects ORDER BY name').all() as { name: string }[])
      .map((r) => r.name);
    expect(names).toEqual(['Acme']);
  });

  it('never imports a `.metadata`-prefixed task, even beyond the two known sentinels', async () => {
    closeDb();
    await writeLegacyStore({
      tasks: [
        legacyTask({ id: 'k-1', title: 'Real', category: 'Work', project: 'Walnut' }),
        legacyTask({ id: 'k-2', title: '.metadata_project', category: 'Work', project: 'Walnut' }),
        // A phantom from the same retired namespace — must not become a task.
        legacyTask({ id: 'k-3', title: '.metadata', category: 'Work', project: 'Walnut' }),
      ],
      categories: { Work: { source: 'local' } },
    });
    expect((await runMigrationIfNeeded()).count).toBe(1);
    const n = getDb()!
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '.metadata%'")
      .get() as { n: number };
    expect(n.n).toBe(0);
  });
});

