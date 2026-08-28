/**
 * Tests for the group → per-project FOLDER migration (`migrateGroupsToFolders`).
 *
 * Before it, a "virtual group" was three columns (id, label, hidden) plus
 * membership hidden in each task's `payload.group_id`, and the group listing was
 * DERIVED from membership — so a registry row with no members was invisible, and a
 * group could span any number of projects. The folder model needs the opposite:
 * every folder belongs to exactly ONE project, an EMPTY folder is legitimate and
 * visible, and folders nest. The migration therefore has to (a) add the
 * project/parent_id columns, (b) decide ONE project per existing group and evict
 * the members that don't belong, (c) delete registry rows that have no members
 * (they were invisible before and must not resurrect as empty folders), and
 * (d) mint a row for a group that only ever existed as membership.
 *
 * Numbered 10, not 9: a production DB was found stamped user_version=9 by an
 * interim build while still carrying the OLD 3-column task_groups, so a `< 9`
 * guard would have skipped it there and the columns would never exist. The
 * "production shape" test below pins exactly that case.
 *
 * Each test builds a REAL pre-migration database with raw SQL and opens it through
 * `getDb()`, so the production migration path runs verbatim.
 *
 * Would these fail on reverted code? YES. Drop `migrateGroupsToFolders` and
 * `readStore` selects columns that don't exist (every task read throws), and even
 * with the columns present, an un-backfilled folder has project '' — so every
 * existing group silently relocates to the Inbox and same-project joins start
 * rejecting the very members already inside it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-db-v10'));

import { getDb, closeDb, TASK_DB_PATH, SCHEMA_VERSION } from '../../src/core/task-db.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';

/**
 * The schema as shipped BEFORE the folder cutover: note task_groups has exactly
 * three columns. SCHEMA_SQL uses CREATE TABLE IF NOT EXISTS, so on an existing DB
 * the new columns can only come from the migration's ALTER TABLE.
 */
const PRE_FOLDER_SCHEMA_SQL = `
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

interface FixtureTask {
  id: string;
  title?: string;
  project?: string;
  /** Group membership, written where it really lived: inside the payload blob. */
  groupId?: string;
  /** Extra payload keys, to prove json_remove only takes group_id. */
  extraPayload?: Record<string, unknown>;
}

interface FixtureGroup {
  id: string;
  label: string;
  hidden?: 0 | 1;
}

/**
 * Build a pre-folder DB stamped at `userVersion`. Tasks are inserted in array
 * order, which is the order the migration's SELECT walks them in — that order is
 * what "the first member" means for label + tie-breaking.
 */
function buildDb(opts: {
  tasks: FixtureTask[];
  groups?: FixtureGroup[];
  userVersion: number;
}): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const db = new Database(TASK_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(PRE_FOLDER_SCHEMA_SQL);

  const insertTask = db.prepare(
    `INSERT INTO tasks (id, title, project, status, phase, priority, source, created_at, updated_at, payload)
     VALUES (@id, @title, @project, 'todo', 'TODO', 'none', 'local',
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', @payload)`,
  );
  for (const t of opts.tasks) {
    const payloadObj: Record<string, unknown> = { ...(t.extraPayload ?? {}) };
    if (t.groupId) payloadObj.group_id = t.groupId;
    insertTask.run({
      id: t.id,
      title: t.title ?? t.id,
      project: t.project ?? '',
      payload: Object.keys(payloadObj).length ? JSON.stringify(payloadObj) : null,
    });
  }

  const insertGroup = db.prepare('INSERT INTO task_groups (id, label, hidden) VALUES (?, ?, ?)');
  for (const g of opts.groups ?? []) insertGroup.run(g.id, g.label, g.hidden ?? 0);

  db.pragma('user_version = ' + opts.userVersion);
  db.close();
}

/** task_groups column names, in declaration order. */
function groupColumns(): string[] {
  return (getDb()!.prepare('PRAGMA table_info(task_groups)').all() as { name: string }[]).map(
    (c) => c.name,
  );
}

interface FolderRow {
  id: string;
  label: string;
  hidden: number;
  project: string;
  parent_id: string | null;
}

/** One folder registry row, post-migration. */
function folderRow(id: string): FolderRow | undefined {
  return getDb()!.prepare('SELECT * FROM task_groups WHERE id = ?').get(id) as
    | FolderRow
    | undefined;
}

function folderIds(): string[] {
  return (getDb()!.prepare('SELECT id FROM task_groups ORDER BY id').all() as { id: string }[]).map(
    (r) => r.id,
  );
}

/** The membership as it physically sits in the payload blob. */
function membership(id: string): string | undefined {
  const row = getDb()!
    .prepare(`SELECT json_extract(payload, '$.group_id') AS gid FROM tasks WHERE id = ?`)
    .get(id) as { gid: string | null } | undefined;
  return row?.gid ?? undefined;
}

function rawPayload(id: string): string | null {
  const row = getDb()!.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as {
    payload: string | null;
  };
  return row.payload;
}

beforeEach(async () => {
  closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('task-db → per-project folders migration', () => {
  it('adds the project + parent_id columns and backfills the project from the members', () => {
    buildDb({
      userVersion: 8,
      groups: [{ id: 'g-alpha', label: 'Alpha cluster' }],
      tasks: [
        { id: 'a1', project: 'Alpha', groupId: 'g-alpha' },
        { id: 'a2', project: 'Alpha', groupId: 'g-alpha' },
      ],
    });

    const cols = groupColumns();
    expect(cols).toContain('project');
    expect(cols).toContain('parent_id');
    // The pre-existing columns are untouched.
    expect(cols).toEqual(expect.arrayContaining(['id', 'label', 'hidden']));

    const row = folderRow('g-alpha')!;
    expect(row.project).toBe('Alpha');
    expect(row.parent_id).toBeNull(); // every migrated folder starts top-level
    expect(row.label).toBe('Alpha cluster'); // an existing label is never rewritten
    // Both members keep their membership.
    expect(membership('a1')).toBe('g-alpha');
    expect(membership('a2')).toBe('g-alpha');
  });

  it('gives the folder the MAJORITY project and evicts the minority members', () => {
    // The real shape this had to fix: a cross-project group. Two members in Alpha,
    // one in Beta → the folder is Alpha's, and the Beta task walks out rather than
    // being dragged into a project it isn't in.
    buildDb({
      userVersion: 8,
      groups: [{ id: 'g-mixed', label: 'Mixed' }],
      tasks: [
        { id: 'm1', project: 'Alpha', groupId: 'g-mixed' },
        { id: 'm2', project: 'Alpha', groupId: 'g-mixed' },
        { id: 'm3', project: 'Beta', groupId: 'g-mixed', extraPayload: { unread: true } },
      ],
    });

    expect(folderRow('g-mixed')!.project).toBe('Alpha');
    expect(membership('m1')).toBe('g-mixed');
    expect(membership('m2')).toBe('g-mixed');
    // The minority member lost ONLY group_id — its other payload keys survive.
    expect(membership('m3')).toBeUndefined();
    expect(rawPayload('m3')).not.toContain('group_id');
    expect(rawPayload('m3')).toContain('unread');
  });

  it('compares projects case-insensitively and keeps a member spelling', () => {
    // 'Alpha' + 'alpha' are the SAME project (the registry is COLLATE NOCASE), so
    // they form the 2-strong majority over Beta, and the stored spelling comes from
    // a real member rather than a lowercased key.
    buildDb({
      userVersion: 8,
      groups: [{ id: 'g-case', label: 'Cased' }],
      tasks: [
        { id: 'c1', project: 'Alpha', groupId: 'g-case' },
        { id: 'c2', project: 'alpha', groupId: 'g-case' },
        { id: 'c3', project: 'Beta', groupId: 'g-case' },
      ],
    });

    expect(folderRow('g-case')!.project).toBe('Alpha');
    expect(membership('c1')).toBe('g-case');
    expect(membership('c2')).toBe('g-case');
    expect(membership('c3')).toBeUndefined();
  });

  it("breaks a tie in favour of the FIRST member's project", () => {
    buildDb({
      userVersion: 8,
      groups: [{ id: 'g-tie', label: 'Tie' }],
      tasks: [
        { id: 't1', project: 'Beta', groupId: 'g-tie' },
        { id: 't2', project: 'Alpha', groupId: 'g-tie' },
      ],
    });

    expect(folderRow('g-tie')!.project).toBe('Beta');
    expect(membership('t1')).toBe('g-tie');
    expect(membership('t2')).toBeUndefined();
  });

  it("keeps an Inbox group in the Inbox ('' is a real project)", () => {
    buildDb({
      userVersion: 8,
      groups: [{ id: 'g-inbox', label: 'Inbox cluster' }],
      tasks: [
        { id: 'i1', project: '', groupId: 'g-inbox' },
        { id: 'i2', project: '', groupId: 'g-inbox' },
      ],
    });

    expect(folderRow('g-inbox')!.project).toBe('');
    expect(membership('i1')).toBe('g-inbox');
    expect(membership('i2')).toBe('g-inbox');
  });

  it('DELETES a registry row that has no live members', () => {
    // Pre-migration the listing was derived from membership, so this row was
    // invisible. Keeping it would make a folder the user never created pop into
    // existence the moment empty folders became visible.
    buildDb({
      userVersion: 8,
      groups: [
        { id: 'g-live', label: 'Live' },
        { id: 'g-ghost', label: 'Nobody home' },
      ],
      tasks: [{ id: 'L1', project: 'Alpha', groupId: 'g-live' }],
    });

    expect(folderIds()).toEqual(['g-live']);
    expect(folderRow('g-ghost')).toBeUndefined();
  });

  it("mints a registry row for a group that only existed as membership (label = first member's title)", () => {
    // Registry rows were backfilled lazily at runtime, so plenty of groups had
    // members but no row. Without an inserted row the folder would vanish.
    buildDb({
      userVersion: 8,
      groups: [], // deliberately empty
      tasks: [
        { id: 'o1', title: 'Lead title', project: 'Alpha', groupId: 'g-orphan' },
        { id: 'o2', title: 'Second', project: 'Alpha', groupId: 'g-orphan' },
      ],
    });

    const row = folderRow('g-orphan');
    expect(row, 'a membership-only group must get a registry row').toBeDefined();
    expect(row!.label).toBe('Lead title');
    expect(row!.project).toBe('Alpha');
    expect(row!.hidden).toBe(0);
    expect(membership('o1')).toBe('g-orphan');
    expect(membership('o2')).toBe('g-orphan');
  });

  it('preserves the hidden flag while backfilling the project', () => {
    buildDb({
      userVersion: 8,
      groups: [{ id: 'g-hidden', label: 'Collapsed', hidden: 1 }],
      tasks: [
        { id: 'h1', project: 'Alpha', groupId: 'g-hidden' },
        { id: 'h2', project: 'Alpha', groupId: 'g-hidden' },
      ],
    });

    const row = folderRow('g-hidden')!;
    expect(row.hidden).toBe(1);
    expect(row.project).toBe('Alpha');
    expect(row.label).toBe('Collapsed');
  });

  it('migrates the PRODUCTION shape: stamped user_version 9 with the OLD 3-column table', () => {
    // The incident this migration was renumbered for: an interim build stamped the
    // DB 9 without ever adding the folder columns. A `< 9` guard skips it, readStore
    // then selects columns that do not exist, and the whole task store fails to
    // open. So the SAME work must run from 9 as from 8.
    buildDb({
      userVersion: 9,
      groups: [
        { id: 'p-mixed', label: 'Prod mixed' },
        { id: 'p-ghost', label: 'Prod empty' },
      ],
      tasks: [
        { id: 'p1', project: 'Alpha', groupId: 'p-mixed' },
        { id: 'p2', project: 'Alpha', groupId: 'p-mixed' },
        { id: 'p3', project: 'Beta', groupId: 'p-mixed' },
        { id: 'p4', title: 'Orphan lead', project: 'Gamma', groupId: 'p-orphan' },
      ],
    });

    // (a) the columns exist at all
    expect(groupColumns()).toContain('project');
    expect(groupColumns()).toContain('parent_id');
    // (b) the backfill really ran — not just the ALTER
    expect(folderRow('p-mixed')!.project).toBe('Alpha');
    expect(membership('p3')).toBeUndefined();
    // (c) the empty row is gone and the membership-only group got a row
    expect(folderRow('p-ghost')).toBeUndefined();
    expect(folderRow('p-orphan')!.project).toBe('Gamma');
    expect(folderRow('p-orphan')!.label).toBe('Orphan lead');
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('marks the DB current and is a no-op on the second open', () => {
    buildDb({
      userVersion: 8,
      groups: [
        { id: 'g-keep', label: 'Keep me' },
        { id: 'g-drop', label: 'Drop me' },
      ],
      tasks: [
        { id: 'k1', project: 'Alpha', groupId: 'g-keep' },
        { id: 'k2', project: 'Alpha', groupId: 'g-keep' },
        { id: 'k3', project: 'Beta', groupId: 'g-keep' },
      ],
    });

    // SCHEMA_VERSION, not a literal — a later migration would carry it further.
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(folderIds()).toEqual(['g-keep']);
    expect(folderRow('g-keep')!.project).toBe('Alpha');
    expect(membership('k3')).toBeUndefined();

    closeDb();

    // Second open: the version gate short-circuits and nothing shifts — in
    // particular the evicted member is not re-counted and no row is re-minted.
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(folderIds()).toEqual(['g-keep']);
    expect(folderRow('g-keep')!.project).toBe('Alpha');
    expect(folderRow('g-keep')!.label).toBe('Keep me');
    expect(membership('k1')).toBe('g-keep');
    expect(membership('k3')).toBeUndefined();
  });

  it('leaves a DB with no groups at all alone', () => {
    buildDb({ userVersion: 8, tasks: [{ id: 'lone', project: 'Alpha' }] });
    expect(folderIds()).toEqual([]);
    expect(groupColumns()).toContain('project');
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });
});
