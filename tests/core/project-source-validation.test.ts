/**
 * Project registry + claim tests (the project-only replacement for the retired
 * category-source validation suite).
 *
 * Covers the three rules that define the model:
 *  - a new project name auto-creates its registry row (ensureProject / addTask)
 *  - a project claimed by a provider rejects a task of a different source
 *    (ProjectSourceConflictError)
 *  - Inbox ('') has no row and can NEVER be claimed
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-project-source'));

// renameProject renames the ms-todo LIST once (instead of pushing N tasks, which
// would fork a second list). Stub the plugin module so we can assert the call
// shape without touching Graph. Factory-mocked, so the real module — which imports
// task-manager back — never loads.
const mockRenameListByName = vi.fn(async (_old: string, _next: string) => ({ id: 'l1', displayName: _next }));
vi.mock('../../src/integrations/microsoft-todo.js', () => ({
  renameListByName: (...a: [string, string]) => mockRenameListByName(...a),
  resolveListIdForTask: vi.fn(async () => 'list-id'),
}));

import {
  addTask,
  updateTask,
  getTask,
  ensureProject,
  getStoreProjects,
  getProjectRecord,
  getProjectMetadata,
  setProjectMetadata,
  renameProject,
  deleteProject,
  remoteListNameFor,
  validateProjectSource,
  assertValidProjectName,
  ProjectSourceConflictError,
  InvalidProjectNameError,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb, getDb } from '../../src/core/task-db.js';
import { getConfig, saveConfig } from '../../src/core/config-manager.js';
import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { createMockPlugin } from './plugin-test-utils.js';

const PLUGIN_SOURCES = ['ms-todo', 'plugin-a', 'plugin-b'];

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  mockRenameListByName.mockClear();
  mockRenameListByName.mockImplementation(async (_old: string, next: string) => ({ id: 'l1', displayName: next }));
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  for (const id of PLUGIN_SOURCES) {
    if (!registry.has(id)) registry.register(id, createMockPlugin({ id }));
  }
  // renameProject reaches the remote container ONLY through the plugin's
  // renameProjectRemote hook now (core never imports an integration) — wire the
  // ms-todo mock's hook to the same spy the module mock uses.
  registry.get('ms-todo')!.sync.renameProjectRemote = async ({ oldRemoteName, newName }) => {
    await mockRenameListByName(oldRemoteName, newName);
  };
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ── validateProjectSource (pure) ──

describe('validateProjectSource', () => {
  it('accepts a local task in Inbox and rejects every provider there', () => {
    expect(validateProjectSource('', 'local', {})).toEqual({ ok: true });
    const result = validateProjectSource('', 'ms-todo', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('inbox_local_only');
      expect(result.existingSource).toBe('local');
    }
  });

  it('treats plugins.<id>.project as a hard reservation', () => {
    const config = { plugins: { 'plugin-a': { project: 'Marina' } } };
    expect(validateProjectSource('Marina', 'plugin-a', config)).toEqual({ ok: true });
    const result = validateProjectSource('marina', 'local', config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('config_plugin');
      expect(result.existingSource).toBe('plugin-a');
    }
  });

  it('reports the registry claim as a soft (migratable) conflict', () => {
    const projects = { Marina: { source: 'ms-todo' } };
    const result = validateProjectSource('MARINA', 'local', {}, projects);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('registry');
      expect(result.existingSource).toBe('ms-todo');
    }
    expect(validateProjectSource('marina', 'ms-todo', {}, projects)).toEqual({ ok: true });
  });
});

// ── ensureProject ──

describe('ensureProject', () => {
  it('creates a row once and is idempotent, case-insensitively', async () => {
    const first = await ensureProject('Marina');
    expect(first).toMatchObject({ name: 'Marina', source: 'local', created: true });

    const second = await ensureProject('marina', 'ms-todo');
    // Existing row wins: neither the spelling nor the claim can be overwritten
    // by a later caller passing a different source.
    expect(second).toMatchObject({ name: 'Marina', source: 'local', created: false });

    const projects = await getStoreProjects();
    expect(Object.keys(projects)).toEqual(['Marina']);
  });

  it('never registers Inbox', async () => {
    const result = await ensureProject('');
    expect(result).toMatchObject({ name: '', created: false });
    expect(await getStoreProjects()).toEqual({});
    expect(await getProjectRecord('')).toBeNull();
  });
});

// ── addTask ──

describe('addTask project registration', () => {
  it('auto-creates the registry row for a new project name', async () => {
    const { task } = await addTask({ title: 'Ship it', project: 'Marina' });
    expect(task.project).toBe('Marina');
    expect(task.source).toBe('local');

    const record = await getProjectRecord('marina');
    expect(record).toMatchObject({ name: 'Marina', source: 'local' });
  });

  it('folds a differently-cased name onto the canonical spelling', async () => {
    await addTask({ title: 'First', project: 'Marina' });
    const { task } = await addTask({ title: 'Second', project: 'MARINA' });
    expect(task.project).toBe('Marina');
    expect(Object.keys(await getStoreProjects())).toEqual(['Marina']);
  });

  it('leaves project empty (Inbox) when none is given', async () => {
    const { task } = await addTask({ title: 'Loose thought' });
    expect(task.project).toBe('');
    expect(task.source).toBe('local');
    expect(await getStoreProjects()).toEqual({});
  });

  it('inherits the claimed project source', async () => {
    await ensureProject('Synced', 'ms-todo');
    const { task } = await addTask({ title: 'Remote work', project: 'Synced' });
    expect(task.source).toBe('ms-todo');
  });

  it('lets the registry claim outrank an input.source override', async () => {
    // The project's claim is the source of record: a caller naming a claimed
    // project gets that provider, not a 409 — the task must be pushable to live
    // there at all. input.source only decides an unregistered name.
    await ensureProject('Synced', 'ms-todo');
    const { task } = await addTask({ title: 'Wrong owner', project: 'Synced', source: 'plugin-a' });
    expect(task.source).toBe('ms-todo');
  });

  it('throws ProjectSourceConflictError when an inherited parent source clashes', async () => {
    await ensureProject('A-owned', 'plugin-a');
    await ensureProject('B-owned', 'plugin-b');
    const { task: parent } = await addTask({ title: 'Parent', project: 'A-owned' });
    expect(parent.source).toBe('plugin-a');

    await expect(
      addTask({ title: 'Child', project: 'B-owned', parent_task_id: parent.id }),
    ).rejects.toThrow(ProjectSourceConflictError);
  });

  it('seeds a plugins.<id>.project reservation into the registry and routes tasks to it', async () => {
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    await fs.writeFile(
      CONFIG_FILE,
      'version: 1\ndefaults:\n  priority: none\nplugins:\n  plugin-a:\n    project: Reserved\n',
      'utf-8',
    );
    // seedProjectsFromConfig (ensureInit) materializes the reservation as a
    // claimed registry row, so the claim is enforced by the registry branch and
    // input.source cannot override it.
    const { task } = await addTask({ title: 'Reserved work', project: 'reserved', source: 'local' });
    expect(task.project).toBe('Reserved');
    expect(task.source).toBe('plugin-a');
    expect(await getProjectRecord('Reserved')).toMatchObject({ source: 'plugin-a' });
  });

  it('refuses to create a provider task in Inbox', async () => {
    await expect(
      addTask({ title: 'Nowhere', source: 'ms-todo' }),
    ).rejects.toThrow(/Inbox/);
  });

  it('inherits the parent task project and source', async () => {
    await ensureProject('Synced', 'ms-todo');
    const { task: parent } = await addTask({ title: 'Parent', project: 'Synced' });
    const { task: child } = await addTask({ title: 'Child', parent_task_id: parent.id });
    expect(child.project).toBe('Synced');
    expect(child.source).toBe('ms-todo');
  });
});

// ── updateTask project moves ──

describe('updateTask project move', () => {
  it('migrates a provider task to local when moved to Inbox', async () => {
    await ensureProject('Synced', 'ms-todo');
    const { task } = await addTask({ title: 'Move me', project: 'Synced' });
    expect(task.source).toBe('ms-todo');

    await updateTask(task.id, { project: '' });
    const moved = await getTask(task.id);
    expect(moved.project).toBe('');
    expect(moved.source).toBe('local');
  });

  it('adopts the destination project claim', async () => {
    await ensureProject('Claimed', 'ms-todo');
    const { task } = await addTask({ title: 'Local task', project: 'Freeform' });
    expect(task.source).toBe('local');

    await updateTask(task.id, { project: 'Claimed' });
    const moved = await getTask(task.id);
    expect(moved.project).toBe('Claimed');
    expect(moved.source).toBe('ms-todo');
  });

  it('auto-creates the registry row for a brand-new destination', async () => {
    const { task } = await addTask({ title: 'Wandering' });
    await updateTask(task.id, { project: 'Brand New' });
    expect(await getProjectRecord('brand new')).toMatchObject({ name: 'Brand New', source: 'local' });
  });
});

// ── metadata + rename ──

describe('project metadata', () => {
  it('stores settings on the registry row, not a sentinel task', async () => {
    const merged = await setProjectMetadata('Marina', { default_cwd: '/tmp/marina' });
    expect(merged).toMatchObject({ default_cwd: '/tmp/marina' });

    const again = await setProjectMetadata('marina', { default_host: 'devbox' });
    expect(again).toMatchObject({ default_cwd: '/tmp/marina', default_host: 'devbox' });
    expect(await getProjectMetadata('MARINA')).toMatchObject({
      default_cwd: '/tmp/marina', default_host: 'devbox',
    });

    // No sentinel rows anywhere in the task table.
    const rows = getDb()!
      .prepare("SELECT COUNT(*) AS n FROM tasks WHERE title LIKE '.metadata%'")
      .get() as { n: number };
    expect(rows.n).toBe(0);
  });

  it('rejects settings on Inbox', async () => {
    await expect(setProjectMetadata('', { default_cwd: '/tmp' })).rejects.toThrow(/Inbox/);
  });

  it('resolves the remote list name through the remote_list alias', async () => {
    await ensureProject('Marina', 'ms-todo');
    expect(await remoteListNameFor('Marina')).toBe('Marina');
    await setProjectMetadata('Marina', { remote_list: 'Work / Marina' });
    expect(await remoteListNameFor('Marina')).toBe('Work / Marina');
  });
});

describe('renameProject', () => {
  it('moves every task and the registry row', async () => {
    await addTask({ title: 'A', project: 'Old' });
    await addTask({ title: 'B', project: 'Old' });
    await setProjectMetadata('Old', { default_cwd: '/tmp/old' });

    const { count, merged } = await renameProject('Old', 'New');
    expect({ count, merged }).toEqual({ count: 2, merged: false });

    const projects = await getStoreProjects();
    expect(Object.keys(projects)).toEqual(['New']);
    expect(await getProjectMetadata('New')).toMatchObject({ default_cwd: '/tmp/old' });
  });

  it('merges into an existing project on collision', async () => {
    await addTask({ title: 'A', project: 'Alpha' });
    await addTask({ title: 'B', project: 'Beta' });

    const { count, merged } = await renameProject('Alpha', 'Beta');
    expect({ count, merged }).toEqual({ count: 1, merged: true });
    expect(Object.keys(await getStoreProjects())).toEqual(['Beta']);
  });

  it('refuses to merge into a project owned by another provider', async () => {
    await ensureProject('Mine', 'local');
    await addTask({ title: 'A', project: 'Mine' });
    await ensureProject('Theirs', 'ms-todo');

    await expect(renameProject('Mine', 'Theirs')).rejects.toThrow(ProjectSourceConflictError);
  });

  it('refuses to rename Inbox or rename onto an empty name', async () => {
    await expect(renameProject('', 'Something')).rejects.toThrow(/Inbox/);
    await addTask({ title: 'A', project: 'Real' });
    await expect(renameProject('Real', '   ')).rejects.toThrow(/non-empty/);
  });
});

// ── Project-name SHAPE validation ──────────────────────────────────────────
// A project name becomes a filesystem path segment (memory/projects/<project>/,
// and it flows into session cwd resolution), so path metacharacters are a
// traversal hole rather than a cosmetic issue.

describe('assertValidProjectName', () => {
  const bad: Array<[string, string, RegExp]> = [
    ['forward slash', 'work/api', /path separators/],
    ['backslash', 'work\\api', /path separators/],
    ['parent traversal', '../../.ssh', /path separators/],   // caught by the '/' rule first
    ['bare dot-dot', 'a..b', /'\.\.' is not allowed/],
    ['NUL byte', 'work\u0000evil', /NUL character/],
    ['leading dot', '.metadata_project', /cannot start with/],
    ['leading dot (hidden dir)', '.ssh', /cannot start with/],
    ['empty', '   ', /non-empty/],
  ];

  for (const [label, name, pattern] of bad) {
    it(`rejects ${label}`, () => {
      expect(() => assertValidProjectName(name)).toThrow(InvalidProjectNameError);
      expect(() => assertValidProjectName(name)).toThrow(pattern);
    });
  }

  it('accepts ordinary names, trims, and allows inner dots / spaces / CJK', () => {
    expect(assertValidProjectName('  Marina  ')).toBe('Marina');
    expect(assertValidProjectName('walnut.dev')).toBe('walnut.dev');
    expect(assertValidProjectName('Q3 Planning')).toBe('Q3 Planning');
    expect(assertValidProjectName('项目A')).toBe('项目A');
    expect(assertValidProjectName('50% done')).toBe('50% done');
  });
});

describe('project name validation at the API surface', () => {
  it('ensureProject rejects a traversal name and creates nothing', async () => {
    await expect(ensureProject('../../.ssh')).rejects.toThrow(InvalidProjectNameError);
    expect(await getStoreProjects()).toEqual({});
  });

  it('ensureProject still treats Inbox ("") as a legal no-op, not a bad shape', async () => {
    // '' short-circuits BEFORE shape validation — it is the legal ABSENCE of a
    // project, never a row and never a directory.
    await expect(ensureProject('')).resolves.toMatchObject({ name: '', created: false });
    await expect(ensureProject('   ')).resolves.toMatchObject({ name: '', created: false });
  });

  it('renameProject rejects a bad TARGET but leaves the project intact', async () => {
    await addTask({ title: 'A', project: 'Real' });
    await expect(renameProject('Real', 'evil/../x')).rejects.toThrow(InvalidProjectNameError);
    expect(Object.keys(await getStoreProjects())).toEqual(['Real']);
  });

  it('renameProject still allows renaming AWAY from a bad legacy name', async () => {
    // Only the target is shape-checked: a project that already carries a bad name
    // (imported before this guard) must stay fixable.
    const db = getDb()!;
    await ensureProject('Ok');
    db.prepare('UPDATE task_projects SET name = ? WHERE name = ?').run('bad/name', 'Ok');
    const { count } = await renameProject('bad/name', 'Good');
    expect(count).toBe(0); // no tasks, registry row only
    expect(Object.keys(await getStoreProjects())).toEqual(['Good']);
  });
});

// ── renameProject: remote container rename (ms-todo) ───────────────────────
// A per-task push would resolve the NEW name, find no list, and CREATE one —
// forking the user's list in two. The container gets renamed ONCE instead.

describe('renameProject — ms-todo remote list', () => {
  it('renames the remote list once using the remote_list ALIAS, then repoints it', async () => {
    await ensureProject('Acme', 'ms-todo');
    await setProjectMetadata('Acme', { remote_list: 'Sync / Acme' });
    await addTask({ title: 'A', project: 'Acme' });
    await addTask({ title: 'B', project: 'Acme' });

    await renameProject('Acme', 'AcmeCorp');

    // ONE call, keyed on the alias (the list that actually exists remotely).
    expect(mockRenameListByName).toHaveBeenCalledTimes(1);
    expect(mockRenameListByName).toHaveBeenCalledWith('Sync / Acme', 'AcmeCorp');
    // Alias now points at the new list name, so pushes resolve one single list.
    expect(await remoteListNameFor('AcmeCorp')).toBe('AcmeCorp');
  });

  it('falls back to the old project NAME when there is no alias', async () => {
    await ensureProject('Acme', 'ms-todo');
    await addTask({ title: 'A', project: 'Acme' });

    await renameProject('Acme', 'AcmeCorp');
    expect(mockRenameListByName).toHaveBeenCalledWith('Acme', 'AcmeCorp');
  });

  it('KEEPS the old alias when the remote rename fails (pushes stay in the real list)', async () => {
    mockRenameListByName.mockRejectedValueOnce(new Error('Graph 403'));
    await ensureProject('Acme', 'ms-todo');
    await setProjectMetadata('Acme', { remote_list: 'Sync / Acme' });
    await addTask({ title: 'A', project: 'Acme' });

    await renameProject('Acme', 'AcmeCorp');

    // The alias must NOT have been dropped — otherwise the fallback per-task push
    // resolves "AcmeCorp", finds nothing, and creates a SECOND remote list.
    expect(await remoteListNameFor('AcmeCorp')).toBe('Sync / Acme');
  });

  it('does NOT rename a remote list on a MERGE (the target list already exists)', async () => {
    await ensureProject('Alpha', 'ms-todo');
    await ensureProject('Beta', 'ms-todo');
    await addTask({ title: 'A', project: 'Alpha' });
    await addTask({ title: 'B', project: 'Beta' });

    const { merged } = await renameProject('Alpha', 'Beta');
    expect(merged).toBe(true);
    expect(mockRenameListByName).not.toHaveBeenCalled();
  });

  it('does NOT touch anything remote for a local project', async () => {
    await addTask({ title: 'A', project: 'Local' });
    await renameProject('Local', 'Local2');
    expect(mockRenameListByName).not.toHaveBeenCalled();
  });
});

// ── Config name lists follow rename / delete ───────────────────────────────
// favorites.projects and ordering.projects are plain NAME lists, so a rename
// that skipped them silently unstarred the project and dropped it out of the
// user's hand-ordering.

describe('project rename/delete → config lists', () => {
  async function seedConfigLists(favorites: string[], ordering: string[]): Promise<void> {
    const config = await getConfig();
    await saveConfig({
      ...config,
      favorites: { ...(config.favorites ?? {}), projects: favorites },
      ordering: { ...(config.ordering ?? {}), projects: ordering },
    });
  }

  it('rewrites both lists on rename, matching case-insensitively', async () => {
    await addTask({ title: 'A', project: 'Old' });
    await seedConfigLists(['old', 'Other'], ['Other', 'OLD', 'Third']);

    await renameProject('Old', 'New');

    const config = await getConfig();
    expect(config.favorites?.projects).toEqual(['New', 'Other']);
    // Position is preserved — this is the user's hand-ordering.
    expect(config.ordering?.projects).toEqual(['Other', 'New', 'Third']);
  });

  it('dedupes NOCASE when a rename collapses onto an existing entry (merge)', async () => {
    await addTask({ title: 'A', project: 'Alpha' });
    await addTask({ title: 'B', project: 'Beta' });
    await seedConfigLists(['Alpha', 'Beta'], ['Alpha', 'beta']);

    await renameProject('Alpha', 'Beta');

    const config = await getConfig();
    expect(config.favorites?.projects).toEqual(['Beta']);
    expect(config.ordering?.projects).toEqual(['Beta']);
  });

  it('removes the entry on delete', async () => {
    await addTask({ title: 'A', project: 'Doomed' });
    await seedConfigLists(['Doomed', 'Keeper'], ['Keeper', 'doomed']);

    await deleteProject('Doomed');

    const config = await getConfig();
    expect(config.favorites?.projects).toEqual(['Keeper']);
    expect(config.ordering?.projects).toEqual(['Keeper']);
  });

  it('leaves unrelated config sections alone', async () => {
    await addTask({ title: 'A', project: 'Old' });
    const before = await getConfig();
    await saveConfig({
      ...before,
      favorites: { projects: ['Old'], notes: ['PARA/keep.md'] },
      defaults: { ...before.defaults, priority: 'immediate' },
    });

    await renameProject('Old', 'New');

    const after = await getConfig();
    expect(after.favorites?.projects).toEqual(['New']);
    expect(after.favorites?.notes).toEqual(['PARA/keep.md']);
    expect(after.defaults.priority).toBe('immediate');
  });

  it('does not write config at all when neither list mentions the project', async () => {
    await addTask({ title: 'A', project: 'Old' });
    await seedConfigLists(['Unrelated'], ['Unrelated']);

    await renameProject('Old', 'New');

    const config = await getConfig();
    expect(config.favorites?.projects).toEqual(['Unrelated']);
    expect(config.ordering?.projects).toEqual(['Unrelated']);
  });
});

// ── Unicode-case project identity ──────────────────────────────────────────

describe('project identity folds unicode case (JS side is the enforcer)', () => {
  it('does not create a second row for a unicode-case variant', async () => {
    // SQLite's COLLATE NOCASE folds ASCII A-Z only, so `WHERE name = ?` +
    // ON CONFLICT would have inserted a SECOND row here and split the project.
    // ensureProjectRowLocked does an explicit lowercased lookup instead.
    const first = await ensureProject('Ärger');
    expect(first).toMatchObject({ name: 'Ärger', created: true });

    const second = await ensureProject('ärger');
    expect(second).toMatchObject({ name: 'Ärger', created: false });
    expect(Object.keys(await getStoreProjects())).toEqual(['Ärger']);
  });

  it('routes metadata for a unicode-case variant onto the same row', async () => {
    await ensureProject('Ärger');
    await setProjectMetadata('ärger', { default_cwd: '/tmp/a' });
    expect(await getProjectMetadata('Ärger')).toMatchObject({ default_cwd: '/tmp/a' });
    expect(Object.keys(await getStoreProjects())).toEqual(['Ärger']);
  });
});
