/**
 * createForkSiblingTask: the shape BOTH "fork this session" and "promote a side
 * thread" create: a SIBLING task of the source (never a subtask) that shares a
 * folder with it.
 *
 * The LLM label summarizers are stubbed, so these tests pin the decisions the
 * helper makes on its own: which folder the pair lands in, which title wins, and
 * whether the background refine is allowed to run at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

const forkTitle = vi.hoisted(() => ({
  summarizeForkPrompt: vi.fn(async () => 'Retry Backoff'),
  summarizeGroupLabel: vi.fn(async () => 'Reaper Work'),
}));

vi.mock('../../src/constants.js', () => createMockConstants('walnut-fork-sibling'));
// Stubbed so nothing here can reach a model provider.
vi.mock('../../src/core/fork-title.js', () => forkTitle);

import { WALNUT_HOME } from '../../src/constants.js';
import {
  addTask, getTask, groupTasks, listGroups, _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import {
  createForkSiblingTask, SessionControlError,
} from '../../src/core/sessions/session-controls.js';

const PROJECT = 'Marina';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  forkTitle.summarizeForkPrompt.mockClear();
  forkTitle.summarizeGroupLabel.mockClear();
});

afterEach(async () => {
  // Let any fire-and-forget refine settle before the store is wiped under it.
  await new Promise((r) => setTimeout(r, 30));
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function source(title = 'Reaper stalls'): Promise<string> {
  const { task } = await addTask({ title, project: PROJECT, pinned: true });
  return task.id;
}

/** Poll a fire-and-forget background refine until it lands. The budget is loose
 *  on purpose: this machine runs test suites concurrently. */
async function waitFor(read: () => Promise<string | undefined>, want: string): Promise<string | undefined> {
  for (let i = 0; i < 250; i++) {
    const got = await read();
    if (got === want) return got;
    await new Promise((r) => setTimeout(r, 20));
  }
  return read();
}

async function groupLabel(groupId: string | undefined): Promise<string | undefined> {
  return (await listGroups()).find((g) => g.group_id === groupId)?.label;
}

describe('createForkSiblingTask', () => {
  it('is a sibling, never a subtask, and reuses the source folder', async () => {
    const src = await source();
    const { task: neighbour } = await addTask({ title: 'Neighbour', project: PROJECT });
    const { group_id } = await groupTasks([src, neighbour.id], 'Reaper Folder');

    const res = await createForkSiblingTask(src, {
      childTitle: 'Split the reaper', source: 'test',
    });

    expect(res.task.parent_task_id).toBeUndefined();
    expect(res.groupId).toBe(group_id);
    expect((await getTask(res.task.id)).group_id).toBe(group_id);
    expect(res.task.title).toBe('Split the reaper');
    // An established folder keeps its name, so no group refine may run.
    await new Promise((r) => setTimeout(r, 30));
    expect(forkTitle.summarizeGroupLabel).not.toHaveBeenCalled();
    expect(await groupLabel(group_id)).toBe('Reaper Folder');
  });

  it('creates a folder holding both tasks when the source has none, then names it', async () => {
    const src = await source();

    const res = await createForkSiblingTask(src, { titlePrefix: 'Why flaky', source: 'test' });

    expect(res.groupId).toBeTruthy();
    expect((await getTask(src)).group_id).toBe(res.groupId);
    expect((await getTask(res.task.id)).group_id).toBe(res.groupId);

    // Fresh folder → the label is seeded from the source title and refined after.
    expect(await waitFor(() => groupLabel(res.groupId), 'Reaper Work')).toBe('Reaper Work');
  });

  it('titlePrefix names the task directly and short-circuits the title refine', async () => {
    const src = await source();

    const res = await createForkSiblingTask(src, {
      titlePrefix: 'Why flaky', prompt: 'why is this test flaky?', source: 'test',
    });

    expect(res.task.title).toBe('Why flaky - fork of Reaper stalls');
    await new Promise((r) => setTimeout(r, 60));
    expect(forkTitle.summarizeForkPrompt).not.toHaveBeenCalled();
    expect((await getTask(res.task.id)).title).toBe('Why flaky - fork of Reaper stalls');
  });

  it('refines the placeholder title from the prompt when no title is supplied', async () => {
    const src = await source();

    const res = await createForkSiblingTask(src, {
      prompt: 'add exponential retry backoff to the sender', source: 'test',
    });

    expect(res.task.title).toBe('Fork of Reaper stalls');
    const want = 'Retry Backoff - fork of Reaper stalls';
    expect(await waitFor(async () => (await getTask(res.task.id)).title, want)).toBe(want);
  });

  it('stores the description and inherits the source project + pin', async () => {
    const src = await source();

    const res = await createForkSiblingTask(src, {
      titlePrefix: 'Reaper split', description: 'should we split the reaper?', source: 'test',
    });

    const stored = await getTask(res.task.id);
    expect(stored.description).toBe('should we split the reaper?');
    expect(stored.project).toBe(PROJECT);
    expect(stored.pinned).toBe(true);
  });

  it('404s when the source task does not exist', async () => {
    await expect(createForkSiblingTask('ffffffff-dead-4000-8000-ffffffffffff', { source: 'test' }))
      .rejects.toMatchObject({ statusCode: 404 });
    await expect(createForkSiblingTask('ffffffff-dead-4000-8000-ffffffffffff', { source: 'test' }))
      .rejects.toBeInstanceOf(SessionControlError);
  });
});
