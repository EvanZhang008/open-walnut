/**
 * Due-date precision echo guard — sync pull must not strip the time component.
 *
 * External task trackers only store DAY precision. When a user sets a
 * time-level due date (e.g. the "8h" quick pill → 2026-07-29T21:53:11Z), the
 * push truncates it to the day, and the next delta pull echoes back
 * "2026-07-29". Before the guard, that echo overwrote the local time-level
 * value → the task's deferral evaporated minutes after being set (real
 * incident, 2026-07-29). The guard lives in prepareRawUpdate (shared by
 * updateTaskRaw + updateTasksBulk — i.e. every sync-pull write path) and in
 * addTaskFull's dedup-merge branch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask,
  addTaskFull,
  getTask,
  updateTask,
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

const TIME_LEVEL = '2026-07-29T21:53:11.234Z';
const SAME_DAY = '2026-07-29';
const OTHER_DAY = '2026-08-15';

async function makeTaskWithTimeDue(): Promise<string> {
  const { task } = await addTask({ title: 'Deferred', category: 'Work', project: 'Marina' });
  await updateTask(task.id, { due_date: TIME_LEVEL });
  return task.id;
}

describe('updateTaskRaw (sync pull path)', () => {
  it('drops a same-day date-only echo, preserving the time-level due date', async () => {
    const id = await makeTaskWithTimeDue();
    const { changed } = await updateTaskRaw(id, { due_date: SAME_DAY });
    expect(changed).toBe(false); // echo-only patch is a no-op
    expect((await getTask(id)).due_date).toBe(TIME_LEVEL);
  });

  it('still applies a genuinely different day', async () => {
    const id = await makeTaskWithTimeDue();
    const { changed } = await updateTaskRaw(id, { due_date: OTHER_DAY });
    expect(changed).toBe(true);
    expect((await getTask(id)).due_date).toBe(OTHER_DAY);
  });

  it('applies other fields even when the due_date part is an echo', async () => {
    const id = await makeTaskWithTimeDue();
    const { changed } = await updateTaskRaw(id, { due_date: SAME_DAY, title: 'Renamed remotely' });
    expect(changed).toBe(true);
    const after = await getTask(id);
    expect(after.title).toBe('Renamed remotely');
    expect(after.due_date).toBe(TIME_LEVEL);
  });

  it('does not guard when local value is already day-level', async () => {
    const { task } = await addTask({ title: 'Plain', category: 'Work', project: 'Marina' });
    await updateTask(task.id, { due_date: SAME_DAY });
    const { changed } = await updateTaskRaw(task.id, { due_date: OTHER_DAY });
    expect(changed).toBe(true);
    expect((await getTask(task.id)).due_date).toBe(OTHER_DAY);
  });
});

describe('updateTasksBulk (reconciler path)', () => {
  it('drops the echo per-row while applying real changes', async () => {
    const id = await makeTaskWithTimeDue();
    const { changed } = await updateTasksBulk([{ id, patch: { due_date: SAME_DAY } }]);
    expect(changed).toHaveLength(0);
    expect((await getTask(id)).due_date).toBe(TIME_LEVEL);
  });
});

describe('addTaskFull dedup merge (pull-create path)', () => {
  it('preserves the time-level due date when the pulled snapshot has the truncated day', async () => {
    const { task } = await addTask({ title: 'Synced', category: 'Work', project: 'Marina' });
    await updateTaskRaw(task.id, {
      due_date: TIME_LEVEL,
      ext: { acme: { id: 'r-1' } },
      source: 'acme',
    } as any);

    const merged = await addTaskFull({
      title: 'Synced',
      status: 'todo',
      phase: 'TODO',
      priority: 'none',
      category: 'Work',
      project: 'Marina',
      source: 'acme',
      ext: { acme: { id: 'r-1' } },
      session_ids: [],
      due_date: SAME_DAY,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as any);

    expect(merged.id).toBe(task.id);
    expect(merged.due_date).toBe(TIME_LEVEL);
  });
});

describe('updateTask (human edit path) is unaffected', () => {
  it('lets a human explicitly set the same day as date-only', async () => {
    const id = await makeTaskWithTimeDue();
    await updateTask(id, { due_date: SAME_DAY });
    expect((await getTask(id)).due_date).toBe(SAME_DAY);
  });
});
