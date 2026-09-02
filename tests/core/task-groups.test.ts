/**
 * Per-project FOLDERS (storage name: "group" — Task.group_id + store.task_groups).
 *
 * Covers the core store ops in task-manager.ts: groupTasks / addToGroup /
 * removeFromGroup / createFolder / deleteFolder / setFolderParent / renameGroup /
 * setGroupHidden / listGroups, plus the folder-model invariants:
 *  - a folder belongs to exactly ONE project ('' = Inbox is a real project):
 *    grouping or joining across projects throws ("A folder belongs to one
 *    project"); the compare is case-insensitive, matching the registry's
 *    COLLATE NOCASE
 *  - folders are NEVER auto-pruned: removing every member, deleting every member,
 *    or a donor folder losing its last task to another folder all leave the
 *    registry row in place with 0 members. Only deleteFolder removes one
 *  - an EMPTY folder is valid and listable (createFolder makes one)
 *  - folders nest via parent_id (same project, no cycles, depth ≤ FOLDER_MAX_DEPTH)
 *  - moving a task to another project auto-unfolders it (the folder is the
 *    project's private structure, so it never follows the task) — both on
 *    updateTask and on the raw sync path
 *  - moveFolderToProject is the inverse: moving the FOLDER carries its whole
 *    subtree (descendant folders + every member task, membership kept) and the
 *    moved folder becomes top-level in the destination
 *  - group_id round-trips through the SQLite payload blob (no dedicated column)
 *  - group_id is local-only (never part of a plugin push) — verified structurally
 *    by it living only in payload (covered by the round-trip test).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask,
  listTasks,
  getTask,
  deleteTask,
  updateTask,
  groupTasks,
  addToGroup,
  removeFromGroup,
  createFolder,
  deleteFolder,
  setFolderParent,
  moveFolderToProject,
  getProjectRecord,
  renameGroup,
  setGroupHidden,
  listGroups,
  updateTaskRaw,
  updateTasksBulk,
  FOLDER_MAX_DEPTH,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb, getDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { createMockPlugin, createNoopSync } from './plugin-test-utils.js';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

/** Create N tasks in the same project. Returns their ids. */
async function makeTasks(titles: string[], project = 'Marina'): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const { task } = await addTask({ title, project });
    ids.push(task.id);
  }
  return ids;
}

/** Raw payload blob for a task — proves what physically landed in SQLite. */
function rawPayload(id: string): string | null {
  const row = getDb()!.prepare('SELECT payload FROM tasks WHERE id = ?').get(id) as
    | { payload: string | null }
    | undefined;
  return row?.payload ?? null;
}

/** One folder from the listing, by id. */
async function folder(groupId: string) {
  return (await listGroups()).find((g) => g.group_id === groupId);
}

describe('groupTasks', () => {
  it('groups ≥2 same-project tasks under one group_id and records label + project', async () => {
    const [a, b] = await makeTasks(['Task A', 'Task B']);
    const result = await groupTasks([a, b], 'My Folder');

    expect(result.member_ids.sort()).toEqual([a, b].sort());
    expect(result.label).toBe('My Folder');

    const ta = await getTask(a);
    const tb = await getTask(b);
    expect(ta.group_id).toBe(result.group_id);
    expect(tb.group_id).toBe(result.group_id);

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('My Folder');
    expect(groups[0].member_ids.sort()).toEqual([a, b].sort());
    // Folder model: the folder carries the project it belongs to, top-level by default.
    expect(groups[0].project).toBe('Marina');
    expect(groups[0].parent_id).toBeUndefined();
  });

  it('defaults the label to the first member title when none is given', async () => {
    const [a, b] = await makeTasks(['Lead Title', 'Second']);
    const result = await groupTasks([a, b]);
    expect(result.label).toBe('Lead Title');
  });

  it('rejects fewer than 2 tasks', async () => {
    const [a] = await makeTasks(['Solo']);
    await expect(groupTasks([a])).rejects.toThrow(/at least 2/);
  });

  it('rejects tasks that span projects (a folder belongs to one project)', async () => {
    // Folder cutover: a folder is a project's private sub-structure, so a
    // cross-project selection has no valid home and must be refused outright
    // rather than silently picking one project's side.
    const [a] = await makeTasks(['A'], 'Marina');
    const [b] = await makeTasks(['B'], 'Acme');
    await expect(groupTasks([a, b])).rejects.toThrow(/A folder belongs to one project/);
    // Nothing partially applied.
    expect((await getTask(a)).group_id).toBeUndefined();
    expect((await getTask(b)).group_id).toBeUndefined();
    expect(await listGroups()).toHaveLength(0);
  });

  it("rejects mixing Inbox ('') with a named project", async () => {
    // Inbox is a real project, not a wildcard — it can hold folders of its own,
    // but it cannot be lumped in with a named one.
    const [a] = await makeTasks(['A'], 'Marina');
    const [b] = await makeTasks(['B'], ''); // Inbox
    await expect(groupTasks([a, b])).rejects.toThrow(/A folder belongs to one project/);
  });

  it("groups Inbox tasks together ('' is a valid project for a folder)", async () => {
    const [a, b] = await makeTasks(['Inbox A', 'Inbox B'], '');
    const result = await groupTasks([a, b], 'Inbox cluster');
    expect(result.member_ids.sort()).toEqual([a, b].sort());
    expect((await folder(result.group_id))?.project).toBe('');
  });

  it('treats project names case-insensitively (matches the registry COLLATE NOCASE)', async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    // Raw write: a differently-cased spelling of the SAME project must not read
    // as a different project (the registry itself is case-insensitive).
    await updateTaskRaw(b, { project: 'marina' });
    expect((await getTask(b)).project).toBe('marina');

    const result = await groupTasks([a, b]);
    expect(result.member_ids.sort()).toEqual([a, b].sort());
    // The folder keeps the lead member's spelling.
    expect((await folder(result.group_id))?.project).toBe('Marina');
  });

  it('absorbs a pre-existing folder when a member is already grouped (merge)', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const g1 = await groupTasks([a, b], 'First');
    // Group c with a → should merge b in too (all under one new folder).
    const g2 = await groupTasks([a, c]);
    expect(g2.member_ids.sort()).toEqual([a, b, c].sort());

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].group_id).toBe(g2.group_id);
    expect(g2.group_id).not.toBe(g1.group_id);
  });
});

describe('addToGroup', () => {
  it('adds a task to an existing folder', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const g = await groupTasks([a, b], 'G');
    const result = await addToGroup(g.group_id, [c]);
    expect(result.member_ids.sort()).toEqual([a, b, c].sort());
    expect((await getTask(c)).group_id).toBe(g.group_id);
  });

  it("rejects a task from another project (join never moves the task's project)", async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    const [c] = await makeTasks(['C'], 'Acme');
    const g = await groupTasks([a, b]);

    await expect(addToGroup(g.group_id, [c])).rejects.toThrow(/A folder belongs to one project/);
    expect((await getTask(c)).group_id).toBeUndefined();
    // The folder is untouched by the rejected join.
    expect((await folder(g.group_id))?.member_ids.sort()).toEqual([a, b].sort());
  });

  it('fills an empty folder created by createFolder', async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    const f = await createFolder('Later', 'Marina');
    const result = await addToGroup(f.group_id, [a, b]);
    expect(result.label).toBe('Later');
    expect(result.member_ids.sort()).toEqual([a, b].sort());
    expect((await folder(f.group_id))?.project).toBe('Marina');
  });

  it('leaves an emptied DONOR folder in place (folders are never auto-pruned)', async () => {
    const [a, b, c, d] = await makeTasks(['A', 'B', 'C', 'D']);
    const keep = await groupTasks([a, b], 'Keeper');
    const donor = await groupTasks([c, d], 'Donor');

    // Steal BOTH of the donor's tasks — it drops to 0 members.
    await addToGroup(keep.group_id, [c, d]);

    const groups = await listGroups();
    expect(groups).toHaveLength(2);
    expect((await folder(keep.group_id))?.member_ids.sort()).toEqual([a, b, c, d].sort());
    const emptied = await folder(donor.group_id);
    expect(emptied, 'the emptied donor folder must survive').toBeDefined();
    expect(emptied!.member_ids).toEqual([]);
    expect(emptied!.label).toBe('Donor');
  });

  it('throws for an unknown folder id', async () => {
    const [a] = await makeTasks(['A']);
    await expect(addToGroup('g_nope', [a])).rejects.toThrow(/not found/);
  });
});

describe('removeFromGroup', () => {
  it('keeps the folder alive with a lone member when one of two is removed', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    const result = await removeFromGroup([a]);
    expect(result.removed_ids).toEqual([a]);
    expect(result.dissolved_group_ids).toEqual([]);

    // a is ungrouped; b stays in the folder as the lone member.
    expect((await getTask(a)).group_id).toBeUndefined();
    expect((await getTask(b)).group_id).toBe(g.group_id);
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids).toEqual([b]);
  });

  it('leaves the folder in place when its LAST member is removed (0 members is valid)', async () => {
    // Folder model: emptying a folder is like emptying a directory — it stays until the
    // user deletes it. Auto-pruning destroyed structure the user had built.
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b], 'Survives Empty');

    await removeFromGroup([a]);
    const result = await removeFromGroup([b]);
    expect(result.removed_ids).toEqual([b]);
    expect(result.dissolved_group_ids).toEqual([]); // nothing dissolves, ever

    expect((await getTask(b)).group_id).toBeUndefined();
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].group_id).toBe(g.group_id);
    expect(groups[0].label).toBe('Survives Empty');
    expect(groups[0].member_ids).toEqual([]);
    expect(groups[0].project).toBe('Marina');
  });

  it('keeps the folder alive when ≥2 members remain', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    await groupTasks([a, b, c]);

    const result = await removeFromGroup([a]);
    expect(result.dissolved_group_ids).toEqual([]);
    expect((await getTask(a)).group_id).toBeUndefined();

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids.sort()).toEqual([b, c].sort());
  });
});

describe('createFolder', () => {
  it('creates an EMPTY folder that is immediately listed with its project', async () => {
    // The "project + → New folder" entry point: a folder must be visible before
    // its first task arrives, or the user has nothing to drag onto.
    const created = await createFolder('Reading list', 'Marina');
    expect(created.label).toBe('Reading list');
    expect(created.project).toBe('Marina');
    expect(created.parent_id).toBeUndefined();

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      group_id: created.group_id,
      label: 'Reading list',
      project: 'Marina',
      hidden: false,
      member_ids: [],
    });
  });

  it("creates an Inbox folder for project ''", async () => {
    const created = await createFolder('Inbox pile', '');
    expect(created.project).toBe('');
    expect((await folder(created.group_id))?.project).toBe('');
  });

  it('rejects an empty label', async () => {
    await expect(createFolder('   ', 'Marina')).rejects.toThrow(/empty/i);
    expect(await listGroups()).toHaveLength(0);
  });

  it('nests under a parent folder in the same project', async () => {
    const parent = await createFolder('Parent', 'Marina');
    const child = await createFolder('Child', 'Marina', parent.group_id);
    expect(child.parent_id).toBe(parent.group_id);
    expect((await folder(child.group_id))?.parent_id).toBe(parent.group_id);
  });

  it('rejects an unknown parent, and a parent in another project', async () => {
    await expect(createFolder('Child', 'Marina', 'g_ghost')).rejects.toThrow(/not found/);
    const other = await createFolder('Elsewhere', 'Acme');
    await expect(createFolder('Child', 'Marina', other.group_id)).rejects.toThrow(
      /same project/i,
    );
  });

  it(`refuses to create a child past FOLDER_MAX_DEPTH (${FOLDER_MAX_DEPTH})`, async () => {
    let parentId: string | undefined;
    const chain: string[] = [];
    for (let i = 0; i < FOLDER_MAX_DEPTH; i += 1) {
      const f = await createFolder(`Level ${i + 1}`, 'Marina', parentId);
      chain.push(f.group_id);
      parentId = f.group_id;
    }
    expect(chain).toHaveLength(FOLDER_MAX_DEPTH);
    await expect(createFolder('Too deep', 'Marina', parentId)).rejects.toThrow(
      new RegExp(`at most ${FOLDER_MAX_DEPTH} levels`),
    );
    expect(await listGroups()).toHaveLength(FOLDER_MAX_DEPTH);
  });
});

describe('deleteFolder', () => {
  it('releases members in place — the tasks survive, ungrouped', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b], 'Doomed');

    const result = await deleteFolder(g.group_id);
    expect(result.group_id).toBe(g.group_id);
    expect(result.released_task_ids.sort()).toEqual([a, b].sort());
    expect(result.reparented_folder_ids).toEqual([]);

    // No task is ever deleted by a folder delete.
    expect((await listTasks()).map((t) => t.id).sort()).toEqual([a, b].sort());
    expect((await getTask(a)).group_id).toBeUndefined();
    expect((await getTask(b)).group_id).toBeUndefined();
    // The task keeps its project — only the folder membership went away.
    expect((await getTask(a)).project).toBe('Marina');
    expect(await listGroups()).toHaveLength(0);
  });

  it("re-parents child folders to the deleted folder's parent", async () => {
    const grand = await createFolder('Grand', 'Marina');
    const parent = await createFolder('Parent', 'Marina', grand.group_id);
    const childA = await createFolder('Child A', 'Marina', parent.group_id);
    const childB = await createFolder('Child B', 'Marina', parent.group_id);

    const result = await deleteFolder(parent.group_id);
    expect(result.reparented_folder_ids.sort()).toEqual([childA.group_id, childB.group_id].sort());
    expect((await folder(childA.group_id))?.parent_id).toBe(grand.group_id);
    expect((await folder(childB.group_id))?.parent_id).toBe(grand.group_id);
    expect(await folder(parent.group_id)).toBeUndefined();
  });

  it('promotes children to top-level when the deleted folder was top-level', async () => {
    const parent = await createFolder('Parent', 'Marina');
    const child = await createFolder('Child', 'Marina', parent.group_id);

    await deleteFolder(parent.group_id);
    const listed = await folder(child.group_id);
    expect(listed).toBeDefined();
    expect(listed!.parent_id).toBeUndefined();
  });

  it('deletes an EMPTY folder (no members, nothing released)', async () => {
    const f = await createFolder('Empty', 'Marina');
    const result = await deleteFolder(f.group_id);
    expect(result.released_task_ids).toEqual([]);
    expect(await listGroups()).toHaveLength(0);
  });

  it('throws for an unknown folder id', async () => {
    await expect(deleteFolder('g_does_not_exist')).rejects.toThrow(/not found/);
  });
});

describe('setFolderParent (nesting)', () => {
  it('moves a folder under another folder in the same project, then back to top level', async () => {
    const parent = await createFolder('Parent', 'Marina');
    const child = await createFolder('Loose', 'Marina');
    expect((await folder(child.group_id))?.parent_id).toBeUndefined();

    const moved = await setFolderParent(child.group_id, parent.group_id);
    expect(moved).toEqual({ group_id: child.group_id, parent_id: parent.group_id });
    expect((await folder(child.group_id))?.parent_id).toBe(parent.group_id);

    // null = back to the top level (directly under the project).
    const promoted = await setFolderParent(child.group_id, null);
    expect(promoted).toEqual({ group_id: child.group_id });
    expect((await folder(child.group_id))?.parent_id).toBeUndefined();
  });

  it('rejects making a folder its own parent', async () => {
    const f = await createFolder('Self', 'Marina');
    await expect(setFolderParent(f.group_id, f.group_id)).rejects.toThrow(/its own parent/);
    expect((await folder(f.group_id))?.parent_id).toBeUndefined();
  });

  it('rejects a move that would make a folder its own ancestor (cycle)', async () => {
    const top = await createFolder('Top', 'Marina');
    const mid = await createFolder('Mid', 'Marina', top.group_id);
    const leaf = await createFolder('Leaf', 'Marina', mid.group_id);

    await expect(setFolderParent(top.group_id, leaf.group_id)).rejects.toThrow(/own ancestor/);
    // The tree is unchanged.
    expect((await folder(top.group_id))?.parent_id).toBeUndefined();
    expect((await folder(mid.group_id))?.parent_id).toBe(top.group_id);
    expect((await folder(leaf.group_id))?.parent_id).toBe(mid.group_id);
  });

  it('rejects nesting across projects', async () => {
    const marina = await createFolder('Marina folder', 'Marina');
    const acme = await createFolder('Acme folder', 'Acme');
    await expect(setFolderParent(acme.group_id, marina.group_id)).rejects.toThrow(/same project/i);
    expect((await folder(acme.group_id))?.parent_id).toBeUndefined();
  });

  it("rejects a move whose SUBTREE would exceed FOLDER_MAX_DEPTH", async () => {
    // A full-depth chain, plus a 2-deep subtree parked at the top level.
    let parentId: string | undefined;
    const chain: string[] = [];
    for (let i = 0; i < FOLDER_MAX_DEPTH; i += 1) {
      const f = await createFolder(`L${i + 1}`, 'Marina', parentId);
      chain.push(f.group_id);
      parentId = f.group_id;
    }
    const subRoot = await createFolder('Sub root', 'Marina');
    const subLeaf = await createFolder('Sub leaf', 'Marina', subRoot.group_id);

    // Under the deepest link (depth 5) even a 1-deep folder would land at 6.
    await expect(setFolderParent(subLeaf.group_id, chain[FOLDER_MAX_DEPTH - 1])).rejects.toThrow(
      new RegExp(`at most ${FOLDER_MAX_DEPTH} levels`),
    );
    // The 2-deep subtree doesn't fit under depth 4 either (4 + 2 = 6).
    await expect(setFolderParent(subRoot.group_id, chain[FOLDER_MAX_DEPTH - 2])).rejects.toThrow(
      new RegExp(`at most ${FOLDER_MAX_DEPTH} levels`),
    );
    // ...but it does fit under depth 3 (3 + 2 = 5).
    await setFolderParent(subRoot.group_id, chain[FOLDER_MAX_DEPTH - 3]);
    expect((await folder(subRoot.group_id))?.parent_id).toBe(chain[FOLDER_MAX_DEPTH - 3]);
  });

  it('throws for an unknown folder or parent id', async () => {
    const f = await createFolder('Real', 'Marina');
    await expect(setFolderParent('g_ghost', f.group_id)).rejects.toThrow(/not found/);
    await expect(setFolderParent(f.group_id, 'g_ghost')).rejects.toThrow(/not found/);
  });
});

describe('project move auto-unfolders the task', () => {
  it('updateTask clears group_id when the project actually changes', async () => {
    // A folder is the project's private structure — it must not follow a task
    // into another project (where its siblings do not exist).
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    const g = await groupTasks([a, b], 'Marina folder');

    const { task } = await updateTask(a, { project: 'Acme' });
    expect(task.project).toBe('Acme');
    expect(task.group_id).toBeUndefined();
    expect((await getTask(a)).group_id).toBeUndefined();

    // The folder itself survives (never auto-pruned) and keeps its own project.
    const listed = await folder(g.group_id);
    expect(listed?.project).toBe('Marina');
    expect(listed?.member_ids).toEqual([b]);
  });

  it('updateTask keeps group_id when the "move" is the same project (or just recased)', async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    const g = await groupTasks([a, b]);

    await updateTask(a, { project: 'Marina' });
    expect((await getTask(a)).group_id).toBe(g.group_id);
    // Case-only difference resolves to the SAME project → membership stays.
    await updateTask(a, { project: 'marina' });
    expect((await getTask(a)).group_id).toBe(g.group_id);
  });

  it('updateTaskRaw (sync path) clears group_id and drops it from the payload blob', async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    const g = await groupTasks([a, b]);
    expect(rawPayload(a)).toContain('group_id');

    await updateTaskRaw(a, { project: 'Acme' });

    const reloaded = await getTask(a);
    expect(reloaded.project).toBe('Acme');
    expect(reloaded.group_id).toBeUndefined();
    // The physical blob no longer carries the key (the null-clear marker path),
    // so it can't reappear on the next payload rewrite.
    expect(rawPayload(a) ?? '').not.toContain('group_id');

    // Survives a real reload from SQLite, and b is untouched.
    closeDb();
    _resetForTesting();
    expect((await getTask(a)).group_id).toBeUndefined();
    expect((await getTask(b)).group_id).toBe(g.group_id);
  });

  it('updateTaskRaw keeps group_id when the project is unchanged', async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    const g = await groupTasks([a, b]);
    await updateTaskRaw(a, { project: 'Marina', unread: true });
    const reloaded = await getTask(a);
    expect(reloaded.unread).toBe(true);
    expect(reloaded.group_id).toBe(g.group_id);
  });
});

/**
 * moveFolderToProject — the INVERSE of the auto-unfolder above. Moving a TASK
 * across projects drops its folder; moving the FOLDER takes its whole subtree
 * (descendant folders + every member task) along, and members keep group_id.
 */
describe('moveFolderToProject', () => {
  it('moves the folder, its descendants and every member task, keeping membership', async () => {
    const root = await createFolder('Root', 'Marina');
    const child = await createFolder('Child', 'Marina', root.group_id);
    const grand = await createFolder('Grand', 'Marina', child.group_id);
    const [rootTask, childTask, grandTask, loose] = await makeTasks(
      ['Root member', 'Child member', 'Grand member', 'Unfoldered'], 'Marina',
    );
    await addToGroup(root.group_id, [rootTask]);
    await addToGroup(child.group_id, [childTask]);
    await addToGroup(grand.group_id, [grandTask]);

    const result = await moveFolderToProject(root.group_id, 'Acme');

    expect(result.group_id).toBe(root.group_id);
    expect(result.project).toBe('Acme');
    expect(result.moved_folder_ids).toEqual([root.group_id, child.group_id, grand.group_id]);
    expect(result.moved_task_ids.sort()).toEqual([rootTask, childTask, grandTask].sort());

    // Every folder in the subtree now belongs to the destination project.
    for (const gid of [root.group_id, child.group_id, grand.group_id]) {
      expect((await folder(gid))?.project).toBe('Acme');
    }
    // The subtree's SHAPE survives: descendants keep their parent links.
    expect((await folder(child.group_id))?.parent_id).toBe(root.group_id);
    expect((await folder(grand.group_id))?.parent_id).toBe(child.group_id);

    // Members moved WITH their membership intact (the whole point).
    for (const [id, gid] of [[rootTask, root.group_id], [childTask, child.group_id], [grandTask, grand.group_id]] as const) {
      const t = await getTask(id);
      expect(t.project).toBe('Acme');
      expect(t.group_id).toBe(gid);
    }
    // A non-member in the old project is untouched.
    expect((await getTask(loose)).project).toBe('Marina');
    // group_id survives a real reload from SQLite (it rides the payload blob).
    closeDb();
    _resetForTesting();
    expect((await getTask(childTask)).group_id).toBe(child.group_id);
    expect((await folder(child.group_id))?.project).toBe('Acme');
  });

  it('clears the moved folder\'s parent_id but leaves that parent behind', async () => {
    const parent = await createFolder('Stays', 'Marina');
    const mover = await createFolder('Goes', 'Marina', parent.group_id);
    const sibling = await createFolder('Also stays', 'Marina', parent.group_id);

    await moveFolderToProject(mover.group_id, 'Acme');

    // The mover is top-level in the destination — its old parent lives in the
    // old project and can't be its parent any more.
    expect((await folder(mover.group_id))?.parent_id).toBeUndefined();
    expect((await folder(mover.group_id))?.project).toBe('Acme');
    // The old parent and its other child are untouched.
    expect((await folder(parent.group_id))?.project).toBe('Marina');
    expect((await folder(parent.group_id))?.parent_id).toBeUndefined();
    expect((await folder(sibling.group_id))?.project).toBe('Marina');
    expect((await folder(sibling.group_id))?.parent_id).toBe(parent.group_id);
  });

  it('is a no-op when the folder is already in the target project (incl. a recase)', async () => {
    const f = await createFolder('Already home', 'Marina');
    const [a] = await makeTasks(['Member'], 'Marina');
    await addToGroup(f.group_id, [a]);

    const same = await moveFolderToProject(f.group_id, 'Marina');
    expect(same).toEqual({
      group_id: f.group_id, project: 'Marina', moved_task_ids: [], moved_folder_ids: [],
    });
    // Case-only difference resolves to the SAME project → still a no-op.
    const recased = await moveFolderToProject(f.group_id, 'marina');
    expect(recased.project).toBe('Marina');
    expect(recased.moved_task_ids).toEqual([]);
    expect((await folder(f.group_id))?.project).toBe('Marina');
    expect((await getTask(a)).project).toBe('Marina');
  });

  it("moves a folder to Inbox ('') and back out again", async () => {
    const f = await createFolder('Travels', 'Marina');
    const [a] = await makeTasks(['Member'], 'Marina');
    await addToGroup(f.group_id, [a]);

    const toInbox = await moveFolderToProject(f.group_id, '');
    expect(toInbox.project).toBe('');
    expect(toInbox.moved_task_ids).toEqual([a]);
    expect((await folder(f.group_id))?.project).toBe('');
    expect((await getTask(a)).project).toBe('');
    expect((await getTask(a)).group_id).toBe(f.group_id);
    // Inbox has no registry row, by design.
    expect(await getProjectRecord('')).toBeNull();

    const back = await moveFolderToProject(f.group_id, 'Marina');
    expect(back.moved_task_ids).toEqual([a]);
    expect((await getTask(a)).project).toBe('Marina');
    expect((await getTask(a)).group_id).toBe(f.group_id);
  });

  it('adopts the destination project\'s canonical spelling', async () => {
    await makeTasks(['Anchor'], 'Marina');   // mints the 'Marina' registry row
    const f = await createFolder('Recase', 'Acme');
    const [a] = await makeTasks(['Member'], 'Acme');
    await addToGroup(f.group_id, [a]);

    const moved = await moveFolderToProject(f.group_id, 'MARINA');
    expect(moved.project).toBe('Marina');
    expect((await folder(f.group_id))?.project).toBe('Marina');
    expect((await getTask(a)).project).toBe('Marina');
  });

  it('auto-creates the destination registry row for an EMPTY folder', async () => {
    const f = await createFolder('Pioneer', 'Marina');
    expect(await getProjectRecord('Greenfield')).toBeNull();

    const moved = await moveFolderToProject(f.group_id, 'Greenfield');

    expect(moved.moved_task_ids).toEqual([]);
    expect(moved.moved_folder_ids).toEqual([f.group_id]);
    expect((await folder(f.group_id))?.project).toBe('Greenfield');
    // Same precedent as a task move / task_create: source 'local'.
    expect(await getProjectRecord('Greenfield')).toMatchObject({ name: 'Greenfield', source: 'local' });
  });

  it('throws "not found" for an unknown folder id', async () => {
    await expect(moveFolderToProject('g_ghost', 'Acme')).rejects.toThrow(/not found/);
  });

  it('rejects an unusable destination project NAME before touching anything', async () => {
    const f = await createFolder('Guarded', 'Marina');
    await expect(moveFolderToProject(f.group_id, '.hidden')).rejects.toThrow(/cannot start with/);
    await expect(moveFolderToProject(f.group_id, '../etc')).rejects.toThrow(/not allowed/);
    // A project name is also an object key — the JS-magic names are refused.
    await expect(moveFolderToProject(f.group_id, '__proto__')).rejects.toThrow(/reserved/i);
    await expect(moveFolderToProject(f.group_id, 'constructor')).rejects.toThrow(/reserved/i);
    // ...and it becomes a path segment, so its length is capped.
    await expect(moveFolderToProject(f.group_id, 'x'.repeat(201))).rejects.toThrow(/max 200/);
    expect((await folder(f.group_id))?.project).toBe('Marina');
  });

  /**
   * PROTOTYPE POLLUTION regression. `store.task_groups[gid]` is a plain-object
   * index, so `task_groups['__proto__']` used to return Object.prototype: the
   * truthy value passed the "folder exists" check and the op then wrote
   * `rec.project = target` onto the PROTOTYPE. After that every plain object in
   * the process inherited `.project`, so updateTask's
   * `if (updates.project !== undefined)` fired on EVERY update and re-projected
   * unrelated tasks. Own-property lookups make a magic id simply "not found".
   */
  it('refuses a JS-magic folder id and never writes to Object.prototype', async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    const g = await groupTasks([a, b], 'Real folder');

    for (const magic of ['__proto__', 'constructor', 'prototype']) {
      await expect(moveFolderToProject(magic, 'Acme')).rejects.toThrow(/not found/);
      // Same flaw class on every other folder op that indexes by id.
      await expect(setFolderParent(magic, g.group_id)).rejects.toThrow(/not found/);
      await expect(deleteFolder(magic)).rejects.toThrow(/not found/);
      await expect(renameGroup(magic, 'Hijacked')).rejects.toThrow(/not found/);
      await expect(setGroupHidden(magic, true)).rejects.toThrow(/not found/);
      await expect(addToGroup(magic, [a])).rejects.toThrow(/not found/);
    }

    // Nothing leaked onto the prototype (the payload the attack would write).
    const probe = {} as Record<string, unknown>;
    expect(probe.project).toBeUndefined();
    expect(probe.label).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'project')).toBe(false);

    // ...and the store still behaves: a title-only update must NOT see an
    // inherited `project` and re-project the task (the persistence mechanism).
    const { task } = await updateTask(a, { title: 'Still in Marina' });
    expect(task.project).toBe('Marina');
    expect(task.group_id).toBe(g.group_id);
    expect((await folder(g.group_id))?.project).toBe('Marina');
    // The real folder is untouched by any of the rejected calls.
    expect((await folder(g.group_id))?.member_ids.sort()).toEqual([a, b].sort());
  });

  /**
   * A provider push failure must NOT abort the batch. Before: the members rode a
   * plain `for` loop of awaited updateTask calls, so the FIRST throw left the
   * already-moved tasks in the destination and the folder record in the old
   * project — a split the user could only fix by dragging again.
   */
  it('keeps going when a PROVIDER member fails, still moves the folder + local members', async () => {
    let rejectPush = false;
    registry.replace('prov-a', createMockPlugin({ id: 'prov-a' }));
    registry.replace('prov-b', createMockPlugin({
      id: 'prov-b',
      sync: {
        ...createNoopSync(),
        createTask: async () => {
          if (rejectPush) throw new Error('remote rejected the task');
          return null;
        },
      },
    }));

    // Two provider-claimed projects: the folder starts in prov-a's, moves to prov-b's.
    await addTask({ title: 'Alpha claimer', project: 'Alpha', source: 'prov-a' });
    await addTask({ title: 'Beta claimer', project: 'Beta', source: 'prov-b' });
    expect(await getProjectRecord('Beta')).toMatchObject({ source: 'prov-b' });

    const f = await createFolder('Mixed sources', 'Alpha');
    const { task: providerMember } = await addTask({ title: 'Synced member', project: 'Alpha', source: 'prov-a' });
    // Explicit 'local' outranks the project claim (see addTask) — without it the
    // registry row would source this task to prov-a as well.
    const { task: local } = await addTask({ title: 'Local member', project: 'Alpha', source: 'local' });
    const localMember = local.id;
    expect(local.source).toBe('local');
    await addToGroup(f.group_id, [providerMember.id, localMember]);

    rejectPush = true;   // the destination provider now refuses the migrated task
    const moved = await moveFolderToProject(f.group_id, 'Beta');

    // The failure is REPORTED, not thrown...
    expect(moved.failed).toHaveLength(1);
    expect(moved.failed![0].id).toBe(providerMember.id);
    expect(moved.failed![0].error).toMatch(/prov-b/);
    // ...the local member still moved...
    expect(moved.moved_task_ids).toContain(localMember);
    // ...and the folder record went with it.
    expect(moved.moved_folder_ids).toEqual([f.group_id]);
    expect(moved.project).toBe('Beta');

    // Durable, not just in-memory.
    closeDb();
    _resetForTesting();
    const reloaded = await getTask(localMember);
    expect(reloaded.project).toBe('Beta');
    expect(reloaded.source).toBe('local');       // local stays local under a claim
    expect(reloaded.group_id).toBe(f.group_id);  // membership survives the move
    expect((await folder(f.group_id))?.project).toBe('Beta');
  });

  /**
   * The concurrent-join window: planning reads the member list OUTSIDE the lock,
   * so a task that joins the folder while the move is in flight used to be
   * stranded in the old project (and a re-run couldn't fix it — the folder record
   * already matched, so the call was a no-op). The final lock now re-walks the
   * subtree from a fresh read and sweeps whatever it finds.
   *
   * The join is injected from inside the destination plugin's push, which
   * updateTask AWAITS for a migrating task — i.e. genuinely after the planning
   * read and before the final lock.
   */
  it('sweeps a task that joined the folder DURING the move', async () => {
    let lateJoin: (() => Promise<void>) | null = null;
    registry.replace('prov-a', createMockPlugin({ id: 'prov-a' }));
    registry.replace('prov-joiner', createMockPlugin({
      id: 'prov-joiner',
      sync: {
        ...createNoopSync(),
        createTask: async () => {
          const join = lateJoin;
          lateJoin = null;              // once only
          if (join) await join();
          return null;
        },
      },
    }));

    await addTask({ title: 'Alpha claimer', project: 'Alpha', source: 'prov-a' });
    await addTask({ title: 'Beta claimer', project: 'Beta', source: 'prov-joiner' });

    const f = await createFolder('Racy', 'Alpha');
    const { task: providerMember } = await addTask({ title: 'Migrating member', project: 'Alpha', source: 'prov-a' });
    await addToGroup(f.group_id, [providerMember.id]);
    // Not members yet — the planning read will not see either of them. One local
    // (swept inside the final lock) and one provider-sourced (deferred to the
    // per-task path afterwards, since a raw rewrite would skip its claim rules).
    const { task: lateLocal } = await addTask({ title: 'Joined mid-move', project: 'Alpha', source: 'local' });
    const { task: lateProvider } = await addTask({ title: 'Also joined mid-move', project: 'Alpha' });
    expect(lateProvider.source).toBe('prov-a');   // inherited from the project claim

    lateJoin = async () => { await addToGroup(f.group_id, [lateLocal.id, lateProvider.id]); };
    const moved = await moveFolderToProject(f.group_id, 'Beta');

    expect(lateJoin, 'the mid-move join must actually have run').toBeNull();
    // Both late joiners were carried into the destination with the rest.
    expect(moved.moved_task_ids).toContain(lateLocal.id);
    expect(moved.moved_task_ids).toContain(lateProvider.id);
    expect(moved.failed).toBeUndefined();
    for (const id of [lateLocal.id, lateProvider.id]) {
      const reloadedLate = await getTask(id);
      expect(reloadedLate.project).toBe('Beta');
      expect(reloadedLate.group_id).toBe(f.group_id);
    }
    // The member the planning read DID see moved too (provider path).
    expect((await getTask(providerMember.id)).project).toBe('Beta');
    expect((await folder(f.group_id))?.project).toBe('Beta');
  });

  /**
   * A case-only difference is real drift to normalize, not a no-op: the registry
   * is NOCASE, so two spellings of one project cannot both be right. The old
   * early-return (case-insensitive "already there") left members spelled the old
   * way forever.
   */
  it('normalizes a case-only re-spelling of the SAME project (record + members)', async () => {
    await makeTasks(['Anchor'], 'Marina');                 // mints the canonical row
    const [member] = await makeTasks(['Member'], 'Marina');
    await updateTaskRaw(member, { project: 'marina' });    // drifted spelling
    const f = await createFolder('Drifted', 'marina');     // ...on the record too
    await addToGroup(f.group_id, [member]);                // join is case-insensitive
    expect((await getTask(member)).project).toBe('marina');

    const moved = await moveFolderToProject(f.group_id, 'MARINA');

    expect(moved.project).toBe('Marina');                 // canonical spelling wins
    expect(moved.moved_task_ids).toEqual([member]);
    expect(moved.moved_folder_ids).toEqual([f.group_id]);
    expect((await getTask(member)).project).toBe('Marina');
    expect((await getTask(member)).group_id).toBe(f.group_id);
    expect((await folder(f.group_id))?.project).toBe('Marina');
  });

  /** A record-less legacy folder with live members gets its row minted, not a throw. */
  it('mints a missing registry row for a legacy folder instead of refusing the move', async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    const g = await groupTasks([a, b], 'Has a record');
    // Simulate a pre-v9 store: membership on the tasks, no registry row.
    getDb()!.prepare('DELETE FROM task_groups WHERE id = ?').run(g.group_id);
    _resetForTesting();
    // Only the membership-derived listing knows about it now (label = lead title).
    expect((await folder(g.group_id))?.member_ids.sort()).toEqual([a, b].sort());

    const moved = await moveFolderToProject(g.group_id, 'Acme');
    expect(moved.project).toBe('Acme');
    // The row now exists, labelled from the lead member.
    expect((await folder(g.group_id))?.label).toBe('A');
    expect(moved.moved_task_ids.sort()).toEqual([a, b].sort());
    expect(moved.moved_folder_ids).toEqual([g.group_id]);
    expect((await folder(g.group_id))?.project).toBe('Acme');
    for (const id of [a, b]) {
      const t = await getTask(id);
      expect(t.project).toBe('Acme');
      expect(t.group_id).toBe(g.group_id);
    }
  });

  // ── The project-move semantics updateTask already guarantees must survive ──

  it('keeps a LOCAL member local when the destination project is provider-claimed', async () => {
    // updateTask's rule: a local task filed under a provider-claimed project keeps
    // source 'local' (the project is just a folder there, nothing is pushed).
    // Moving the whole folder must not sneak past that and promote the task.
    await addTask({ title: 'Claimer', project: 'Synced', source: 'ms-todo' });
    expect(await getProjectRecord('Synced')).toMatchObject({ source: 'ms-todo' });

    const f = await createFolder('Local folder', 'Marina');
    const [a] = await makeTasks(['Local member'], 'Marina');
    await addToGroup(f.group_id, [a]);

    const moved = await moveFolderToProject(f.group_id, 'Synced');
    expect(moved.moved_task_ids).toEqual([a]);

    const reloaded = await getTask(a);
    expect(reloaded.project).toBe('Synced');
    expect(reloaded.source).toBe('local');
    expect(reloaded.group_id).toBe(f.group_id);
    // The move never re-claims the destination project.
    expect(await getProjectRecord('Synced')).toMatchObject({ source: 'ms-todo' });
  });

  it('migrates a PROVIDER-sourced member to local when the folder moves to Inbox', async () => {
    // Same rule as a bare updateTask({ project: '' }): Inbox is local-only, so a
    // provider-sourced task moved there adopts source 'local' and drops its
    // remote linkage — while KEEPING its folder membership.
    const { task } = await addTask({ title: 'Synced member', project: 'Synced', source: 'ms-todo' });
    expect(task.source).toBe('ms-todo');
    const f = await createFolder('Synced folder', 'Synced');
    await addToGroup(f.group_id, [task.id]);

    const moved = await moveFolderToProject(f.group_id, '');
    expect(moved.moved_task_ids).toEqual([task.id]);

    const reloaded = await getTask(task.id);
    expect(reloaded.project).toBe('');
    expect(reloaded.source).toBe('local');
    expect(reloaded.ext).toBeUndefined();
    expect(reloaded.group_id).toBe(f.group_id);
    expect((await folder(f.group_id))?.project).toBe('');
  });
});

describe('renameGroup', () => {
  it('changes the label', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b], 'Old');
    await renameGroup(g.group_id, 'New Name');
    const groups = await listGroups();
    expect(groups[0].label).toBe('New Name');
  });

  it('rejects an empty label', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);
    await expect(renameGroup(g.group_id, '   ')).rejects.toThrow(/empty/);
  });

  it('preserves project + parent_id (a rename must not flatten the folder)', async () => {
    const parent = await createFolder('Parent', 'Marina');
    const child = await createFolder('Child', 'Marina', parent.group_id);
    const [a, b] = await makeTasks(['A', 'B'], 'Marina');
    await addToGroup(child.group_id, [a, b]);

    await renameGroup(child.group_id, 'Renamed child');

    const listed = await folder(child.group_id);
    expect(listed?.label).toBe('Renamed child');
    expect(listed?.project).toBe('Marina');
    expect(listed?.parent_id).toBe(parent.group_id);
    expect(listed?.member_ids.sort()).toEqual([a, b].sort());
  });
});

describe('setGroupHidden (Focus-area collapse)', () => {
  it('marks a folder hidden and unhidden without touching membership', async () => {
    // Hiding is a pure rendering flag: members + labels + group_id all survive; only
    // the `hidden` bit flips. This is what lets the Focus area collapse a cluster
    // while /tasks still shows it (and unhide restores it).
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b], 'Keep Me');

    // Default: not hidden.
    let groups = await listGroups();
    expect(groups[0].hidden).toBe(false);

    // Hide it.
    const hres = await setGroupHidden(g.group_id, true);
    expect(hres).toEqual({ group_id: g.group_id, hidden: true });
    groups = await listGroups();
    expect(groups[0].hidden).toBe(true);
    // Membership + label untouched.
    expect(groups[0].member_ids.sort()).toEqual([a, b].sort());
    expect(groups[0].label).toBe('Keep Me');
    expect((await getTask(a)).group_id).toBe(g.group_id);
    expect((await getTask(b)).group_id).toBe(g.group_id);

    // Unhide it.
    const ures = await setGroupHidden(g.group_id, false);
    expect(ures).toEqual({ group_id: g.group_id, hidden: false });
    groups = await listGroups();
    expect(groups[0].hidden).toBe(false);
    expect(groups[0].member_ids.sort()).toEqual([a, b].sort());
  });

  it('persists the hidden flag across a fresh DB read', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);
    await setGroupHidden(g.group_id, true);

    // Force a real reload from SQLite (proves the column persisted, not just memory).
    closeDb();
    _resetForTesting();

    const groups = await listGroups();
    const reloaded = groups.find((x) => x.group_id === g.group_id);
    expect(reloaded?.hidden).toBe(true);
    // The label + membership round-trip alongside it.
    expect(reloaded?.member_ids.sort()).toEqual([a, b].sort());
  });

  it('preserves project + parent_id across hide/unhide', async () => {
    const parent = await createFolder('Parent', 'Marina');
    const child = await createFolder('Child', 'Marina', parent.group_id);

    await setGroupHidden(child.group_id, true);
    let listed = await folder(child.group_id);
    expect(listed?.hidden).toBe(true);
    expect(listed?.project).toBe('Marina');
    expect(listed?.parent_id).toBe(parent.group_id);

    await setGroupHidden(child.group_id, false);
    listed = await folder(child.group_id);
    expect(listed?.hidden).toBe(false);
    expect(listed?.project).toBe('Marina');
    expect(listed?.parent_id).toBe(parent.group_id);
  });

  it('throws for an unknown group id', async () => {
    await expect(setGroupHidden('g_does_not_exist', true)).rejects.toThrow(/not found/);
  });
});

describe('group_id persistence', () => {
  it('round-trips group_id through the store (payload blob)', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    // Force a fresh read from SQLite (new manager instance via reset+reopen).
    closeDb();
    _resetForTesting();

    const reloaded = (await listTasks()).filter((t) => [a, b].includes(t.id));
    expect(reloaded).toHaveLength(2);
    for (const t of reloaded) expect(t.group_id).toBe(g.group_id);
  });

  it('round-trips project + parent_id on the folder record', async () => {
    const parent = await createFolder('Parent', 'Marina');
    const child = await createFolder('Child', 'Marina', parent.group_id);

    closeDb();
    _resetForTesting();

    const listed = await folder(child.group_id);
    expect(listed?.project).toBe('Marina');
    expect(listed?.parent_id).toBe(parent.group_id);
    // An empty folder still lists after the reload.
    expect(listed?.member_ids).toEqual([]);
  });
});

describe('group_id survives raw partial updates (regression: vanishing groups)', () => {
  // Repro for the user-reported bug: a grouped session/incident task loses its
  // group after a while. Root cause — group_id lives in the SQLite `payload`
  // blob (no dedicated column). A raw partial update whose patch carries ANY
  // non-column key (e.g. the unread marker, set on every session phase
  // transition) made taskToRow rewrite the WHOLE payload column from just the
  // patch, silently dropping group_id. Session tasks transition phase often, so
  // their group "disappeared"; plain tasks rarely raw-update, so it looked
  // intermittent.
  it('keeps group_id when updateTaskRaw patches a payload field (unread)', async () => {
    const [a, b] = await makeTasks(['Session task', 'Sibling']);
    const g = await groupTasks([a, b]);
    expect((await getTask(a)).group_id).toBe(g.group_id);

    // Mirror phase.ts: a session phase transition sets a payload-only field.
    // (WAIT removed 2026-08-18 — the unread-setting phase is now AGENT_COMPLETE;
    // what this test cares about is that ANY payload-only key rides along.)
    await updateTaskRaw(a, { phase: 'AGENT_COMPLETE', unread: true });

    const reloaded = await getTask(a);
    expect(reloaded.unread).toBe(true);                   // the patch applied
    expect(reloaded.group_id).toBe(g.group_id);           // ...and group_id survived
    // The folder still lists both members.
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids.sort()).toEqual([a, b].sort());
  });

  it('keeps group_id across a fresh DB read after a raw payload-field update', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);
    await updateTaskRaw(a, { unread: true });

    // Force a real reload from SQLite — proves it persisted, not just in-memory.
    closeDb();
    _resetForTesting();

    expect((await getTask(a)).group_id).toBe(g.group_id);
  });

  it('keeps group_id when updateTasksBulk patches a payload field', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    await updateTasksBulk([{ id: a, patch: { unread: true } }]);

    expect((await getTask(a)).group_id).toBe(g.group_id);
  });
});

describe('deleteTask folder cleanup', () => {
  it('keeps the folder alive when a deletion leaves a single member', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    await deleteTask(a);
    // b is now the lone member, and the folder survives.
    expect((await getTask(b)).group_id).toBe(g.group_id);
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids).toEqual([b]);
  });

  it('leaves the folder in place even when its LAST member is deleted', async () => {
    // Deleting tasks must never destroy the folder the user built around them —
    // only an explicit deleteFolder does that.
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b], 'Outlives its tasks');

    await deleteTask(a);
    await deleteTask(b);

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].group_id).toBe(g.group_id);
    expect(groups[0].label).toBe('Outlives its tasks');
    expect(groups[0].member_ids).toEqual([]);
    expect(groups[0].project).toBe('Marina');
  });

  it('keeps the folder when ≥2 members remain after deletion', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    await groupTasks([a, b, c]);

    await deleteTask(a);
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids.sort()).toEqual([b, c].sort());
  });
});
