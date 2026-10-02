/**
 * Every task tag is key:value (src/core/tag-model.ts), at every write path and every filter:
 *   - addTask, updateTask (set/add/remove) and the batch filing write store a plain word as
 *     `label:<word>`, so removing or filtering by `oncall` still means that label;
 *   - `sprint:<name>` still goes to the sprint field, not the tag list;
 *   - `created:` / `updated:` are the task's own dates: never stored, matched by a filter
 *     through both the SQL pushdown and the JS predicate.
 * Real SQLite under a temp home; nothing mocked but the constants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-tags-kv'));

import {
  _resetForTesting,
  addTask,
  fileTasksIntoProject,
  getTask,
  queryTasks,
  updateTask,
  updateTasksBulk,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { localDay } from '../../src/core/tag-model.js';

async function freshHome(): Promise<void> {
  if (!WALNUT_HOME.includes('walnut-task-tags-kv')) throw new Error(`refusing to run against ${WALNUT_HOME}`);
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
}

beforeEach(freshHome);
afterEach(freshHome);

describe('tag writes', () => {
  it('stores a plain word as a label at create, and dedupes what folds together', async () => {
    const { task } = await addTask({ title: 'a', project: 'Local', source: 'local', tags: ['oncall', 'label:oncall', 'Sev:2', '  '] } as never);
    expect(task.tags).toEqual(['label:oncall', 'sev:2']);
    expect((await getTask(task.id)).tags).toEqual(['label:oncall', 'sev:2']);
  });

  it('adds, removes and replaces in stored form, and keeps sprint: out of the list', async () => {
    const { task } = await addTask({ title: 'b', project: 'Local', source: 'local', tags: ['sev:2'] } as never);
    await updateTask(task.id, { add_tags: ['bug', 'label:bug', 'sprint:S12'] });
    let after = await getTask(task.id);
    expect(after.tags).toEqual(['sev:2', 'label:bug']);
    expect(after.sprint).toBe('S12');

    // Removing the plain word removes the label it is stored as.
    await updateTask(task.id, { remove_tags: ['bug'] });
    expect((await getTask(task.id)).tags).toEqual(['sev:2']);

    await updateTask(task.id, { set_tags: ['ux', 'Team:Marina'] });
    after = await getTask(task.id);
    expect(after.tags).toEqual(['label:ux', 'team:Marina']);

    await updateTask(task.id, { set_tags: [] });
    expect((await getTask(task.id)).tags).toBeUndefined();
  });

  it('never stores a derived date tag', async () => {
    const { task } = await addTask({ title: 'c', project: 'Local', source: 'local', tags: ['created:2026-01-01'] } as never);
    expect(task.tags).toEqual(['label:created:2026-01-01']);
  });

  it('files with tags in stored form, so a plain-word add of a label the task has is no change', async () => {
    const { task } = await addTask({ title: 'd', project: 'Import', source: 'local', tags: ['label:oncall'] } as never);
    const result = await fileTasksIntoProject('Team', [{ id: task.id, add_tags: ['oncall', 'ticket:P1'], remove_tags: [] }]);
    expect(result.filed.map((t) => t.id)).toEqual([task.id]);
    expect((await getTask(task.id)).tags).toEqual(['label:oncall', 'ticket:P1']);
    await fileTasksIntoProject('Team', [{ id: task.id, remove_tags: ['oncall'] }]);
    expect((await getTask(task.id)).tags).toEqual(['ticket:P1']);
  });

  it('stores a bulk write\'s tags in stored form too', async () => {
    const { task } = await addTask({ title: 'e', project: 'Local', source: 'local' } as never);
    await updateTasksBulk([{ id: task.id, patch: { tags: ['bah', 'sev:1'] } }]);
    expect((await getTask(task.id)).tags).toEqual(['label:bah', 'sev:1']);
  });
});

describe('tag filters', () => {
  it('matches a plain word as its label', async () => {
    const { task } = await addTask({ title: 'f', project: 'Local', source: 'local', tags: ['oncall'] } as never);
    expect((await queryTasks({ tagsAny: ['oncall'] })).map((t) => t.id)).toEqual([task.id]);
    expect((await queryTasks({ tagsAll: ['label:oncall'] })).map((t) => t.id)).toEqual([task.id]);
    expect(await queryTasks({ tagsAny: ['other'] })).toEqual([]);
  });

  it('matches created:/updated: against the task\'s own dates, alone and with a stored tag', async () => {
    const { task } = await addTask({ title: 'g', project: 'Local', source: 'local', tags: ['sev:2'] } as never);
    const { task: other } = await addTask({ title: 'h', project: 'Local', source: 'local' } as never);
    await updateTasksBulk([{ id: other.id, patch: { created_at: '2020-01-01T12:00:00.000Z', updated_at: '2020-01-02T12:00:00.000Z' } }]);
    const today = localDay(task.created_at)!;
    const ids = async (query: Parameters<typeof queryTasks>[0]) => (await queryTasks(query)).map((t) => t.id).sort();

    expect(await ids({ tagsAny: [`created:${today}`] })).toEqual([task.id]);
    expect(await ids({ tagsAll: [`created:${today}`, 'sev:2'] })).toEqual([task.id]);
    expect(await ids({ tagsAll: [`updated:${localDay('2020-01-02T12:00:00.000Z')}`] })).toEqual([other.id]);
    expect(await ids({ tagsAny: ['created:1999-01-01', 'sev:2'] })).toEqual([task.id]);
    expect(await ids({ tagsAll: ['created:1999-01-01'] })).toEqual([]);
  });
});
