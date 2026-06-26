import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { addTask, getTask, _resetForTesting } from '../../src/core/task-manager.js';
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
  it('explicit source=local forces a local task in a brand-new category', async () => {
    const { task } = await addTask({ title: 'Captured', category: 'Inbox', source: 'local' });
    expect(task.source).toBe('local');
    expect(task.category).toBe('Inbox');
  });

  it('explicit source routes a new-category task to that platform', async () => {
    const { task } = await addTask({ title: 'External capture', category: 'NewExtCat', source: EXTERNAL });
    expect(task.source).toBe(EXTERNAL);
  });

  it('an established category source wins over a conflicting explicit source request', async () => {
    // First task establishes 'Shared' as external.
    await addTask({ title: 'first', category: 'Shared', source: EXTERNAL });
    // A later capture asking for local in the SAME category keeps the established
    // external source — the category is never split across two sources. (input.source
    // only takes effect for brand-new categories, where storeCatSource is undefined.)
    const { task } = await addTask({ title: 'second', category: 'Shared', source: 'local' });
    expect(task.source).toBe(EXTERNAL);
  });
});

describe('async push (instant create)', () => {
  it('local-source create returns success without any external round-trip', async () => {
    const { task, syncResult } = await addTask({ title: 'local task', category: 'Inbox', source: 'local', asyncPush: true });
    expect(task.source).toBe('local');
    expect(syncResult.success).toBe(true);
  });

  it('asyncPush returns immediately and the task is already persisted locally', async () => {
    const { task, syncResult } = await addTask({
      title: 'ext async', category: 'AsyncExtCat', source: EXTERNAL, asyncPush: true,
    });
    // Returns "accepted" immediately — caller does not block on the push round-trip.
    expect(syncResult.success).toBe(true);
    // The task row exists locally right away, regardless of push completion.
    const fresh = await getTask(task.id);
    expect(fresh?.id).toBe(task.id);
    expect(fresh?.title).toBe('ext async');
  });
});
