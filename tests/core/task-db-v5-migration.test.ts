/**
 * Tests for the v4 → v5 SQLite migration (category removal — Project becomes the
 * single grouping layer).
 *
 * Every test builds a REAL v4 database with raw SQL (old `category` column,
 * `task_categories` table, `.metadata_*` sentinel tasks, degenerate groups,
 * two-case duplicate projects, an ms-todo-owned category), then opens it through
 * `getDb()` so the production migration path runs verbatim. Self-contained: it
 * touches task-db only, never task-manager.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import Database from 'better-sqlite3';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-db-v5'));

import {
  getDb,
  closeDb,
  TASK_DB_PATH,
  TASK_DB_PRE_V5_BACKUP_PATH,
  SCHEMA_VERSION,
  promoteLegacyGroup,
  legacyListName,
  pickMajoritySource,
} from '../../src/core/task-db.js';
import { routePulledListToProject } from '../../src/utils/format.js';
import { WALNUT_HOME, TASKS_DIR } from '../../src/constants.js';
import { log } from '../../src/logging/index.js';

// ── v4 fixture ─────────────────────────────────────────────────────────────

/** The exact tasks/task_categories schema shipped at SCHEMA_VERSION = 4. */
const V4_SCHEMA_SQL = `
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
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
  CREATE INDEX tasks_category_project ON tasks(category, project);
  CREATE INDEX tasks_status ON tasks(status);
  CREATE TABLE task_categories (
    name TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    order_index INTEGER
  );
  CREATE TABLE task_groups (id TEXT PRIMARY KEY, label TEXT NOT NULL, hidden INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE custom_tiers (id TEXT PRIMARY KEY, label TEXT NOT NULL, order_index INTEGER);
`;

interface FixtureTask {
  id: string;
  title: string;
  category: string;
  /** `null` exercises the nullable v4 column — the UPDATE must use `IS`, not `=`. */
  project: string | null;
  source?: string;
  description?: string;
  /** Provider row id blob, as a plugin would have written it. */
  ext?: Record<string, unknown>;
}

function buildV4Db(tasks: FixtureTask[], categories: [string, string][]): void {
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  const db = new Database(TASK_DB_PATH);
  db.pragma('journal_mode = WAL');
  db.exec(V4_SCHEMA_SQL);
  const insertCat = db.prepare(
    'INSERT INTO task_categories (name, source, order_index) VALUES (?, ?, ?)',
  );
  categories.forEach(([name, source], i) => insertCat.run(name, source, i));
  const insertTask = db.prepare(
    `INSERT INTO tasks (id, title, category, project, status, phase, priority, source, description, ext)
     VALUES (@id, @title, @category, @project, 'todo', 'TODO', 'none', @source, @description, @ext)`,
  );
  for (const t of tasks) {
    insertTask.run({
      id: t.id,
      title: t.title,
      category: t.category,
      project: t.project,
      source: t.source ?? 'local',
      description: t.description ?? '',
      ext: t.ext ? JSON.stringify(t.ext) : null,
    });
  }
  db.pragma('user_version = 4');
  db.close();
}

/**
 * The standard fixture, exercising every migration rule at once:
 *  - Work/Work + Personal/''      → degenerate promotion (project = category name)
 *  - Personal/NULL                → same promotion through the NULLABLE column
 *  - Work/'Quick Start'           → Inbox ('')
 *  - Inbox/Inbox                  → Inbox ('')
 *  - Work/Marina (3) + Personal/marina (1) → case-insensitive merge onto "Marina"
 *  - Sync/Acme (ms-todo)          → project claimed by ms-todo + remote_list alias
 *  - two sentinel tasks           → registry metadata, rows deleted
 */
function buildStandardFixture(): void {
  buildV4Db(
    [
      { id: 't1', title: 'work a', category: 'Work', project: 'Work' },
      { id: 't2', title: 'work b', category: 'Work', project: 'Work' },
      { id: 't3', title: 'personal a', category: 'Personal', project: '' },
      // NULL, not '': v4's project column was nullable, so a real DB has both
      // spellings of "no project" and they are DIFFERENT rows to `GROUP BY`.
      { id: 't12', title: 'personal null', category: 'Personal', project: null },
      { id: 't4', title: 'quick capture', category: 'Work', project: 'Quick Start' },
      { id: 't5', title: 'inbox capture', category: 'Inbox', project: 'Inbox' },
      { id: 't6', title: 'marina 1', category: 'Work', project: 'Marina' },
      { id: 't7', title: 'marina 2', category: 'Work', project: 'Marina' },
      { id: 't8', title: 'marina 3', category: 'Work', project: 'Marina' },
      { id: 't9', title: 'marina lower', category: 'Personal', project: 'marina' },
      { id: 't10', title: 'acme 1', category: 'Sync', project: 'Acme', source: 'ms-todo' },
      { id: 't11', title: 'acme 2', category: 'Sync', project: 'Acme', source: 'ms-todo' },
      {
        id: 'm1',
        title: '.metadata_project',
        category: 'Work',
        project: 'Marina',
        description: 'default_cwd: /tmp/marina\n',
      },
      {
        id: 'm2',
        title: '.metadata_category',
        category: 'Work',
        project: '.metadata_category',
        description: 'default_host: workbox\n',
      },
    ],
    [
      ['Work', 'local'],
      ['Personal', 'local'],
      ['Inbox', 'local'],
      ['Sync', 'ms-todo'],
    ],
  );
}

/**
 * A GENUINE provider tie: two providers, two tasks each, so `ranked[0][1]` and
 * `ranked[1][1]` are equal on WEIGHT (2 vs 2) rather than merely both being 1.
 * Every task carries a provider `ext` blob so the post-merge restamp is visible.
 */
function buildTiedProvidersFixture(): void {
  buildV4Db(
    [
      { id: 'a1', title: 'a', category: 'SyncA', project: 'Shared', source: 'ms-todo', ext: { 'ms-todo': { id: 'remote-a1' } } },
      { id: 'a2', title: 'b', category: 'SyncA', project: 'Shared', source: 'ms-todo', ext: { 'ms-todo': { id: 'remote-a2' } } },
      { id: 'b1', title: 'c', category: 'SyncB', project: 'Shared', source: 'jira', ext: { jira: { id: 'JIRA-1' } } },
      { id: 'b2', title: 'd', category: 'SyncB', project: 'Shared', source: 'jira', ext: { jira: { id: 'JIRA-2' } } },
    ],
    [
      ['SyncA', 'ms-todo'],
      ['SyncB', 'jira'],
    ],
  );
}

interface ProjectRow {
  name: string;
  source: string;
  order_index: number | null;
  metadata: string | null;
}

function readProjects(): Map<string, ProjectRow & { meta: Record<string, unknown> }> {
  const rows = getDb()!
    .prepare('SELECT name, source, order_index, metadata FROM task_projects')
    .all() as ProjectRow[];
  return new Map(
    rows.map((r) => [
      r.name,
      { ...r, meta: (r.metadata ? JSON.parse(r.metadata) : {}) as Record<string, unknown> },
    ]),
  );
}

function tableExists(name: string): boolean {
  const row = getDb()!
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
  return !!row;
}

async function wipe(): Promise<void> {
  closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
  await fsp.mkdir(TASKS_DIR, { recursive: true });
}

beforeEach(wipe);
afterEach(async () => {
  closeDb();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
});

// ── 1. Group promotion rule (pure) ─────────────────────────────────────────

describe('promoteLegacyGroup', () => {
  it('promotes degenerate groups to the category name', () => {
    expect(promoteLegacyGroup('Work', 'Work')).toBe('Work');
    expect(promoteLegacyGroup('Work', 'work')).toBe('Work');
    expect(promoteLegacyGroup('Personal', '')).toBe('Personal');
  });

  it('routes the Inbox category and Quick Start projects to Inbox', () => {
    expect(promoteLegacyGroup('Inbox', 'Inbox')).toBe('');
    expect(promoteLegacyGroup('inbox', '')).toBe('');
    expect(promoteLegacyGroup('Work', 'Quick Start')).toBe('');
    expect(promoteLegacyGroup('', '')).toBe('');
  });

  it('leaves a real project name untouched', () => {
    expect(promoteLegacyGroup('Work', 'Marina')).toBe('Marina');
  });
});

// ── 1b. Migration ⇔ pull-side parity ───────────────────────────────────────
// The ms-todo pull derives a project from a remote LIST NAME; the migration
// derives it from the (category, project) pair the list name encoded. If they
// disagree, the next sync tick silently UNDOES the migration (the catch-up pass
// rewrites project= back onto every task in that list). Pin the agreement.

describe('migration ⇔ pull routing parity', () => {
  const cases: Array<{ category: string; project: string; list: string }> = [
    // The shapes that actually resurrected 'Quick Start' / 'Inbox' in prod.
    { category: 'Passion', project: 'Quick Start', list: 'Passion / Quick Start' },
    { category: 'Inbox', project: 'Quick Start', list: 'Inbox / Quick Start' },
    { category: 'Inbox', project: 'Inbox', list: 'Inbox' },
    { category: 'Work', project: 'quick start', list: 'Work / quick start' },
    // …and the ordinary shapes, which must NOT be routed to Inbox.
    { category: 'Work', project: 'VPA', list: 'Work / VPA' },
    { category: 'Marina', project: 'Marina', list: 'Marina' },
    { category: 'Inbox', project: 'Marina', list: 'Inbox / Marina' },
    { category: 'Work', project: 'Inbox Zero', list: 'Work / Inbox Zero' },
  ];

  for (const { category, project, list } of cases) {
    it(`(${category} / ${project}) and list "${list}" agree`, () => {
      const migrated = promoteLegacyGroup(category, project);
      const pulled = routePulledListToProject(list);
      // Case-insensitive: identity folds case; the migration additionally picks a
      // canonical SPELLING from the data, which a single pair can't express.
      expect(pulled.toLowerCase()).toBe(migrated.toLowerCase());
    });
  }
});

// ── 1c. Shared helpers (pure) ──────────────────────────────────────────────

describe('legacyListName', () => {
  it('joins a real two-level pair', () => {
    expect(legacyListName('Work', 'VPA')).toBe('Work / VPA');
  });

  it('collapses a degenerate pair CASE-INSENSITIVELY', () => {
    // MS To-Do list lookup lowercases, so "Work"/"work" was ONE list named
    // "Work" — a case-sensitive compare produced the never-existed "Work / work"
    // and the alias then resolved to nothing (or created a new list).
    expect(legacyListName('Work', 'Work')).toBe('Work');
    expect(legacyListName('Work', 'work')).toBe('Work');
    expect(legacyListName('work', 'WORK')).toBe('work');
  });

  it('falls back to whichever half is present', () => {
    expect(legacyListName('Work', '')).toBe('Work');
    expect(legacyListName('', 'VPA')).toBe('VPA');
    expect(legacyListName('', '')).toBe('');
  });
});

describe('pickMajoritySource', () => {
  it('returns local for no provider at all', () => {
    expect(pickMajoritySource(new Map(), 'P')).toBe('local');
    expect(pickMajoritySource(new Map([['local', 9]]), 'P')).toBe('local');
  });

  it('returns the single provider', () => {
    expect(pickMajoritySource(new Map([['ms-todo', 1]]), 'P')).toBe('ms-todo');
  });

  it('returns the heavier provider and falls back to local on a tie', () => {
    expect(pickMajoritySource(new Map([['ms-todo', 3], ['jira', 2]]), 'P')).toBe('ms-todo');
    expect(pickMajoritySource(new Map([['ms-todo', 2], ['jira', 2]]), 'P')).toBe('local');
  });
});

// ── 2. Full v4 → v5 migration ──────────────────────────────────────────────

describe('task-db v5 migration', () => {
  it('drops the category column, the index and task_categories', () => {
    buildStandardFixture();
    getDb();

    const cols = (getDb()!.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('category');
    expect(cols).toContain('project');
    expect(tableExists('task_categories')).toBe(false);
    expect(tableExists('task_projects')).toBe(true);

    const indexes = (
      getDb()!
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'tasks'")
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).not.toContain('tasks_category_project');

    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
  });

  it('promotes degenerate groups and routes Quick Start / Inbox to Inbox', () => {
    buildStandardFixture();
    const db = getDb()!;
    const projectOf = (id: string) =>
      (db.prepare('SELECT project FROM tasks WHERE id = ?').get(id) as { project: string }).project;

    expect(projectOf('t1')).toBe('Work');
    expect(projectOf('t2')).toBe('Work');
    expect(projectOf('t3')).toBe('Personal');
    expect(projectOf('t4')).toBe('');
    expect(projectOf('t5')).toBe('');
    expect(projectOf('t10')).toBe('Acme');
  });

  it('promotes a NULL project the same as an empty one, and leaves no NULL behind', () => {
    // v4's project column was NULLABLE, so a real DB carries both '' and NULL for
    // "no project". They are separate GROUP BY rows, and the rewrite's WHERE has
    // to use `IS` (not `=`) to match NULL at all — with `=` the row is skipped
    // and stays NULL forever, which then reads as Inbox instead of "Personal".
    buildStandardFixture();
    const db = getDb()!;

    expect(
      (db.prepare('SELECT project FROM tasks WHERE id = ?').get('t12') as { project: string }).project,
    ).toBe('Personal');

    // Both Personal rows landed on the same project (the NULL one did not fork).
    expect(db.prepare("SELECT COUNT(*) AS n FROM tasks WHERE project = 'Personal'").get()).toEqual({ n: 2 });
    // One registry row, not two.
    expect([...readProjects().keys()].filter((k) => k === 'Personal')).toHaveLength(1);
  });

  it('leaves a NULL project NULL when its target is Inbox, and grants it no row', () => {
    // The rewrite skips groups whose target already equals the current value
    // (`(g.project ?? '') === g.final`), so a NULL Inbox row is NOT rewritten to
    // ''. That is fine but LOAD-BEARING: NULL and '' both mean Inbox, so every
    // reader must be null-safe — rowToTask coerces to '' and the SQL Inbox filter
    // is `(project IS NULL OR project = '')`. Pin the raw state here so anyone
    // tightening those predicates to a bare `project = ''` sees this break.
    buildV4Db([{ id: 'n1', title: 'null inbox', category: 'Inbox', project: null }], [['Inbox', 'local']]);
    getDb();

    const raw = getDb()!.prepare('SELECT project FROM tasks WHERE id = ?').get('n1') as { project: string | null };
    expect(raw.project).toBeNull();
    // Which the null-safe Inbox predicate still finds.
    expect(
      getDb()!.prepare("SELECT COUNT(*) AS n FROM tasks WHERE (project IS NULL OR project = '')").get(),
    ).toEqual({ n: 1 });
    // Inbox never earns a registry row.
    expect(readProjects().size).toBe(0);
  });

  it('merges case-variant projects onto the spelling with the most tasks', () => {
    buildStandardFixture();
    const db = getDb()!;
    const rows = db
      .prepare("SELECT DISTINCT project FROM tasks WHERE project <> '' ORDER BY project")
      .all() as { project: string }[];
    expect(rows.map((r) => r.project)).toEqual(['Acme', 'Marina', 'Personal', 'Work']);

    // The lowercase spelling loses (1 task vs 3) and its task moves over.
    const marinaCount = db
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE project = 'Marina'")
      .get() as { n: number };
    expect(marinaCount.n).toBe(4);

    const projects = readProjects();
    expect([...projects.keys()].sort()).toEqual(['Acme', 'Marina', 'Personal', 'Work']);
  });

  it('registers one row per project with inherited source and legacy_category', () => {
    buildStandardFixture();
    getDb();
    const projects = readProjects();

    expect(projects.get('Work')!.source).toBe('local');
    expect(projects.get('Work')!.meta.legacy_category).toBe('Work');
    expect(projects.get('Personal')!.meta.legacy_category).toBe('Personal');

    // Marina was contributed by two categories → both recorded.
    expect(projects.get('Marina')!.meta.legacy_category).toEqual(['Personal', 'Work']);
    expect(projects.get('Marina')!.source).toBe('local');

    // The ms-todo category's claim moves down onto the project.
    expect(projects.get('Acme')!.source).toBe('ms-todo');
    expect(projects.get('Acme')!.meta.legacy_category).toBe('Sync');

    // order_index expands the old category order, alphabetical within a category.
    expect(projects.get('Marina')!.order_index).toBe(0);
    expect(projects.get('Work')!.order_index).toBe(1);
    expect(projects.get('Personal')!.order_index).toBe(2);
    expect(projects.get('Acme')!.order_index).toBe(3);
  });

  it('absorbs sentinel metadata tasks into the registry and deletes the rows', () => {
    buildStandardFixture();
    const db = getDb()!;
    const sentinels = db
      .prepare(
        "SELECT COUNT(*) AS n FROM tasks WHERE title IN ('.metadata_project', '.metadata_category')",
      )
      .get() as { n: number };
    expect(sentinels.n).toBe(0);

    const projects = readProjects();
    // Project-level sentinel → the project it belonged to.
    expect(projects.get('Marina')!.meta.default_cwd).toBe('/tmp/marina');
    // Category-level sentinel → every project that category contributed to.
    expect(projects.get('Marina')!.meta.default_host).toBe('workbox');
    expect(projects.get('Work')!.meta.default_host).toBe('workbox');
    // …and nothing else.
    expect(projects.get('Acme')!.meta.default_host).toBeUndefined();
  });

  it('pre-seeds remote_list only when the old MS To-Do list name differed', () => {
    buildStandardFixture();
    getDb();
    const projects = readProjects();
    // Old list name was "Sync / Acme"; the new project name is "Acme".
    expect(projects.get('Acme')!.meta.remote_list).toBe('Sync / Acme');
    // Local projects never get an alias.
    expect(projects.get('Work')!.meta.remote_list).toBeUndefined();
    expect(projects.get('Marina')!.meta.remote_list).toBeUndefined();
  });

  it('omits remote_list when the legacy list name already equals the project name', () => {
    // Degenerate ms-todo group: buildListName("Acme","Acme") was just "Acme".
    buildV4Db(
      [{ id: 's1', title: 'a', category: 'Acme', project: 'Acme', source: 'ms-todo' }],
      [['Acme', 'ms-todo']],
    );
    getDb();
    const row = readProjects().get('Acme')!;
    expect(row.source).toBe('ms-todo');
    expect(row.meta.remote_list).toBeUndefined();
  });

  it('writes a whole-file backup and never overwrites an existing one', () => {
    buildStandardFixture();
    getDb();
    expect(fs.existsSync(TASK_DB_PRE_V5_BACKUP_PATH)).toBe(true);

    // A v4 backup must be readable as v4 — i.e. it is a real pre-migration copy.
    const backup = new Database(TASK_DB_PRE_V5_BACKUP_PATH, { readonly: true });
    const backupCols = (backup.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    backup.close();
    expect(backupCols).toContain('category');

    // Second migration attempt on a fresh v4 fixture must not clobber the first
    // snapshot (it's the only pristine copy the user has).
    const sentinel = 'FIRST-BACKUP';
    fs.writeFileSync(TASK_DB_PRE_V5_BACKUP_PATH, sentinel);
    closeDb();
    fs.rmSync(TASK_DB_PATH, { force: true });
    fs.rmSync(`${TASK_DB_PATH}-wal`, { force: true });
    fs.rmSync(`${TASK_DB_PATH}-shm`, { force: true });
    buildStandardFixture();
    getDb();
    expect(fs.readFileSync(TASK_DB_PRE_V5_BACKUP_PATH, 'utf-8')).toBe(sentinel);
  });

  it('is idempotent — reopening, and even a forced re-run, changes nothing', () => {
    buildStandardFixture();
    getDb();
    const first = JSON.stringify([...readProjects().entries()]);
    const firstTasks = getDb()!
      .prepare('SELECT id, project FROM tasks ORDER BY id')
      .all() as unknown[];

    // Run #2: plain reopen (the normal server-restart path).
    closeDb();
    getDb();
    expect(JSON.stringify([...readProjects().entries()])).toBe(first);
    expect(getDb()!.prepare('SELECT id, project FROM tasks ORDER BY id').all()).toEqual(firstTasks);

    // Run #3: force the branch to execute again by rewinding user_version. The
    // column sniff must make it a no-op rather than double-migrating.
    getDb()!.pragma('user_version = 4');
    closeDb();
    getDb();
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(JSON.stringify([...readProjects().entries()])).toBe(first);
    expect(getDb()!.prepare('SELECT id, project FROM tasks ORDER BY id').all()).toEqual(firstTasks);
  });

  it('is a no-op on a fresh database (no backup, empty registry)', () => {
    getDb();
    expect(getDb()!.pragma('user_version', { simple: true })).toBe(SCHEMA_VERSION);
    expect(fs.existsSync(TASK_DB_PRE_V5_BACKUP_PATH)).toBe(false);
    expect(readProjects().size).toBe(0);
    const cols = (getDb()!.prepare('PRAGMA table_info(tasks)').all() as { name: string }[]).map(
      (c) => c.name,
    );
    expect(cols).not.toContain('category');
    expect(tableExists('task_categories')).toBe(false);
  });

  it('keeps a project whose only row was a project-level sentinel', () => {
    buildV4Db(
      [
        {
          id: 'm1',
          title: '.metadata_project',
          category: 'Work',
          project: 'Orphan',
          description: 'default_cwd: /tmp/orphan\n',
        },
      ],
      [['Work', 'local']],
    );
    getDb();
    const row = readProjects().get('Orphan');
    expect(row).toBeDefined();
    expect(row!.meta.default_cwd).toBe('/tmp/orphan');
    expect(getDb()!.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
  });

  it('gives a merged project to the provider owning most of its tasks', () => {
    // Real-data shape: a big ms-todo group plus one stray task filed under
    // another provider's category. Weighting by distinct category would call
    // this project `local` and pushTask would then refuse all 3 ms-todo tasks.
    buildV4Db(
      [
        { id: 'a1', title: 'a', category: 'SyncA', project: 'Shared', source: 'ms-todo' },
        { id: 'a2', title: 'b', category: 'SyncA', project: 'Shared', source: 'ms-todo' },
        { id: 'a3', title: 'c', category: 'SyncA', project: 'Shared', source: 'ms-todo' },
        { id: 'b1', title: 'd', category: 'SyncB', project: 'Shared', source: 'jira' },
      ],
      [
        ['SyncA', 'ms-todo'],
        ['SyncB', 'jira'],
      ],
    );
    getDb();
    const row = readProjects().get('Shared')!;
    expect(row.source).toBe('ms-todo');
    // The majority provider's legacy list name becomes the push alias.
    expect(row.meta.remote_list).toBe('SyncA / Shared');
    expect(row.meta.legacy_category).toEqual(['SyncA', 'SyncB']);
  });

  it('falls back to local when merged categories bring conflicting providers', () => {
    buildV4Db(
      [
        { id: 'a1', title: 'a', category: 'SyncA', project: 'Shared', source: 'ms-todo' },
        { id: 'b1', title: 'b', category: 'SyncB', project: 'Shared', source: 'jira' },
      ],
      [
        ['SyncA', 'ms-todo'],
        ['SyncB', 'jira'],
      ],
    );
    getDb();
    const row = readProjects().get('Shared')!;
    expect(row.source).toBe('local');
    expect(row.meta.remote_list).toBeUndefined();
    expect(row.meta.legacy_category).toEqual(['SyncA', 'SyncB']);
  });

  it('a GENUINE 2-vs-2 provider tie falls back to local and warns loudly', () => {
    // 1-vs-1 (above) can't tell "tie" apart from "one weak provider": both
    // branches produce `local`. Only a multi-task tie proves the comparison is
    // `ranked[0] > ranked[1]` on WEIGHT rather than, say, list length — and only
    // this shape reaches the tie warning, which is the operator's one clue that a
    // project silently lost its provider claim (pushTask will refuse its tasks).
    const warn = vi.spyOn(log.task, 'warn');
    buildTiedProvidersFixture();
    getDb();

    const row = readProjects().get('Shared')!;
    expect(row.source).toBe('local');
    expect(row.meta.remote_list).toBeUndefined();
    expect(row.meta.legacy_category).toEqual(['SyncA', 'SyncB']);

    const tie = warn.mock.calls.find(([msg]) => String(msg).includes('tied sources'));
    expect(tie, 'expected a "tied sources, using local" warning').toBeTruthy();
    expect(tie![1]).toMatchObject({ project: 'Shared' });
    // Both providers' weights are reported, so the warning is actionable.
    expect(tie![1]!.weights).toEqual({ 'ms-todo': 2, jira: 2 });

    // A tie must NOT also claim a majority.
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('majority wins'))).toBe(false);
    warn.mockRestore();
  });

  it('a 3-vs-2 majority still wins (proves the tie branch is weight-based)', () => {
    const warn = vi.spyOn(log.task, 'warn');
    buildV4Db(
      [
        { id: 'a1', title: 'a', category: 'SyncA', project: 'Shared', source: 'ms-todo' },
        { id: 'a2', title: 'b', category: 'SyncA', project: 'Shared', source: 'ms-todo' },
        { id: 'a3', title: 'c', category: 'SyncA', project: 'Shared', source: 'ms-todo' },
        { id: 'b1', title: 'd', category: 'SyncB', project: 'Shared', source: 'jira' },
        { id: 'b2', title: 'e', category: 'SyncB', project: 'Shared', source: 'jira' },
      ],
      [
        ['SyncA', 'ms-todo'],
        ['SyncB', 'jira'],
      ],
    );
    getDb();

    expect(readProjects().get('Shared')!.source).toBe('ms-todo');
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('majority wins'))).toBe(true);
    expect(warn.mock.calls.some(([msg]) => String(msg).includes('tied sources'))).toBe(false);
    warn.mockRestore();
  });

  // ── Minority-source normalization ────────────────────────────────────────
  // A project row names exactly ONE source, and pushTask hard-refuses any task
  // whose source differs from its project's claim. So after the merge every task
  // in the project must be restamped to the winning source, with its now-invalid
  // provider `ext` (the remote row id, which belongs to the LOSING provider's
  // backend) cleared — otherwise those tasks are permanently unpushable and the
  // stale ext can dedup-collide with a genuine row later.
  //
  // The third case ("leaves an untouched single-provider project fully alone") is
  // the guardrail: no merge, no minority ⇒ nothing may be rewritten.
  it('restamps minority-source tasks onto the winning source and clears their ext', () => {
    buildV4Db(
      [
        { id: 'a1', title: 'a', category: 'SyncA', project: 'Shared', source: 'ms-todo', ext: { 'ms-todo': { id: 'remote-a1' } } },
        { id: 'a2', title: 'b', category: 'SyncA', project: 'Shared', source: 'ms-todo', ext: { 'ms-todo': { id: 'remote-a2' } } },
        { id: 'a3', title: 'c', category: 'SyncA', project: 'Shared', source: 'ms-todo', ext: { 'ms-todo': { id: 'remote-a3' } } },
        { id: 'b1', title: 'd', category: 'SyncB', project: 'Shared', source: 'jira', ext: { jira: { id: 'JIRA-1' } } },
      ],
      [
        ['SyncA', 'ms-todo'],
        ['SyncB', 'jira'],
      ],
    );
    getDb();
    expect(readProjects().get('Shared')!.source).toBe('ms-todo');

    const rows = getDb()!
      .prepare('SELECT id, source, ext FROM tasks ORDER BY id')
      .all() as { id: string; source: string; ext: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r]));

    // The lone jira task is the minority → restamped, ext dropped.
    expect(byId.get('b1')!.source).toBe('ms-todo');
    expect(byId.get('b1')!.ext ?? null).toBeNull();

    // The winners keep BOTH their source and their still-valid remote ids.
    for (const id of ['a1', 'a2', 'a3']) {
      expect(byId.get(id)!.source).toBe('ms-todo');
      expect(JSON.parse(byId.get(id)!.ext!)).toEqual({ 'ms-todo': { id: `remote-${id}` } });
    }
  });

  it('restamps every provider task to local when the sources tie', () => {
    // A tie hands the project to `local`, so BOTH providers are minorities —
    // all four tasks must become local with their remote ids dropped, or the
    // project ends up holding tasks no provider will accept.
    buildTiedProvidersFixture();
    getDb();
    expect(readProjects().get('Shared')!.source).toBe('local');

    const rows = getDb()!
      .prepare('SELECT id, source, ext FROM tasks ORDER BY id')
      .all() as { id: string; source: string; ext: string | null }[];
    expect(rows.map((r) => r.source)).toEqual(['local', 'local', 'local', 'local']);
    expect(rows.every((r) => (r.ext ?? null) === null)).toBe(true);
  });

  it('leaves an untouched single-provider project fully alone', () => {
    // Guardrail on the normalization above: no merge, no minority, so nothing
    // may be rewritten — a blanket UPDATE would strip working remote ids.
    buildV4Db(
      [{ id: 'a1', title: 'a', category: 'SyncA', project: 'Solo', source: 'ms-todo', ext: { 'ms-todo': { id: 'keep-me' } } }],
      [['SyncA', 'ms-todo']],
    );
    getDb();
    expect(readProjects().get('Solo')!.source).toBe('ms-todo');
    const row = getDb()!.prepare('SELECT source, ext FROM tasks WHERE id = ?').get('a1') as { source: string; ext: string | null };
    expect(row.source).toBe('ms-todo');
    expect(JSON.parse(row.ext!)).toEqual({ 'ms-todo': { id: 'keep-me' } });
  });

  // ── Provider-sourced tasks that land in Inbox ────────────────────────────

  it('resets provider-sourced tasks routed to Inbox back to local', () => {
    // "Quick Start under a provider-claimed category" is the real shape: the group
    // routes to Inbox (''), which has NO registry row and can never be claimed.
    // Leaving them ms-todo would make pushTask refuse them forever, AND leave a
    // state addTaskFull/validateProjectSource would reject on create.
    const warn = vi.spyOn(log.task, 'warn');
    buildV4Db(
      [
        { id: 'q1', title: 'captured', category: 'Sync', project: 'Quick Start', source: 'ms-todo', ext: { 'ms-todo': { id: 'remote-q1' } } },
        { id: 'i1', title: 'loose', category: 'Inbox', project: 'Inbox', source: 'ms-todo', ext: { 'ms-todo': { id: 'remote-i1' } } },
        // Control: a real project keeps its claim and its remote id.
        { id: 'k1', title: 'keeper', category: 'Sync', project: 'Acme', source: 'ms-todo', ext: { 'ms-todo': { id: 'remote-k1' } } },
      ],
      [['Sync', 'ms-todo'], ['Inbox', 'local']],
    );
    getDb();

    const rows = getDb()!
      .prepare('SELECT id, project, source, ext FROM tasks ORDER BY id')
      .all() as { id: string; project: string | null; source: string; ext: string | null }[];
    const byId = new Map(rows.map((r) => [r.id, r]));

    for (const id of ['q1', 'i1']) {
      expect(byId.get(id)!.project ?? '').toBe('');
      expect(byId.get(id)!.source).toBe('local');
      expect(byId.get(id)!.ext ?? null).toBeNull();
    }
    expect(byId.get('k1')!.source).toBe('ms-todo');
    expect(JSON.parse(byId.get('k1')!.ext!)).toEqual({ 'ms-todo': { id: 'remote-k1' } });

    // Inbox never earns a registry row, even though provider tasks landed there.
    expect([...readProjects().keys()].sort()).toEqual(['Acme']);

    const reset = warn.mock.calls.find(([msg]) => String(msg).includes('provider-sourced Inbox tasks'));
    expect(reset, 'expected a provider-in-Inbox reset warning').toBeTruthy();
    expect(reset![1]).toMatchObject({ tasks: 2, from: { 'ms-todo': 2 } });
    warn.mockRestore();
  });

  it('leaves already-local Inbox tasks untouched (no blanket rewrite)', () => {
    buildV4Db(
      [{ id: 'l1', title: 'local inbox', category: 'Inbox', project: 'Inbox', source: 'local' }],
      [['Inbox', 'local']],
    );
    const warn = vi.spyOn(log.task, 'warn');
    getDb();
    const row = getDb()!
      .prepare('SELECT project, source, updated_at FROM tasks WHERE id = ?')
      .get('l1') as { project: string | null; source: string; updated_at: string | null };
    expect(row.project ?? '').toBe('');
    expect(row.source).toBe('local');
    // The reset pass did not touch this row — it only fires (and warns) for
    // provider-sourced Inbox tasks. (updated_at is no longer a usable proxy:
    // the v9 timestamp backfill legitimately fills NULLs on every row.)
    const reset = warn.mock.calls.find(([msg]) => String(msg).includes('provider-sourced Inbox tasks'));
    expect(reset).toBeUndefined();
    warn.mockRestore();
  });

  it('migrates a v4 db with no task_categories table at all', () => {
    fs.mkdirSync(TASKS_DIR, { recursive: true });
    const db = new Database(TASK_DB_PATH);
    db.exec(V4_SCHEMA_SQL);
    db.exec('DROP TABLE task_categories;');
    db.prepare(
      `INSERT INTO tasks (id, title, category, project, status, phase, priority, source)
       VALUES ('x1', 'x', 'Loose', 'Loose', 'todo', 'TODO', 'none', 'local')`,
    ).run();
    db.pragma('user_version = 4');
    db.close();

    getDb();
    const row = readProjects().get('Loose')!;
    expect(row.source).toBe('local');
    expect(
      (getDb()!.prepare("SELECT project FROM tasks WHERE id = 'x1'").get() as { project: string })
        .project,
    ).toBe('Loose');
  });
});
