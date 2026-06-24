/**
 * Virtual task groups — lightweight visual grouping (NOT subtasks).
 *
 * Covers the core store ops in task-manager.ts: groupTasks / addToGroup /
 * removeFromGroup / renameGroup / listGroups, plus the invariants:
 *  - members must share the same category + project
 *  - a group needs ≥2 members (drops below → auto-dissolve)
 *  - group_id round-trips through the SQLite payload blob (no dedicated column)
 *  - deleting a task prunes a group it would leave with <2 members
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
  groupTasks,
  addToGroup,
  removeFromGroup,
  renameGroup,
  listGroups,
  TaskGroupScopeError,
  _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

/** Create N tasks in the same category+project. Returns their ids. */
async function makeTasks(titles: string[], category = 'Work', project = 'EKS'): Promise<string[]> {
  const ids: string[] = [];
  for (const title of titles) {
    const { task } = await addTask({ title, category, project, _skipDedup: true });
    ids.push(task.id);
  }
  return ids;
}

describe('groupTasks', () => {
  it('groups ≥2 same-scope tasks under one group_id and records a label', async () => {
    const [a, b] = await makeTasks(['Task A', 'Task B']);
    const result = await groupTasks([a, b], 'My Group');

    expect(result.member_ids.sort()).toEqual([a, b].sort());
    expect(result.label).toBe('My Group');

    const ta = await getTask(a);
    const tb = await getTask(b);
    expect(ta.group_id).toBe(result.group_id);
    expect(tb.group_id).toBe(result.group_id);

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].label).toBe('My Group');
    expect(groups[0].member_ids.sort()).toEqual([a, b].sort());
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

  it('rejects tasks from different category/project (scope rule)', async () => {
    const [a] = await makeTasks(['A'], 'Work', 'EKS');
    const [b] = await makeTasks(['B'], 'Life', 'Home');
    await expect(groupTasks([a, b])).rejects.toBeInstanceOf(TaskGroupScopeError);
  });

  it('absorbs a pre-existing group when a member is already grouped (merge)', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const g1 = await groupTasks([a, b], 'First');
    // Group c with a → should merge b in too (all under one new group).
    const g2 = await groupTasks([a, c]);
    expect(g2.member_ids.sort()).toEqual([a, b, c].sort());

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].group_id).toBe(g2.group_id);
    expect(g2.group_id).not.toBe(g1.group_id);
  });
});

describe('addToGroup', () => {
  it('adds a same-scope task to an existing group', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const g = await groupTasks([a, b], 'G');
    const result = await addToGroup(g.group_id, [c]);
    expect(result.member_ids.sort()).toEqual([a, b, c].sort());
    expect((await getTask(c)).group_id).toBe(g.group_id);
  });

  it('rejects adding an out-of-scope task', async () => {
    const [a, b] = await makeTasks(['A', 'B'], 'Work', 'EKS');
    const [c] = await makeTasks(['C'], 'Life', 'Home');
    const g = await groupTasks([a, b]);
    await expect(addToGroup(g.group_id, [c])).rejects.toBeInstanceOf(TaskGroupScopeError);
  });
});

describe('removeFromGroup', () => {
  it('removes a member and dissolves the group when fewer than 2 remain', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    const result = await removeFromGroup([a]);
    expect(result.removed_ids).toEqual([a]);
    expect(result.dissolved_group_ids).toEqual([g.group_id]);

    // Both members end up ungrouped (a removed explicitly, b pruned as the lone survivor).
    expect((await getTask(a)).group_id).toBeUndefined();
    expect((await getTask(b)).group_id).toBeUndefined();
    expect(await listGroups()).toHaveLength(0);
  });

  it('keeps the group alive when ≥2 members remain', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const g = await groupTasks([a, b, c]);

    const result = await removeFromGroup([a]);
    expect(result.dissolved_group_ids).toEqual([]);
    expect((await getTask(a)).group_id).toBeUndefined();

    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids.sort()).toEqual([b, c].sort());
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
});

describe('deleteTask group cleanup', () => {
  it('prunes a group that a deletion would leave with a single member', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    await deleteTask(a);
    // b is now the lone member → group dissolved, b ungrouped.
    expect((await getTask(b)).group_id).toBeUndefined();
    expect(await listGroups()).toHaveLength(0);
  });

  it('keeps the group when ≥2 members remain after deletion', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const g = await groupTasks([a, b, c]);

    await deleteTask(a);
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids.sort()).toEqual([b, c].sort());
  });
});
