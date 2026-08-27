/**
 * task_create — the agent tool's create-time pin tier (2026-08-27).
 *
 * The tool layer is deliberately MORE forgiving than the HTTP edges: a model
 * writes 'Focus' or a custom tier's LABEL, and the schema can't enumerate a
 * dynamic tier set, so resolveTierInput matches case-insensitively and by label
 * before handing an exact id to addTask. What it does NOT do is guess: an
 * unresolvable tier returns the valid list and writes nothing.
 *
 * task_create and task_update share that one resolver, so these also pin that
 * the two tools accept exactly the same spellings.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { executeTool, tools } from '../../src/agent/tools.js';
import { bus } from '../../src/core/event-bus.js';
import {
  createCustomTier, getTierSplit, getTask, listTasks, _resetForTesting,
} from '../../src/core/task-manager.js';
import { closeDb as closeTaskDb } from '../../src/core/task-db.js';
import { closeDb as closeSessionDb } from '../../src/core/session-db.js';

beforeEach(async () => {
  closeTaskDb();
  closeSessionDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
});

afterEach(async () => {
  bus.clear();
  closeTaskDb();
  closeSessionDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

/** The single task in the store (these cases create exactly one). */
async function onlyTask() {
  const all = await listTasks();
  expect(all).toHaveLength(1);
  return getTask(all[0].id);
}

describe('task_create focus_tier', () => {
  it('advertises focus_tier in its schema so the model can reach it', () => {
    const schema = tools.find((t) => t.name === 'task_create')!.input_schema as {
      properties: Record<string, { description?: string }>
    };
    expect(schema.properties).toHaveProperty('focus_tier');
    // The description must say the tier implies pinned — otherwise a model
    // sends focus_tier + pinned:false and gets an error it can't predict.
    expect(schema.properties.focus_tier.description).toMatch(/implies pinned/i);
  });

  it('creates the task directly in a built-in tier', async () => {
    const result = await executeTool('task_create', { title: 'Do now', focus_tier: 'focus' });
    expect(result).toContain('Task created:');

    const task = await onlyTask();
    expect(task.pinned).toBe(true);
    expect(task.focus_tier).toBe('focus');
    expect((await getTierSplit()).focus_tasks).toEqual([task.id]);
  });

  it('accepts a built-in in any casing (models capitalize)', async () => {
    await executeTool('task_create', { title: 'Parked', focus_tier: 'Wait' });
    expect((await onlyTask()).focus_tier).toBe('wait');
  });

  it('normalizes satellite to pinned-with-no-tier', async () => {
    await executeTool('task_create', { title: 'Soon', focus_tier: 'satellite' });
    const task = await onlyTask();
    expect(task.pinned).toBe(true);
    expect(task.focus_tier).toBeUndefined();
    expect((await getTierSplit()).satellite_tasks).toEqual([task.id]);
  });

  it('resolves a custom tier by LABEL to its id (the schema cannot list them)', async () => {
    const { tier } = await createCustomTier('Errands');
    await executeTool('task_create', { title: 'Pick up parcel', focus_tier: 'errands' });

    const task = await onlyTask();
    expect(task.focus_tier).toBe(tier.id);
    expect((await getTierSplit()).custom_tier_tasks[tier.id]).toEqual([task.id]);
  });

  it('resolves a custom tier by id too', async () => {
    const { tier } = await createCustomTier('Household');
    await executeTool('task_create', { title: 'Fix the sink', focus_tier: tier.id });
    expect((await onlyTask()).focus_tier).toBe(tier.id);
  });

  it('returns the valid list and creates NOTHING for an unknown tier', async () => {
    const { tier } = await createCustomTier('Errands');
    const result = await executeTool('task_create', { title: 'Should not exist', focus_tier: 'urgent' });

    expect(result).toContain('unknown focus_tier "urgent"');
    // The model needs the real options to retry in one turn, custom labels included.
    expect(result).toContain('satellite');
    expect(result).toContain(tier.label);
    // A rejected create must not leave a task behind.
    expect(await listTasks()).toEqual([]);
  });

  it('defaults to Satellite when the model names no tier', async () => {
    // No-regression guard: the tool's existing board default is untouched.
    await executeTool('task_create', { title: 'No tier named' });
    const task = await onlyTask();
    expect(task.pinned).toBe(true);
    expect(task.focus_tier).toBeUndefined();
    expect((await getTierSplit()).satellite_tasks).toEqual([task.id]);
  });

  it('still honors pinned:false with no tier (off the board entirely)', async () => {
    await executeTool('task_create', { title: 'Someday maybe', pinned: false });
    const task = await onlyTask();
    expect(task.pinned).toBeFalsy();
    expect((await getTierSplit()).pinned_tasks).toEqual([]);
  });

  it('task_update accepts the same spellings as task_create (one resolver)', async () => {
    const { tier } = await createCustomTier('Errands');
    await executeTool('task_create', { title: 'Move me', focus_tier: 'focus' });
    const task = await onlyTask();

    // By label, on an already-pinned task.
    const byLabel = await executeTool('task_update', { id: task.id, focus_tier: 'Errands' });
    expect(byLabel).toContain('Task updated:');
    expect((await getTask(task.id)).focus_tier).toBe(tier.id);

    // And the same rejection message shape for junk.
    const bad = await executeTool('task_update', { id: task.id, focus_tier: 'urgent' });
    expect(bad).toContain('unknown focus_tier "urgent"');
    // The failed update left the tier alone.
    expect((await getTask(task.id)).focus_tier).toBe(tier.id);
  });
});
