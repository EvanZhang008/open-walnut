/**
 * v12 → v13: the Backlog pin tier is retired; its rows move to Parked (`wait`).
 *
 * The board keeps three built-in tiers (Focus, Satellite, Parked). A row filed
 * in Backlog keeps its pin and its pin order and reads as `wait`, in the column
 * and in the payload copy. Nothing else on the row moves: `updated_at` stays, so
 * no sync plugin sees a change and the row does not float in Recent.
 *
 * Would these fail on reverted code? YES. Without the branch a Backlog row keeps
 * `focus_tier: 'backlog'`, which no reader buckets any more: the task would be
 * pinned yet drawn in no tier.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-db-v13'));

import { getDb, closeDb, rowToTask, taskToRow, TASK_DB_PATH, SCHEMA_VERSION } from '../../src/core/task-db.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';

const V12_SCHEMA_SQL = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project TEXT,
    status TEXT,
    phase TEXT,
    priority TEXT,
    source TEXT,
    parent_task_id TEXT,
    due_date TEXT,
    start_date TEXT,
    created_at TEXT,
    updated_at TEXT,
    completed_at TEXT,
    sprint TEXT,
    focus_tier TEXT,
    pinned INTEGER DEFAULT 0,
    ext TEXT,
    tags TEXT,
    depends_on TEXT,
    session_ids TEXT,
    note TEXT,
    summary TEXT,
    description TEXT,
    conversation_log TEXT,
    sync_error TEXT,
    _synced_at TEXT,
    payload TEXT
  );
  CREATE INDEX tasks_status ON tasks(status);
  CREATE TABLE task_projects (
    name TEXT PRIMARY KEY COLLATE NOCASE,
    source TEXT NOT NULL,
    order_index INTEGER,
    metadata TEXT
  );
  CREATE TABLE task_groups (
    id TEXT PRIMARY KEY, label TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0,
    project TEXT NOT NULL DEFAULT '', parent_id TEXT
  );
  CREATE TABLE custom_tiers (id TEXT PRIMARY KEY, label TEXT NOT NULL, order_index INTEGER);
`;

const UPDATED_AT = '2026-09-20T00:00:00.000Z';

interface Row { id: string; focus_tier?: string | null; pinned?: boolean; pin_order?: number; payload?: Record<string, unknown> }

function buildV12Db(rows: Row[]): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const db = new Database(TASK_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(V12_SCHEMA_SQL);
  const insert = db.prepare(
    `INSERT INTO tasks (id, title, project, status, phase, priority, source, updated_at, focus_tier, pinned, payload)
     VALUES (@id, @id, '', 'todo', 'TODO', 'none', 'local', @updated_at, @focus_tier, @pinned, @payload)`,
  );
  for (const r of rows) {
    insert.run({
      id: r.id,
      updated_at: UPDATED_AT,
      focus_tier: r.focus_tier ?? null,
      pinned: r.pinned === false ? 0 : 1,
      payload: JSON.stringify({ id: r.id, title: r.id, pin_order: r.pin_order ?? 0, ...(r.payload ?? {}) }),
    });
  }
  db.pragma('user_version = 12');
  db.close();
}

function rawRow(id: string): { focus_tier: string | null; updated_at: string; pinned: number; payload: string } {
  return getDb()!.prepare('SELECT focus_tier, updated_at, pinned, payload FROM tasks WHERE id = ?').get(id) as never;
}

function readTask(id: string): Record<string, unknown> {
  const row = getDb()!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, never>;
  return rowToTask(row) as unknown as Record<string, unknown>;
}

describe('task-db v12 → v13: the Backlog tier moves to Parked', () => {
  beforeEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  afterEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('a Backlog row becomes a Parked row, keeping its pin, its order and its updated_at', () => {
    buildV12Db([
      { id: 'someday', focus_tier: 'backlog', pin_order: 7 },
      // A row from before focus_tier had a column: the tier sits in the payload only.
      { id: 'payload-only', focus_tier: null, payload: { focus_tier: 'backlog' } },
    ]);

    const someday = rawRow('someday');
    expect(someday.focus_tier).toBe('wait');
    expect(someday.pinned).toBe(1);
    expect(someday.updated_at).toBe(UPDATED_AT);
    expect(JSON.parse(someday.payload).pin_order).toBe(7);
    expect(readTask('someday').focus_tier).toBe('wait');
    expect(readTask('someday').pin_order).toBe(7);

    expect(JSON.parse(rawRow('payload-only').payload).focus_tier).toBe('wait');
    expect(readTask('payload-only').focus_tier).toBe('wait');
  });

  it('every other tier is untouched, and the DB is stamped current', () => {
    buildV12Db([
      { id: 'in-focus', focus_tier: 'focus' },
      { id: 'in-satellite', focus_tier: null },
      { id: 'in-wait', focus_tier: 'wait' },
      { id: 'in-custom', focus_tier: 'ct_abcd1234' },
      { id: 'off-board', focus_tier: null, pinned: false },
      { id: 'someday', focus_tier: 'backlog' },
    ]);

    expect(rawRow('someday').focus_tier).toBe('wait'); // forces the migration to run
    expect(rawRow('in-focus').focus_tier).toBe('focus');
    expect(rawRow('in-satellite').focus_tier).toBeNull();
    expect(rawRow('in-wait').focus_tier).toBe('wait');
    expect(rawRow('in-custom').focus_tier).toBe('ct_abcd1234');
    expect(rawRow('off-board').pinned).toBe(0);
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('a row that arrives with the retired name after the rewrite is folded on read and on write', () => {
    buildV12Db([{ id: 'anchor', focus_tier: 'focus' }]);
    getDb(); // open + migrate first, so the rows below are "after"

    // Read side: a projection from an older replica, a plugin pull, a hand edit.
    expect(rowToTask({ id: 'late', title: 'late', focus_tier: 'backlog', pinned: 1 }).focus_tier).toBe('wait');
    expect(rowToTask({ id: 'late-payload', title: 'late', payload: JSON.stringify({ focus_tier: 'backlog' }) }).focus_tier).toBe('wait');

    // Write side: an older phone build or a session prompt that still names it.
    expect(taskToRow({ focus_tier: 'backlog' }).focus_tier).toBe('wait');
    expect(taskToRow({ focus_tier: 'focus' }).focus_tier).toBe('focus');
    expect(taskToRow({ focus_tier: 'ct_abcd1234' }).focus_tier).toBe('ct_abcd1234');
  });
});
