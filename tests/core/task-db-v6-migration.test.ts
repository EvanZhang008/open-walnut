/**
 * Tests for the v5 → v6 SQLite migration: the read marker rename
 * `needs_attention` → `unread`.
 *
 * The marker never had a dedicated column — it lives inside the `payload` JSON
 * blob — so the migration is JSON surgery on `payload`, not an ALTER TABLE. Each
 * test builds a REAL v5 database with raw SQL, then opens it through `getDb()` so
 * the production migration path runs verbatim.
 *
 * Would these fail on reverted code? YES. Drop `migrateReadMarkerToUnread` and a
 * pre-rename task keeps only `needs_attention`, which no reader looks at anymore —
 * `rowToTask` returns `unread: undefined`, so every task the agent had handed back
 * silently loses its dot on upgrade.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-db-v6'));

import { getDb, closeDb, rowToTask, taskToRow, TASK_DB_PATH, SCHEMA_VERSION } from '../../src/core/task-db.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';

/** The tasks schema as shipped at SCHEMA_VERSION = 5 (project-only, no category). */
const V5_SCHEMA_SQL = `
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
  CREATE TABLE task_groups (id TEXT PRIMARY KEY, label TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE custom_tiers (id TEXT PRIMARY KEY, label TEXT NOT NULL, order_index INTEGER);
`;

/** Build a v5 DB whose tasks carry the given raw `payload` blobs. */
function buildV5Db(rows: { id: string; payload: string | null; updated_at?: string }[]): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const db = new Database(TASK_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(V5_SCHEMA_SQL);
  const insert = db.prepare(
    `INSERT INTO tasks (id, title, project, status, phase, priority, source, updated_at, payload)
     VALUES (@id, @id, '', 'todo', 'AGENT_COMPLETE', 'none', 'local', @updated_at, @payload)`,
  );
  for (const r of rows) {
    insert.run({ id: r.id, payload: r.payload, updated_at: r.updated_at ?? '2026-01-01T00:00:00.000Z' });
  }
  db.pragma('user_version = 5');
  db.close();
}

/** Read a task back through the production row→Task chokepoint. */
function readTask(id: string): Record<string, unknown> {
  const row = getDb()!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, any>;
  return rowToTask(row) as unknown as Record<string, unknown>;
}

/** Raw payload blob, to assert the retired key is physically gone. */
function rawPayload(id: string): string | null {
  const row = getDb()!.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as { payload: string | null };
  return row.payload;
}

describe('task-db v5 → v6 migration: needs_attention → unread', () => {
  beforeEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  afterEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('carries a legacy `true` forward and deletes the retired key', () => {
    buildV5Db([{ id: 'legacy-marked', payload: JSON.stringify({ needs_attention: true, group_id: 'g1' }) }]);

    const task = readTask('legacy-marked');
    expect(task.unread).toBe(true);
    // Untouched payload neighbours survive the JSON surgery.
    expect(task.group_id).toBe('g1');
    expect(rawPayload('legacy-marked')).not.toContain('needs_attention');
  });

  it('drops a legacy `false` rather than copying it (absent means read)', () => {
    buildV5Db([{ id: 'legacy-read', payload: JSON.stringify({ needs_attention: false, group_id: 'g2' }) }]);

    const task = readTask('legacy-read');
    // Not `false` — the whole point of naming the field `unread` is that absent
    // already means read, so persisting an explicit false would be pure noise.
    expect(task.unread).toBeUndefined();
    expect(task.group_id).toBe('g2');
    expect(rawPayload('legacy-read')).not.toContain('needs_attention');
  });

  it('lets an already-canonical value win over a stale legacy one', () => {
    // A row written after the rename but before this migration: the user opened
    // the task (unread → false) while a stale legacy `true` still sat beside it.
    // The canonical value is the truth; the legacy one must not resurrect the dot.
    buildV5Db([{ id: 'both-keys', payload: JSON.stringify({ needs_attention: true, unread: false }) }]);

    const task = readTask('both-keys');
    expect(task.unread).toBe(false);
    expect(rawPayload('both-keys')).not.toContain('needs_attention');
  });

  it('does not bump updated_at — the marker is viewer state, not content', () => {
    buildV5Db([
      { id: 'stamped', payload: JSON.stringify({ needs_attention: true }), updated_at: '2026-01-02T03:04:05.000Z' },
    ]);

    const task = readTask('stamped');
    expect(task.unread).toBe(true);
    // Bumping it would reshuffle every updated_at-sorted list on upgrade.
    expect(task.updated_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('leaves rows without the marker (and NULL payloads) alone', () => {
    buildV5Db([
      { id: 'no-marker', payload: JSON.stringify({ group_id: 'g3' }) },
      { id: 'null-payload', payload: null },
      { id: 'corrupt-payload', payload: '{not json' },
    ]);

    expect(readTask('no-marker').unread).toBeUndefined();
    expect(readTask('no-marker').group_id).toBe('g3');
    expect(readTask('null-payload').unread).toBeUndefined();
    // A corrupt blob is skipped by the json_valid() guard, not thrown on.
    expect(readTask('corrupt-payload').unread).toBeUndefined();
    expect(rawPayload('corrupt-payload')).toBe('{not json');
  });

  it('marks the DB current and is a no-op on the second open', () => {
    buildV5Db([{ id: 'once', payload: JSON.stringify({ needs_attention: true }) }]);

    expect(readTask('once').unread).toBe(true);
    // SCHEMA_VERSION, not a literal — later migrations (v7 collapsed the phase
    // lifecycle) run in the same open and carry the version past 6.
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    closeDb();
    // Second open: the version gate short-circuits, and the value stays put.
    expect(readTask('once').unread).toBe(true);
  });

  it('refuses to let a legacy-shaped WRITE resurrect the retired key', () => {
    // RETIRED_TASK_KEYS: an old cloud op or stale client spreading
    // `needs_attention` into a patch must not re-create a second read marker
    // beside the real one (the same guard that keeps `category` dead).
    const row = taskToRow({ id: 'x', unread: true, needs_attention: true } as never);
    expect(row.payload).toContain('unread');
    expect(row.payload).not.toContain('needs_attention');
  });
});
