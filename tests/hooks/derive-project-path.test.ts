/**
 * deriveProjectPath (src/hooks/shared.ts) — the schema-lock-step canary.
 *
 * This function is a CHILD-PROCESS raw-SQL reader: the on-stop / on-compact hooks
 * are bundled as standalone scripts, so they cannot use task-db's singleton and
 * instead hand-write `SELECT project FROM tasks`. Nothing in the type system ties
 * that SQL to SCHEMA_SQL — rename or drop the `project` column and the hook fails
 * SILENTLY (it swallows every error by design, so the failure looks like "the task
 * has no project" rather than an exception).
 *
 * Hence: these tests build a SQLite file with the CURRENT project-only schema by
 * hand. If someone renames the column, `derives the project name` goes red loudly
 * and points at the SQL that must follow.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-derive-project'));

import { deriveProjectPath } from '../../src/hooks/shared.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';

// shared.ts keeps its own copy of this path (documented there); it must agree.
const TASK_DB_PATH = path.join(TASKS_DIR, 'tasks.sqlite');

/**
 * The CURRENT tasks schema, project-only: no `category` column, `project`
 * present. Deliberately hand-written rather than imported from task-db so a
 * schema rename shows up as a red test instead of being silently mirrored.
 */
const CURRENT_SCHEMA_SQL = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    project TEXT,
    status TEXT,
    phase TEXT,
    priority TEXT,
    source TEXT,
    parent_task_id TEXT,
    created_at TEXT,
    updated_at TEXT,
    payload TEXT
  );
  CREATE INDEX tasks_project ON tasks(project);
`;

interface Row { id: string; title: string; project: string | null }

function buildDb(rows: Row[]): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const db = new Database(TASK_DB_PATH);
  db.exec(CURRENT_SCHEMA_SQL);

  // Guard the premise of this whole file: the fixture must be project-only.
  const cols = (db.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map((c) => c.name);
  if (cols.includes('category')) throw new Error('fixture regressed: category column is back');
  if (!cols.includes('project')) throw new Error('fixture regressed: project column is missing');

  const insert = db.prepare(
    `INSERT INTO tasks (id, title, project, status, phase, priority, source)
     VALUES (@id, @title, @project, 'todo', 'TODO', 'none', 'local')`,
  );
  for (const r of rows) insert.run(r);
  db.close();
}

beforeEach(() => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true });
});
afterEach(() => {
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true });
});

describe('deriveProjectPath', () => {
  it('derives the project name as a single segment (no category prefix)', () => {
    buildDb([{ id: 'task-abc123', title: 'Ship it', project: 'Marina' }]);

    const derived = deriveProjectPath('task-abc123');
    expect(derived).toBe('Marina');
    // Project is the ONLY grouping layer, so the path has exactly one segment —
    // the old shape was "Category/Project".
    expect(derived!.split('/')).toHaveLength(1);
  });

  it('resolves a task by ID prefix, preferring the exact match', () => {
    buildDb([
      { id: 'abc', title: 'Exact', project: 'ExactProject' },
      { id: 'abc-longer-id', title: 'Prefix sibling', project: 'OtherProject' },
    ]);

    // Exact wins over the prefix sibling (ORDER BY (id = ?) DESC).
    expect(deriveProjectPath('abc')).toBe('ExactProject');
    // A prefix that only matches the longer row still resolves.
    expect(deriveProjectPath('abc-long')).toBe('OtherProject');
  });

  it('returns null for Inbox — empty, whitespace-only, and NULL project', () => {
    buildDb([
      { id: 'inbox-empty', title: 'Inbox task', project: '' },
      { id: 'inbox-blank', title: 'Whitespace', project: '   ' },
      { id: 'inbox-null', title: 'Null project', project: null },
    ]);

    expect(deriveProjectPath('inbox-empty')).toBeNull();
    expect(deriveProjectPath('inbox-blank')).toBeNull();
    expect(deriveProjectPath('inbox-null')).toBeNull();
  });

  it('trims surrounding whitespace off a real project name', () => {
    buildDb([{ id: 'padded', title: 'Padded', project: '  Marina  ' }]);
    expect(deriveProjectPath('padded')).toBe('Marina');
  });

  it('returns null (never throws) for an unknown task id', () => {
    buildDb([{ id: 'known', title: 'Known', project: 'Marina' }]);
    expect(() => deriveProjectPath('does-not-exist')).not.toThrow();
    expect(deriveProjectPath('does-not-exist')).toBeNull();
  });

  it('returns null (never throws) when the DB file does not exist', () => {
    // No buildDb() — hooks run on machines where the store was never created.
    expect(fs.existsSync(TASK_DB_PATH)).toBe(false);
    expect(() => deriveProjectPath('anything')).not.toThrow();
    expect(deriveProjectPath('anything')).toBeNull();
  });

  it('returns null (never throws) on a corrupt/bogus DB file', () => {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    fs.writeFileSync(TASK_DB_PATH, 'this is not a sqlite database', 'utf-8');
    expect(() => deriveProjectPath('anything')).not.toThrow();
    expect(deriveProjectPath('anything')).toBeNull();
  });

  it('returns null (never throws) when the tasks table is missing entirely', () => {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    const db = new Database(TASK_DB_PATH);
    db.exec('CREATE TABLE unrelated (x TEXT);');
    db.close();
    expect(() => deriveProjectPath('anything')).not.toThrow();
    expect(deriveProjectPath('anything')).toBeNull();
  });

  it('escapes LIKE metacharacters in the id so they match literally', () => {
    // A `%` or `_` in the id would otherwise turn the prefix probe into a
    // wildcard and could return an unrelated task's project.
    buildDb([
      { id: 'a_b', title: 'Underscore id', project: 'UnderscoreProject' },
      { id: 'axb', title: 'Wildcard victim', project: 'WrongProject' },
    ]);
    expect(deriveProjectPath('a_b')).toBe('UnderscoreProject');
  });
});
