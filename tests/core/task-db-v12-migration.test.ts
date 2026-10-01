/**
 * v11 → v12: the pre-release `waiting` record becomes the WAITING phase.
 *
 * Before 0.5.2 a task "snoozed until something happens" stayed TODO and carried
 * `payload.waiting = { condition, routine_id, since, until?, woke_at?, woke_reason? }`.
 * The phase machine read that record to decide whether a finished turn handed the
 * task back. WAITING is now a phase of its own, so a LIVE record (no `woke_at`, task
 * not complete) becomes `phase: 'WAITING'` with `wait_until` taken from its backstop,
 * and every record, live or settled, is removed: the field is never written again.
 *
 * Would these fail on reverted code? YES. Without the branch a parked task reopens
 * as a plain TODO (its wait silently ends) and the retired record rides along in
 * the payload forever.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-db-v12'));

import { getDb, closeDb, rowToTask, TASK_DB_PATH, SCHEMA_VERSION } from '../../src/core/task-db.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';

const V11_SCHEMA_SQL = `
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

interface Row { id: string; phase: string; status?: string; payload?: Record<string, unknown> }

function buildV11Db(rows: Row[]): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const db = new Database(TASK_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(V11_SCHEMA_SQL);
  const insert = db.prepare(
    `INSERT INTO tasks (id, title, project, status, phase, priority, source, updated_at, payload)
     VALUES (@id, @id, '', @status, @phase, 'none', 'local', '2026-09-20T00:00:00.000Z', @payload)`,
  );
  for (const r of rows) {
    insert.run({
      id: r.id,
      phase: r.phase,
      status: r.status ?? (r.phase === 'COMPLETE' ? 'done' : r.phase === 'TODO' ? 'todo' : 'in_progress'),
      payload: JSON.stringify({ id: r.id, title: r.id, phase: r.phase, ...(r.payload ?? {}) }),
    });
  }
  db.pragma('user_version = 11');
  db.close();
}

function rawPhase(id: string): string {
  return (getDb()!.prepare('SELECT phase FROM tasks WHERE id = ?').get(id) as { phase: string }).phase;
}

function rawPayload(id: string): Record<string, unknown> {
  const row = getDb()!.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as { payload: string };
  return JSON.parse(row.payload) as Record<string, unknown>;
}

function readTask(id: string): Record<string, unknown> {
  const row = getDb()!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, never>;
  return rowToTask(row) as unknown as Record<string, unknown>;
}

const LIVE = { condition: 'CR 1234 is approved', routine_id: 'r-1', since: '2026-09-29T10:00:00.000Z' };

describe('task-db v11 → v12: waiting records → the WAITING phase', () => {
  beforeEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  afterEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('a live record moves the task to WAITING, in the column and the payload, and keeps its backstop as wait_until', () => {
    buildV11Db([
      { id: 'parked', phase: 'TODO', payload: { waiting: { ...LIVE, until: '2026-10-06T10:00:00.000Z' }, unread: false } },
      { id: 'parked-open', phase: 'TODO', payload: { waiting: LIVE } },
    ]);

    expect(rawPhase('parked')).toBe('WAITING');
    expect(readTask('parked').phase).toBe('WAITING');
    expect(readTask('parked').wait_until).toBe('2026-10-06T10:00:00.000Z');
    expect(rawPayload('parked').waiting).toBeUndefined();
    expect(rawPayload('parked').unread).toBeUndefined();

    // No backstop recorded: the task waits until something happens.
    expect(rawPhase('parked-open')).toBe('WAITING');
    expect(readTask('parked-open').wait_until).toBeUndefined();
  });

  it('a settled record (the wait already ended) is dropped and the phase is left alone', () => {
    buildV11Db([
      { id: 'woke', phase: 'NEED_ACTION', payload: { waiting: { ...LIVE, woke_at: '2026-09-29T12:00:00.000Z', woke_reason: 'fired' }, unread: true } },
      { id: 'done', phase: 'COMPLETE', payload: { waiting: LIVE } },
    ]);

    expect(rawPhase('woke')).toBe('NEED_ACTION');
    expect(readTask('woke').unread).toBe(true);
    expect(rawPayload('woke').waiting).toBeUndefined();
    // A complete task never comes back as waiting, whatever its record said.
    expect(rawPhase('done')).toBe('COMPLETE');
    expect(rawPayload('done').waiting).toBeUndefined();
  });

  it('every row without a record is untouched, and the DB is stamped current', () => {
    const phases = ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'];
    buildV11Db([
      ...phases.map((phase) => ({ id: `keep-${phase}`, phase, payload: { unread: phase === 'NEED_ACTION' } })),
      { id: 'parked', phase: 'TODO', payload: { waiting: LIVE } },
    ]);

    expect(rawPhase('parked')).toBe('WAITING'); // forces the migration to run
    for (const phase of phases) {
      expect(rawPhase(`keep-${phase}`)).toBe(phase);
      expect(readTask(`keep-${phase}`).wait_until).toBeUndefined();
    }
    expect(readTask('keep-NEED_ACTION').unread).toBe(true);
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('a WAITING row written by this version reads back with its wait_until (the new field is a payload key)', () => {
    buildV11Db([{ id: 'parked', phase: 'TODO', payload: { waiting: { ...LIVE, until: '2026-10-06T10:00:00.000Z' } } }]);
    const task = readTask('parked');
    expect(task.phase).toBe('WAITING');
    expect(task.status).toBe('todo');
    expect(task.wait_until).toBe('2026-10-06T10:00:00.000Z');
    expect('waiting' in task).toBe(false);
  });
});
