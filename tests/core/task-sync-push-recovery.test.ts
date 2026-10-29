/**
 * A plugin whose push failed recovers on its NEXT push that succeeds.
 *
 * The "couldn't save a task change" card is keyed `plugin:<id>` and minted at the
 * push's catch site (task-manager.ts). The sync loop only publishes that key on a
 * PULL failure→success edge, so a push that failed once while pulls stayed
 * healthy would stay red until the next restart. The push path publishes it
 * itself through the injected publisher.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-push-recovery'));

import { addTask, updateTask, updateTaskRaw, _resetForTesting, setPushRecoveryPublisher, settleBackgroundPushes } from '../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { createNoopSync, createMockPlugin } from './plugin-test-utils.js';
import { TaskSyncError } from '../../src/core/task-sync-error.js';

const PLUGIN_ID = 'fake-push-recovery-target';

describe('push failure → push success publishes the plugin recovery key', () => {
  let published: string[][];
  let failing: boolean;

  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
    published = [];
    failing = true;
    setPushRecoveryPublisher((keys) => { published.push(keys); });
    const sync = createNoopSync();
    sync.createTask = async () => ({ remoteId: 'r-1' });
    sync.pushTask = async () => {
      if (failing) throw new Error('sign-in expired (HTTP 302 redirect)');
      return { serverTimestamp: new Date().toISOString() };
    };
    if (registry.has(PLUGIN_ID)) registry.unregister(PLUGIN_ID);
    registry.register(PLUGIN_ID, createMockPlugin({ id: PLUGIN_ID, sync }));
  });

  afterEach(async () => {
    setPushRecoveryPublisher(null);
    await settleBackgroundPushes();
    registry.unregister(PLUGIN_ID);
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  async function seed(): Promise<string> {
    const { task } = await addTask({ title: 'push recovery probe', project: 'marina-external', source: PLUGIN_ID, _skipPluginOps: true });
    await updateTaskRaw(task.id, { ext: { remoteId: 'r-1' } });
    return task.id;
  }

  it('the failing push throws a TaskSyncError naming the plugin; the next good push publishes plugin:<id> once', async () => {
    const id = await seed();
    const err = await updateTask(id, { title: 'first' }, { source: 'api' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TaskSyncError);
    expect((err as TaskSyncError).pluginId).toBe(PLUGIN_ID);
    expect((err as Error).message).toMatch(/^Sync to fake-push-recovery-target failed: sign-in expired/);
    expect(published).toEqual([]);

    failing = false;
    await updateTask(id, { title: 'second' }, { source: 'api' });
    expect(published).toEqual([[`plugin:${PLUGIN_ID}:push`]]);

    // A healthy plugin's pushes publish nothing more (the edge fired once).
    await updateTask(id, { title: 'third' }, { source: 'api' });
    expect(published).toEqual([[`plugin:${PLUGIN_ID}:push`]]);
  });

  it('a push that never failed publishes nothing', async () => {
    failing = false;
    const id = await seed();
    await updateTask(id, { title: 'fine' }, { source: 'api' });
    expect(published).toEqual([]);
  });
});
