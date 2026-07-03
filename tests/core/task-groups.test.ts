/**
 * Virtual task groups — lightweight visual grouping (NOT subtasks).
 *
 * Covers the core store ops in task-manager.ts: groupTasks / addToGroup /
 * removeFromGroup / renameGroup / listGroups, plus the invariants:
 *  - any tasks can be grouped — NO category/project scope rule (a group is a pure
 *    visual cluster; cross-category/project members are allowed)
 *  - CREATING a group needs ≥2 tasks, but a created group survives down to 1 member
 *    (a lone-member group is valid, acts like a tag); only 0 members dissolves it
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
  setGroupHidden,
  listGroups,
  updateTaskRaw,
  updateTasksBulk,
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
    const { task } = await addTask({ title, category, project });
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

  it('groups tasks from different category/project (no scope rule)', async () => {
    // A group is a pure visual cluster — cross-category/project members are allowed.
    const [a] = await makeTasks(['A'], 'Work', 'EKS');
    const [b] = await makeTasks(['B'], 'Life', 'Home');
    const result = await groupTasks([a, b]);
    expect(result.member_ids.sort()).toEqual([a, b].sort());
    expect((await getTask(a)).group_id).toBe(result.group_id);
    expect((await getTask(b)).group_id).toBe(result.group_id);
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
  it('adds a task to an existing group', async () => {
    const [a, b, c] = await makeTasks(['A', 'B', 'C']);
    const g = await groupTasks([a, b], 'G');
    const result = await addToGroup(g.group_id, [c]);
    expect(result.member_ids.sort()).toEqual([a, b, c].sort());
    expect((await getTask(c)).group_id).toBe(g.group_id);
  });

  it('adds an out-of-scope task to an existing group (no scope rule)', async () => {
    // Cross-category/project members are allowed — grouping has no scope rule.
    const [a, b] = await makeTasks(['A', 'B'], 'Work', 'EKS');
    const [c] = await makeTasks(['C'], 'Life', 'Home');
    const g = await groupTasks([a, b]);
    const result = await addToGroup(g.group_id, [c]);
    expect(result.member_ids.sort()).toEqual([a, b, c].sort());
    expect((await getTask(c)).group_id).toBe(g.group_id);
  });
});

describe('removeFromGroup', () => {
  it('keeps the group alive with a lone member when one of two is removed', async () => {
    // A group survives down to 1 member (acts like a tag) — removing one of two does
    // NOT dissolve it; the lone survivor stays grouped until explicitly dissolved.
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    const result = await removeFromGroup([a]);
    expect(result.removed_ids).toEqual([a]);
    expect(result.dissolved_group_ids).toEqual([]);

    // a is ungrouped; b stays in the group as the lone member.
    expect((await getTask(a)).group_id).toBeUndefined();
    expect((await getTask(b)).group_id).toBe(g.group_id);
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids).toEqual([b]);
  });

  it('dissolves the group only when its LAST member is removed (0 left)', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);
    await removeFromGroup([a]);          // → b is the lone member, group still alive
    const result = await removeFromGroup([b]); // → 0 members, now it dissolves
    expect(result.dissolved_group_ids).toEqual([g.group_id]);
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

describe('setGroupHidden (Focus-area collapse)', () => {
  it('marks a group hidden and unhidden without touching membership', async () => {
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
});

describe('group_id survives raw partial updates (regression: vanishing groups)', () => {
  // Repro for the user-reported bug: a grouped session/incident task loses its
  // group after a while. Root cause — group_id lives in the SQLite `payload`
  // blob (no dedicated column). A raw partial update whose patch carries ANY
  // non-column key (e.g. needs_attention, set on every session phase
  // transition) made taskToRow rewrite the WHOLE payload column from just the
  // patch, silently dropping group_id. Session tasks transition phase often, so
  // their group "disappeared"; plain tasks rarely raw-update, so it looked
  // intermittent.
  it('keeps group_id when updateTaskRaw patches a payload field (needs_attention)', async () => {
    const [a, b] = await makeTasks(['Session task', 'Sibling']);
    const g = await groupTasks([a, b]);
    expect((await getTask(a)).group_id).toBe(g.group_id);

    // Mirror phase.ts: a session phase transition sets a payload-only field.
    await updateTaskRaw(a, { phase: 'AWAIT_HUMAN_ACTION', needs_attention: true });

    const reloaded = await getTask(a);
    expect(reloaded.needs_attention).toBe(true);          // the patch applied
    expect(reloaded.group_id).toBe(g.group_id);           // ...and group_id survived
    // The group still lists both members.
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids.sort()).toEqual([a, b].sort());
  });

  it('keeps group_id across a fresh DB read after a raw payload-field update', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);
    await updateTaskRaw(a, { needs_attention: true });

    // Force a real reload from SQLite — proves it persisted, not just in-memory.
    closeDb();
    _resetForTesting();

    expect((await getTask(a)).group_id).toBe(g.group_id);
  });

  it('keeps group_id when updateTasksBulk patches a payload field', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    await updateTasksBulk([{ id: a, patch: { needs_attention: true } }]);

    expect((await getTask(a)).group_id).toBe(g.group_id);
  });
});

describe('deleteTask group cleanup', () => {
  it('keeps a group alive when a deletion leaves a single member (lone group survives)', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    const g = await groupTasks([a, b]);

    await deleteTask(a);
    // b is now the lone member, but the group survives (acts like a tag).
    expect((await getTask(b)).group_id).toBe(g.group_id);
    const groups = await listGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0].member_ids).toEqual([b]);
  });

  it('prunes the group only when its LAST member is deleted (0 left)', async () => {
    const [a, b] = await makeTasks(['A', 'B']);
    await groupTasks([a, b]);

    await deleteTask(a);  // lone member b remains, group alive
    await deleteTask(b);  // 0 members → group pruned
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
