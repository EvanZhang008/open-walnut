/**
 * updateTask's asyncPush option — the fix for the 2026-07-31 connection-pool
 * cascade: PATCH /api/tasks/:id awaited the external plugin push (a 2-3s network
 * round-trip per call), holding browser connections long enough to saturate the
 * 6-per-origin pool and time out every unrelated request.
 *
 * Contract under test:
 *   - asyncPush: true  → updateTask returns as soon as the local write lands;
 *     the plugin push still happens (in the background).
 *   - asyncPush: true  → a failing push does NOT reject updateTask.
 *   - default (no flag) → push is awaited and failures propagate (unchanged).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-async-push'));

import { addTask, updateTask, _resetForTesting } from '../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry } from '../../src/core/integration-registry.js';
import { createNoopSync, createMockPlugin } from './plugin-test-utils.js';

const PLUGIN_ID = 'fake-async-push-target';

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe('updateTask asyncPush', () => {
  let pushGate: ReturnType<typeof deferred<{ serverTimestamp: string }>>;
  let pushCalls: number;

  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
    pushGate = deferred<{ serverTimestamp: string }>();
    pushCalls = 0;

    const sync = createNoopSync();
    // createTask returns ext so the seeded task has a remote id — that's what
    // routes autoPushIfConfigured onto the pushTask path in later updates.
    sync.createTask = async () => ({ remoteId: 'r-1' });
    sync.pushTask = async () => { pushCalls += 1; return pushGate.promise; };
    if (!registry.has(PLUGIN_ID)) {
      registry.register(PLUGIN_ID, createMockPlugin({ id: PLUGIN_ID, sync }));
    } else {
      // Re-point the existing registration's sync fns at this test's gate/counter.
      const existing = registry.get(PLUGIN_ID)!;
      existing.sync.createTask = sync.createTask;
      existing.sync.pushTask = sync.pushTask;
    }
  });

  afterEach(async () => {
    // Unblock any background push still parked on the gate before teardown.
    pushGate.resolve({ serverTimestamp: new Date().toISOString() });
    await new Promise((r) => setTimeout(r, 0));
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  async function seedPluginTask(): Promise<string> {
    // A project is REQUIRED for a provider-sourced task: Inbox (no project) has no
    // registry row and can never be claimed, so addTask would reject source=plugin
    // there — and autoPushIfConfigured no-ops on local anyway.
    const { task } = await addTask({
      title: 'async push probe',
      project: 'marina-external',
      source: PLUGIN_ID,
      _skipPluginOps: true,
    });
    // Give it ext data so autoPushIfConfigured takes the pushTask path (not createTask).
    const { updateTaskRaw, getTask } = await import('../../src/core/task-manager.js');
    const raw = await updateTaskRaw(task.id, { ext: { remoteId: 'r-1' } });
    const fresh = await getTask(task.id);
    // Seed sanity — if ext didn't persist or the source resolved to 'local'
    // (autoPushIfConfigured no-ops on local), every assertion below fails
    // confusingly far from the real cause.
    expect(raw.changed, 'updateTaskRaw must persist ext').toBe(true);
    expect(fresh?.ext?.remoteId).toBe('r-1');
    expect(fresh?.source, 'task must keep the plugin source').toBe(PLUGIN_ID);
    return task.id;
  }

  it('returns before the plugin push settles, then pushes in the background', async () => {
    const id = await seedPluginTask();
    const before = pushCalls;

    // Gate is unresolved — an awaited push would hang this call forever.
    const result = await Promise.race([
      updateTask(id, { title: 'renamed fast' }, { source: 'api', asyncPush: true }),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 2000)),
    ]);

    expect(result).not.toBe('timeout');
    expect((result as { task: { title: string } }).task.title).toBe('renamed fast');

    // The background push was still dispatched.
    pushGate.resolve({ serverTimestamp: new Date().toISOString() });
    await vi.waitFor(() => expect(pushCalls).toBeGreaterThan(before));
  });

  it('does not reject the caller when the background push fails', async () => {
    const id = await seedPluginTask();
    const { task } = await updateTask(id, { title: 'still ok' }, { source: 'api', asyncPush: true });
    expect(task.title).toBe('still ok');
    // Fail the push after the caller already returned — must not surface as unhandled.
    pushGate.reject(new Error('remote exploded'));
    await new Promise((r) => setTimeout(r, 10));
  });

  it('default (no asyncPush) still awaits the push and propagates failure', async () => {
    const id = await seedPluginTask();
    // Throw from pushTask itself (not by rejecting the shared gate up front —
    // rejecting a promise nobody has awaited yet trips vitest's unhandled-
    // rejection detector even though the flow under test handles it).
    const plugin = registry.get(PLUGIN_ID)!;
    plugin.sync.pushTask = async () => { throw new Error('remote exploded'); };
    await expect(
      updateTask(id, { title: 'blocking path' }, { source: 'api' }),
    ).rejects.toThrow(/Sync to .* failed/);
  });
});
