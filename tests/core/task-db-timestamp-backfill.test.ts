/**
 * NULL-timestamp backfill (idempotent, runs on every DB open).
 *
 * Rows born through the old bulk paths carried NULL created_at/updated_at/
 * _synced_at. The reconciler's LWW threshold is max(_syncedAt, updated_at) —
 * NULL zeroes it, so every remote echo won and the same ~1200 rows re-updated
 * every cycle forever. The backfill seeds created_at from the base36 ms
 * timestamp inside the task id (generateId shape), falling back sensibly.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('task-db-v9'));

import { WALNUT_HOME } from '../../src/constants.js';
import { getDb, closeDb, timestampFromTaskId, TASK_DB_PATH, SCHEMA_VERSION } from '../../src/core/task-db.js';

beforeEach(() => {
  closeDb();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(path.dirname(TASK_DB_PATH), { recursive: true });
});

afterEach(() => {
  closeDb();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('timestampFromTaskId', () => {
  it('decodes the generateId base36 prefix', () => {
    // 'mntq37r5' was a real task created 2026-04-11T02:35:42.977Z.
    expect(timestampFromTaskId('mntq37r5-4a67')).toBe('2026-04-11T02:35:42.977Z');
  });

  it('rejects prefixes outside the plausible window', () => {
    expect(timestampFromTaskId('zzzzzzzzzz-1234')).toBeNull(); // far future
    expect(timestampFromTaskId('1-1')).toBeNull();             // 1970s
    expect(timestampFromTaskId('JIRA-123')).toBeNull();        // uppercase → not ours
  });
});

describe('timestamp backfill on open', () => {
  it('backfills NULL timestamps from the id, and _synced_at for synced rows', () => {
    // Build a legacy database by hand (rows with NULL timestamps).
    const raw = new Database(TASK_DB_PATH);
    raw.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, project TEXT, status TEXT,
        phase TEXT, priority TEXT, source TEXT, parent_task_id TEXT,
        due_date TEXT, start_date TEXT, created_at TEXT, updated_at TEXT,
        completed_at TEXT, sprint TEXT, focus_tier TEXT, pinned INTEGER DEFAULT 0,
        ext TEXT, tags TEXT, depends_on TEXT, session_ids TEXT, note TEXT,
        summary TEXT, description TEXT, conversation_log TEXT, sync_error TEXT,
        _synced_at TEXT, payload TEXT
      );
    `);
    raw.prepare(
      `INSERT INTO tasks (id, title, source, created_at, updated_at, _synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('mntq37r5-4a67', 'NULL everything, synced source', 'some-provider', null, null, null);
    raw.prepare(
      `INSERT INTO tasks (id, title, source, created_at, updated_at, _synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('mntq37r6-aaaa', 'local row keeps _synced_at NULL', 'local', null, null, null);
    raw.prepare(
      `INSERT INTO tasks (id, title, source, created_at, updated_at, _synced_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run('healthy-1', 'untouched', 'local', '2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z', null);
    // Current version: the one-time migration chain is a no-op; the backfill
    // is deliberately NOT version-gated (runs idempotently on every open).
    raw.pragma('user_version = ' + SCHEMA_VERSION);
    raw.close();

    const db = getDb()!;

    const synced = db.prepare('SELECT * FROM tasks WHERE id = ?').get('mntq37r5-4a67') as any;
    expect(synced.created_at).toBe('2026-04-11T02:35:42.977Z'); // from the id
    expect(synced.updated_at).toBe('2026-04-11T02:35:42.977Z'); // falls back to created
    expect(synced._synced_at).toBe('2026-04-11T02:35:42.977Z'); // synced source gets a watermark

    const local = db.prepare('SELECT * FROM tasks WHERE id = ?').get('mntq37r6-aaaa') as any;
    expect(local.created_at).toBeTruthy();
    expect(local._synced_at).toBeNull(); // local rows never get a sync watermark

    const healthy = db.prepare('SELECT * FROM tasks WHERE id = ?').get('healthy-1') as any;
    expect(healthy.created_at).toBe('2026-01-01T00:00:00Z'); // untouched
    expect(healthy.updated_at).toBe('2026-01-02T00:00:00Z');
  });

  it('creates the task_remote_links table on fresh databases', () => {
    const db = getDb()!;
    const table = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='task_remote_links'",
    ).get();
    expect(table).toBeTruthy();
  });
});
