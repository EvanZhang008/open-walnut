import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { addTask, getTask, getProjectRecord, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { createMockPlugin } from './plugin-test-utils.js';

// A fake external plugin so explicit-source routing has a real target to validate against.
const EXTERNAL = 'plugin-ext';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  if (!registry.has(EXTERNAL)) registry.register(EXTERNAL, createMockPlugin({ id: EXTERNAL }));
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('default platform routing', () => {
  it('a task with no project lands in Inbox and is always local', async () => {
    const { task } = await addTask({ title: 'Captured' });
    expect(task.project).toBe('');
    expect(task.source).toBe('local');
  });

  it('explicit source claims a brand-new project for that platform', async () => {
    const { task } = await addTask({ title: 'External capture', project: 'NewExtProj', source: EXTERNAL });
    expect(task.source).toBe(EXTERNAL);
    // The auto-created registry row carries the claim.
    expect(await getProjectRecord('newextproj')).toMatchObject({
      name: 'NewExtProj', source: EXTERNAL,
    });
  });

  it("an established project's claim wins over a conflicting PROVIDER source request", async () => {
    // First task claims 'Shared' for the external plugin.
    await addTask({ title: 'first', project: 'Shared', source: EXTERNAL });
    // A later capture asking for a DIFFERENT provider keeps the established
    // claim — a project's synced tasks are never split across two providers.
    const { task } = await addTask({ title: 'second', project: 'Shared', source: 'other-provider' as never });
    expect(task.source).toBe(EXTERNAL);
  });

  it('an explicit LOCAL source stays local even in a claimed project (never-sync)', async () => {
    await addTask({ title: 'first', project: 'Shared', source: EXTERNAL });
    // 'local' is the never-sync override: the project acts as a folder and the
    // task never pushes — the quick-start duplication fix depends on this.
    const { task } = await addTask({ title: 'second', project: 'Shared', source: 'local' });
    expect(task.source).toBe('local');
    expect(task.ext).toBeUndefined();
  });

  it('refuses a provider-sourced task with no project (Inbox is unclaimable)', async () => {
    await expect(addTask({ title: 'Nowhere', source: EXTERNAL })).rejects.toThrow(/Inbox/);
  });
});

describe('async push (instant create)', () => {
  it('local-source create returns success without any external round-trip', async () => {
    const { task, syncResult } = await addTask({ title: 'local task', source: 'local', asyncPush: true });
    expect(task.source).toBe('local');
    expect(syncResult.success).toBe(true);
  });

  it('asyncPush returns immediately and the task is already persisted locally', async () => {
    const { task, syncResult } = await addTask({
      title: 'ext async', project: 'AsyncExtProj', source: EXTERNAL, asyncPush: true,
    });
    // Returns "accepted" immediately — caller does not block on the push round-trip.
    expect(syncResult.success).toBe(true);
    // The task row exists locally right away, regardless of push completion.
    const fresh = await getTask(task.id);
    expect(fresh?.id).toBe(task.id);
    expect(fresh?.title).toBe('ext async');
  });
});
