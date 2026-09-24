/**
 * Tests for the phase-collapsing SQLite migrations, end to end from a v6 DB.
 *
 * v6 → v7 (7 phases → 5):
 *   AWAIT_HUMAN_ACTION  → WAIT            (rename; 97 live tasks on the author's
 *                                          install when this shipped)
 *   HUMAN_VERIFIED      → NEED_ACTION  (deleted phase; 0 of 3525 tasks had
 *   POST_WORK_COMPLETED → NEED_ACTION   ever reached either one)
 *
 * v7 → v8 (WAIT removed 2026-08-18 — a blocked/parked task is just TODO; the
 * Focus Bar's lowercase 'wait' PIN TIER is a different axis and still exists):
 *   WAIT → TODO
 *
 * Both branches run in ONE open, so a v6 DB's AWAIT_HUMAN_ACTION rows land on
 * TODO (via WAIT) — the assertions below pin that FINAL state, not the
 * intermediate. TODO (not NEED_ACTION) is the deliberate landing: WAIT rows
 * were "waiting on something external", i.e. work not yet done, and sending
 * them to NEED_ACTION would flag them all red+unread on upgrade.
 *
 * Phase lives in the indexed `phase` column, and a row written by a newer client
 * can also carry `$.phase` inside the `payload` JSON. Both are rewritten, so
 * each test builds a REAL v6 (or v7) database with raw SQL and opens it through
 * `getDb()` so the production migration path runs verbatim.
 *
 * Would these fail on reverted code? YES. Drop `migratePhasesToFive` and 97
 * tasks keep a phase value no map, label, icon, or state machine recognizes:
 * `deriveStatusFromPhase` falls through to 'todo', so tasks mid-flight silently
 * reappear as untouched TODOs. Drop `migrateWaitToTodo` and every WAIT row keeps
 * a phase that is no longer in VALID_PHASES.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-db-v7'));

import { getDb, closeDb, rowToTask, TASK_DB_PATH, SCHEMA_VERSION } from '../../src/core/task-db.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';

/** The tasks schema as shipped at SCHEMA_VERSION = 6. */
const V6_SCHEMA_SQL = `
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

interface V6Row { id: string; phase: string; status?: string; payload?: string | null; updated_at?: string }

function buildDbAtVersion(rows: V6Row[], userVersion: number): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const db = new Database(TASK_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(V6_SCHEMA_SQL);
  const insert = db.prepare(
    `INSERT INTO tasks (id, title, project, status, phase, priority, source, updated_at, payload)
     VALUES (@id, @id, '', @status, @phase, 'none', 'local', @updated_at, @payload)`,
  );
  for (const r of rows) {
    insert.run({
      id: r.id,
      phase: r.phase,
      status: r.status ?? 'in_progress',
      payload: r.payload ?? null,
      updated_at: r.updated_at ?? '2026-01-01T00:00:00.000Z',
    });
  }
  db.pragma('user_version = ' + userVersion);
  db.close();
}

function buildV6Db(rows: V6Row[]): void {
  buildDbAtVersion(rows, 6);
}

/** Same physical schema, stamped v7 — so ONLY the v7 → v8 branch runs. */
function buildV7Db(rows: V6Row[]): void {
  buildDbAtVersion(rows, 7);
}

/** Stamped v10 — so ONLY the v10 → v11 branch (the NEED_ACTION rename) runs. */
function buildV10Db(rows: V6Row[]): void {
  buildDbAtVersion(rows, 10);
}

/** Raw column value — proves the INDEXED copy moved, not just the payload. */
function rawPhase(id: string): string {
  const row = getDb()!.prepare('SELECT phase FROM tasks WHERE id = ?').get(id) as { phase: string };
  return row.phase;
}

function readTask(id: string): Record<string, unknown> {
  const row = getDb()!.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as Record<string, never>;
  return rowToTask(row) as unknown as Record<string, unknown>;
}

describe('task-db v6 → v8 migration: 7 phases → 5 → 4', () => {
  beforeEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  afterEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  // (WAIT removed 2026-08-18) — v7 renamed AWAIT_HUMAN_ACTION → WAIT, then v8
  // moves WAIT → TODO. Both run in one open, so the FINAL state is TODO.
  it('moves AWAIT_HUMAN_ACTION to TODO (via WAIT) in the column and the payload', () => {
    buildV6Db([
      { id: 'blocked-col', phase: 'AWAIT_HUMAN_ACTION' },
      { id: 'blocked-both', phase: 'AWAIT_HUMAN_ACTION', payload: JSON.stringify({ phase: 'AWAIT_HUMAN_ACTION', unread: true }) },
    ]);

    expect(rawPhase('blocked-col')).toBe('TODO');
    expect(readTask('blocked-col').phase).toBe('TODO');
    // Migrating only the column would leave reads (which hydrate from payload)
    // still seeing the retired value.
    expect(rawPhase('blocked-both')).toBe('TODO');
    expect(readTask('blocked-both').phase).toBe('TODO');
    // unread is untouched by BOTH migrations: the row's "look at me" claim is
    // still honest until the human opens it.
    expect(readTask('blocked-both').unread).toBe(true);
  });

  it('lands both deleted phases on NEED_ACTION, not COMPLETE', () => {
    // Conservative direction on purpose: the row stays in the active list where
    // its owner can see it, instead of the migration silently declaring work
    // finished on their behalf.
    buildV6Db([
      { id: 'verified', phase: 'HUMAN_VERIFIED' },
      { id: 'post-work', phase: 'POST_WORK_COMPLETED' },
    ]);

    expect(rawPhase('verified')).toBe('NEED_ACTION');
    expect(rawPhase('post-work')).toBe('NEED_ACTION');
    expect(readTask('verified').phase).toBe('NEED_ACTION');
    expect(readTask('post-work').phase).toBe('NEED_ACTION');
  });

  // (WAIT removed 2026-08-18) — the surviving set is the 4-phase lifecycle.
  it('leaves the four surviving phases untouched', () => {
    const survivors = ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'];
    buildV6Db(survivors.map((phase) => ({ id: `keep-${phase}`, phase })));

    for (const phase of survivors) expect(rawPhase(`keep-${phase}`)).toBe(phase);
  });

  it('does not bump updated_at — a phase rename is not a task edit', () => {
    buildV6Db([
      { id: 'stamped', phase: 'AWAIT_HUMAN_ACTION', updated_at: '2026-01-02T03:04:05.000Z' },
    ]);

    expect(rawPhase('stamped')).toBe('TODO'); // (WAIT removed 2026-08-18)
    // Bumping it would reshuffle every updated_at-sorted list on upgrade.
    expect(readTask('stamped').updated_at).toBe('2026-01-02T03:04:05.000Z');
  });

  it('survives NULL and corrupt payloads', () => {
    buildV6Db([
      { id: 'null-payload', phase: 'AWAIT_HUMAN_ACTION', payload: null },
      { id: 'corrupt-payload', phase: 'AWAIT_HUMAN_ACTION', payload: '{not json' },
    ]);

    // The column moves either way; the json_valid() guard skips the blob.
    expect(rawPhase('null-payload')).toBe('TODO');
    expect(rawPhase('corrupt-payload')).toBe('TODO');
  });

  it('hydration also repairs a retired phase that arrived after the migration', () => {
    // The v7 UPDATE only touches rows present when it runs. Rows can arrive by
    // another door afterwards: a cloud replica seeded from an older primary's
    // projection, a plugin pull echoing a stale remote status. rowToTask runs
    // migratePhase as the net — before this was wired, migratePhase had NO
    // production caller at all and such a row hydrated with a phase no map,
    // label, or state machine recognizes.
    buildV6Db([{ id: 'anchor', phase: 'TODO' }]);
    expect(rawPhase('anchor')).toBe('TODO'); // forces the migration to run

    getDb()!.prepare(`INSERT INTO tasks (id, title, project, status, phase, priority, source, updated_at)
      VALUES ('late', 'late', '', 'in_progress', 'AWAIT_HUMAN_ACTION', 'none', 'local', '2026-01-01T00:00:00.000Z')`).run();

    expect(rawPhase('late')).toBe('AWAIT_HUMAN_ACTION'); // untouched on disk
    expect(readTask('late').phase).toBe('TODO');         // repaired on read (WAIT removed 2026-08-18)
  });

  it('marks the DB current and is a no-op on the second open', () => {
    buildV6Db([{ id: 'once', phase: 'AWAIT_HUMAN_ACTION' }]);

    expect(rawPhase('once')).toBe('TODO');
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    closeDb();
    expect(rawPhase('once')).toBe('TODO');
  });
});

/**
 * v7 → v8 in isolation (stamp the DB v7 so only `migrateWaitToTodo` runs).
 * WAIT removed 2026-08-18: a blocked/parked task is just a TODO. TODO is the
 * deliberate landing — NEED_ACTION would flag every parked row red+unread on
 * upgrade. `updated_at` and `unread` are left alone.
 */
describe('task-db v7 → v8 migration: WAIT → TODO', () => {
  beforeEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  afterEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('moves WAIT to TODO in the column AND the payload', () => {
    buildV7Db([
      { id: 'wait-col', phase: 'WAIT' },
      { id: 'wait-both', phase: 'WAIT', payload: JSON.stringify({ phase: 'WAIT', unread: true }) },
    ]);

    expect(rawPhase('wait-col')).toBe('TODO');
    expect(readTask('wait-col').phase).toBe('TODO');
    expect(rawPhase('wait-both')).toBe('TODO');
    // Payload copy must move too — reads hydrate from it.
    expect(readTask('wait-both').phase).toBe('TODO');
  });

  it('leaves updated_at and unread untouched', () => {
    buildV7Db([
      {
        id: 'parked',
        phase: 'WAIT',
        updated_at: '2026-02-03T04:05:06.000Z',
        payload: JSON.stringify({ phase: 'WAIT', unread: true }),
      },
    ]);

    expect(rawPhase('parked')).toBe('TODO');
    // A rename is not an edit, and the row's unread claim is still honest.
    expect(readTask('parked').updated_at).toBe('2026-02-03T04:05:06.000Z');
    expect(readTask('parked').unread).toBe(true);
  });

  it('leaves every surviving phase alone and marks the DB current', () => {
    const survivors = ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'];
    buildV7Db([...survivors.map((phase) => ({ id: `v8-keep-${phase}`, phase })), { id: 'v8-wait', phase: 'WAIT' }]);

    expect(rawPhase('v8-wait')).toBe('TODO'); // forces the migration to run
    for (const phase of survivors) expect(rawPhase(`v8-keep-${phase}`)).toBe(phase);
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });
});

/**
 * v10 → v11: `AGENT_COMPLETE` → `NEED_ACTION` (2026-09-01). A pure rename — same
 * slot in the lifecycle, same red row, same unread dot. The old name described
 * the agent's side of the handoff and read as "done" to everyone; the new one
 * says what the human has to do.
 *
 * Would these fail on reverted code? YES. Without the v11 branch every
 * handed-back row keeps a phase that is no longer in VALID_PHASES, so
 * `deriveStatusFromPhase` falls through to 'todo' and a task waiting on the
 * human reappears as an untouched TODO — the exact failure v7 was written to
 * prevent, one rename later.
 */
describe('task-db v10 → v11 migration: AGENT_COMPLETE → NEED_ACTION', () => {
  beforeEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  afterEach(async () => {
    closeDb();
    await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('renames in the column AND the payload', () => {
    buildV10Db([
      { id: 'ac-col', phase: 'AGENT_COMPLETE' },
      { id: 'ac-both', phase: 'AGENT_COMPLETE', payload: JSON.stringify({ phase: 'AGENT_COMPLETE', unread: true }) },
    ]);

    expect(rawPhase('ac-col')).toBe('NEED_ACTION');
    expect(readTask('ac-col').phase).toBe('NEED_ACTION');
    // Reads hydrate from the payload, so a column-only rewrite would leave every
    // read still seeing the old name.
    expect(rawPhase('ac-both')).toBe('NEED_ACTION');
    expect(readTask('ac-both').phase).toBe('NEED_ACTION');
  });

  it('leaves updated_at and unread untouched', () => {
    buildV10Db([
      {
        id: 'handed-back',
        phase: 'AGENT_COMPLETE',
        updated_at: '2026-03-04T05:06:07.000Z',
        payload: JSON.stringify({ phase: 'AGENT_COMPLETE', unread: true }),
      },
    ]);

    expect(rawPhase('handed-back')).toBe('NEED_ACTION');
    // A rename is not an edit — bumping updated_at would reshuffle every
    // updated_at-sorted list on upgrade. The unread claim is still honest.
    expect(readTask('handed-back').updated_at).toBe('2026-03-04T05:06:07.000Z');
    expect(readTask('handed-back').unread).toBe(true);
  });

  it('does not touch the other three phases, and marks the DB current', () => {
    const untouched = ['TODO', 'IN_PROGRESS', 'COMPLETE'];
    buildV10Db([
      ...untouched.map((phase) => ({ id: `v11-keep-${phase}`, phase })),
      { id: 'v11-ac', phase: 'AGENT_COMPLETE' },
    ]);

    expect(rawPhase('v11-ac')).toBe('NEED_ACTION'); // forces the migration to run
    for (const phase of untouched) expect(rawPhase(`v11-keep-${phase}`)).toBe(phase);
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('survives NULL and corrupt payloads, and is a no-op on the second open', () => {
    buildV10Db([
      { id: 'v11-null', phase: 'AGENT_COMPLETE', payload: null },
      { id: 'v11-corrupt', phase: 'AGENT_COMPLETE', payload: '{not json' },
    ]);

    // The column moves either way; the json_valid() guard skips the bad blob.
    expect(rawPhase('v11-null')).toBe('NEED_ACTION');
    expect(rawPhase('v11-corrupt')).toBe('NEED_ACTION');

    closeDb();
    expect(rawPhase('v11-null')).toBe('NEED_ACTION');
  });

  it('repairs a row that arrives with the old name AFTER the migration ran', () => {
    // The UPDATE only touches rows present when it runs. Others arrive later: a
    // plugin pull echoing a stale remote body, a cloud replica seeded from an
    // older primary, a remote daemon on the previous build. rowToTask →
    // migratePhase is the net.
    buildV10Db([{ id: 'v11-anchor', phase: 'TODO' }]);
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);

    getDb()!.prepare(`INSERT INTO tasks (id, title, project, status, phase, priority, source, updated_at)
      VALUES ('v11-late', 'late', '', 'in_progress', 'AGENT_COMPLETE', 'none', 'local', '2026-01-01T00:00:00.000Z')`).run();

    expect(rawPhase('v11-late')).toBe('AGENT_COMPLETE');       // untouched on disk
    expect(readTask('v11-late').phase).toBe('NEED_ACTION');    // repaired on read
  });
});
