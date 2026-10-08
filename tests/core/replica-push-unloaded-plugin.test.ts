/**
 * On the cloud companion, a task whose plugin it does not run is the primary's
 * to push.
 *
 * 2026-10-07: each phone edit of a task synced by a plugin whose config lives on
 * the Mac logged "sync skipped: plugin not loaded" on the companion (an error
 * card, a sync_error stamp), although the same edit also went to the Mac, which
 * runs that plugin. The card was keyed `plugin:<id>` and origin-scoped, so no
 * success on either box could retire it.
 *
 * Real: task-manager's push path, the registry, the notification store.
 * Mocked: constants (temp home, CLOUD_MODE on) and the loaded plugin's sync.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-replica-push', { CLOUD_MODE: true }));

import { addTask, autoPushIfConfigured, getTask, updateTaskRaw, _resetForTesting } from '../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { log } from '../../src/logging/index.js';
import { expireOwnCardsOfUnloadedPlugins, listNotifications } from '../../src/core/notifications/store.js';
import { createNoopSync, createMockPlugin } from './plugin-test-utils.js';
import type { Task } from '../../src/core/types.js';

const NOT_HERE = 'mac-only-tracker';
const HERE = 'shared-tracker';
const pushed: string[] = [];

async function seed(source: string): Promise<string> {
  // One project per source: a project keeps the source that first claimed it.
  const { task } = await addTask({ title: `edit for ${source}`, project: `marina-${source}`, source, _skipPluginOps: true });
  await updateTaskRaw(task.id, { ext: { remoteId: `r-${source}` } });
  expect((await getTask(task.id)).source).toBe(source);
  return task.id;
}

describe('a push on the cloud companion', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
    registry.beginLoading();
    registry.endLoading();
    pushed.length = 0;
    const sync = createNoopSync();
    sync.pushTask = async (task: Task) => { pushed.push(task.id); return { serverTimestamp: new Date().toISOString() }; };
    registry.replace(HERE, createMockPlugin({ id: HERE, sync }));
  });

  afterEach(async () => {
    registry.unregister(HERE);
    vi.restoreAllMocks();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('for a plugin it does not run: no push, no error, no sync_error', async () => {
    const id = await seed(NOT_HERE);
    const errors = vi.spyOn(log.task, 'error');
    const result = await autoPushIfConfigured(await getTask(id));
    expect(result).toEqual({ success: true });
    expect(errors.mock.calls.filter(([msg]) => msg === 'sync skipped: plugin not loaded')).toHaveLength(0);
    expect((await getTask(id)).sync_error).toBeUndefined();
    expect(pushed).toEqual([]);
  });

  it('for a plugin it runs: pushes as before', async () => {
    const id = await seed(HERE);
    const result = await autoPushIfConfigured(await getTask(id));
    expect(result.success).toBe(true);
    expect(pushed).toEqual([id]);
  });
});

describe('expireOwnCardsOfUnloadedPlugins', () => {
  const boot = 1_800_000_000_000;
  const card = (dedupKey: string, recoveryKey: string, timestamp: number, origin?: 'replica') => ({
    id: `n-${dedupKey}`, kind: 'operation-error', severity: 'error', title: 'Sync skipped: plugin not loaded',
    timestamp, read: false, dedupKey, recoveryKey, ...(origin ? { origin } : {}),
  });

  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    await fs.mkdir(WALNUT_HOME, { recursive: true });
    await fs.writeFile(path.join(WALNUT_HOME, 'notifications.json'), JSON.stringify({
      version: 1,
      notifications: [
        card('own-unloaded', `plugin:${NOT_HERE}`, boot - 60_000, 'replica'),
        card('own-unloaded-create', `plugin:${NOT_HERE}:create:t1`, boot - 60_000, 'replica'),
        card('own-loaded', `plugin:${HERE}`, boot - 60_000, 'replica'),
        card('own-this-boot', `plugin:${NOT_HERE}`, boot + 1_000, 'replica'),
        card('primary-unloaded', `plugin:${NOT_HERE}`, boot - 60_000),
        card('own-other-key', 'git', boot - 60_000, 'replica'),
      ],
    }));
  });

  afterEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('expires only this box\'s cards for plugins it does not run, raised before the boot', async () => {
    const { expired } = await expireOwnCardsOfUnloadedPlugins((id) => id === HERE, boot);
    expect(expired.map(r => r.dedupKey).sort()).toEqual(['own-unloaded', 'own-unloaded-create']);
    const feed = (await listNotifications()).feed;
    const state = (k: string) => feed.find(n => n.dedupKey === k)?.resolved;
    expect(state('own-unloaded')).toBe('expired');
    expect(state('own-loaded')).toBeUndefined();
    expect(state('own-this-boot')).toBeUndefined();
    expect(state('primary-unloaded')).toBeUndefined();
    expect(state('own-other-key')).toBeUndefined();
  });

  it('a second pass finds nothing to do', async () => {
    await expireOwnCardsOfUnloadedPlugins((id) => id === HERE, boot);
    const { expired } = await expireOwnCardsOfUnloadedPlugins((id) => id === HERE, boot);
    expect(expired).toEqual([]);
  });
});
