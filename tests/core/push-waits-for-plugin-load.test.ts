/**
 * A task push that finds its plugin missing only because the plugin set is
 * changing (a boot walk, a reload, a server stopping) is not a sync failure.
 *
 * 2026-10-06: a deploy's SIGTERM disposed the plugins, and a session's phase move
 * a few ms later pushed into the empty registry. The push was refused as "plugin
 * not loaded" at error level (an error card), and the change reached the tracker
 * only through the next server's retry. A boot has the same gap the other way
 * round: sessions reattach before the plugin walk. A plugin that is truly
 * missing must still be reported exactly as before.
 *
 * Real: task-manager's push path, the registry, the loader's operation queue.
 * Mocked: constants (temp home) and the plugin's own sync (records its pushes).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-test-push-plugin-load'));

import { addTask, autoPushIfConfigured, getTask, updateTaskRaw, _resetForTesting } from '../../src/core/task-manager.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { registry, IntegrationRegistry } from '../../src/core/integration-registry.js';
import { disposeLoadedPlugins } from '../../src/core/integration-loader.js';
import { log } from '../../src/logging/index.js';
import { createNoopSync, createMockPlugin } from './plugin-test-utils.js';
import type { RegisteredPlugin } from '../../src/core/integration-types.js';
import type { Task } from '../../src/core/types.js';

const PLUGIN_ID = 'boot-tracker';
const MISSING = `Plugin "${PLUGIN_ID}" not loaded — task not synced`;
const pushed: Array<Pick<Task, 'id' | 'title'>> = [];
let plugin: RegisteredPlugin;

async function seed(): Promise<string> {
  const { task } = await addTask({ title: 'deploy notes', project: 'marina-boot', source: PLUGIN_ID, _skipPluginOps: true });
  await updateTaskRaw(task.id, { ext: { remoteId: 'r-1' } });
  expect((await getTask(task.id)).source).toBe(PLUGIN_ID);
  return task.id;
}

/** Back to a server between lifetimes: not booting, not closing. */
function resetLifecycle(): void {
  registry.beginLoading();
  registry.endLoading();
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
}

const settled = (p: Promise<unknown>) => Promise.race([p.then(() => true), new Promise((r) => setTimeout(() => r(false), 50))]);
const notLoadedErrors = (spy: ReturnType<typeof vi.spyOn>) =>
  spy.mock.calls.filter(([msg]) => msg === 'sync skipped: plugin not loaded');

describe('a push while the plugin set is changing', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
    _resetForTesting();
    resetLifecycle();
    pushed.length = 0;
    const sync = createNoopSync();
    sync.pushTask = async (task: Task) => { pushed.push({ id: task.id, title: task.title }); return { serverTimestamp: new Date().toISOString() }; };
    plugin = createMockPlugin({ id: PLUGIN_ID, sync });
    registry.replace(PLUGIN_ID, plugin);
  });

  afterEach(async () => {
    resetLifecycle();
    vi.restoreAllMocks();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  it('during a boot it waits for the walk, then pushes the task as it is by then', async () => {
    const id = await seed();
    const errors = vi.spyOn(log.task, 'error');
    registry.unregister(PLUGIN_ID);
    registry.beginLoading();

    const push = autoPushIfConfigured(await getTask(id));
    expect(await settled(push), 'held while the plugins load').toBe(false);
    // The task moves on while it waits (a second session event, a human edit).
    await updateTaskRaw(id, { title: 'deploy notes (final)' });

    registry.replace(PLUGIN_ID, plugin);
    registry.endLoading();
    expect(await push).toEqual({ success: true });
    expect(pushed).toEqual([{ id, title: 'deploy notes (final)' }]);
    expect((await getTask(id)).sync_error ?? null).toBeNull();
    expect(notLoadedErrors(errors)).toHaveLength(0);
  });

  it('during a plugin reload it waits for the reload instead of refusing', async () => {
    const id = await seed();
    const errors = vi.spyOn(log.task, 'error');
    const reload = deferred();
    registry.unregister(PLUGIN_ID);
    registry.track(reload.promise);

    const push = autoPushIfConfigured(await getTask(id));
    expect(await settled(push)).toBe(false);
    registry.replace(PLUGIN_ID, plugin);
    reload.resolve();
    expect(await push).toEqual({ success: true });
    expect(pushed).toHaveLength(1);
    expect(notLoadedErrors(errors)).toHaveLength(0);
  });

  it('while the server stops it hands the change to the next server: a warn, a sync_error for the retry, no error', async () => {
    const id = await seed();
    const errors = vi.spyOn(log.task, 'error');
    const warns = vi.spyOn(log.task, 'warn');
    registry.beginClosing();
    registry.unregister(PLUGIN_ID);

    const result = await autoPushIfConfigured(await getTask(id));
    expect(result.success).toBe(false);
    expect(result.error).toBe(`Walnut stopped before this change reached "${PLUGIN_ID}"; it is sent after the restart`);
    // The stamp is what the next server's sync retry lists (listSyncErrorTasks).
    expect((await getTask(id)).sync_error).toBe(result.error);
    expect(notLoadedErrors(errors)).toHaveLength(0);
    expect(warns.mock.calls.filter(([msg]) => msg === 'sync deferred: server stopping')).toHaveLength(1);
    expect(pushed).toHaveLength(0);
  });

  it('a stopping server does not wait on its own dispose: the plugin will not come back', async () => {
    const id = await seed();
    const dispose = deferred();
    registry.beginClosing();
    registry.unregister(PLUGIN_ID);
    registry.track(dispose.promise);
    try {
      expect(await settled(autoPushIfConfigured(await getTask(id)))).toBe(true);
    } finally {
      dispose.resolve();
      await dispose.promise;
    }
  });

  it('a plugin the boot walk did not load is still reported at error, once the walk is over', async () => {
    const id = await seed();
    const errors = vi.spyOn(log.task, 'error');
    registry.unregister(PLUGIN_ID);
    registry.beginLoading();

    const push = autoPushIfConfigured(await getTask(id));
    expect(await settled(push)).toBe(false);
    registry.endLoading();
    const result = await push;
    expect(result).toEqual({ success: false, error: MISSING });
    expect((await getTask(id)).sync_error).toBe(MISSING);
    expect(notLoadedErrors(errors)).toHaveLength(1);
    expect(pushed).toHaveLength(0);
  });

  it('with nothing changing a missing plugin is reported at once, as before', async () => {
    const id = await seed();
    const errors = vi.spyOn(log.task, 'error');
    registry.unregister(PLUGIN_ID);
    const push = autoPushIfConfigured(await getTask(id));
    expect(await settled(push), 'no wait').toBe(true);
    expect(await push).toEqual({ success: false, error: MISSING });
    expect(notLoadedErrors(errors)).toHaveLength(1);
  });

  it('a new boot ends the closing state of the server before it', async () => {
    registry.beginClosing();
    expect(registry.isClosing()).toBe(true);
    registry.beginLoading();
    expect(registry.isClosing()).toBe(false);
  });
});

describe('registry.waitForPlugins', () => {
  afterEach(() => resetLifecycle());

  it('is false at once when nothing is changing', async () => {
    const t0 = Date.now();
    expect(await registry.waitForPlugins(5_000)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(100);
  });

  it('gives up at its deadline, so a walk that never ends cannot hold a push forever', async () => {
    registry.beginLoading();
    const t0 = Date.now();
    expect(await registry.waitForPlugins(80)).toBe(true);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(70);
  });

  it('a failed operation releases its waiters like a finished one', async () => {
    const own = new IntegrationRegistry();
    const op = deferred();
    const failing = op.promise.then(() => { throw new Error('activation failed'); });
    own.track(failing);
    failing.catch(() => undefined);
    const wait = own.waitForPlugins(5_000);
    op.resolve();
    expect(await wait).toBe(true);
    expect(await own.waitForPlugins(5_000)).toBe(false);
  });

  it('every waiter is released by endLoading, and a second beginLoading does not reset an open walk', async () => {
    registry.beginLoading();
    const a = registry.waitForPlugins(5_000);
    registry.beginLoading();
    const b = registry.waitForPlugins(5_000);
    registry.endLoading();
    expect(await Promise.all([a, b])).toEqual([true, true]);
    expect(await registry.waitForPlugins(5_000)).toBe(false);
  });

  it('every plugin lifecycle operation of the loader is tracked', async () => {
    const own = new IntegrationRegistry();
    const op = disposeLoadedPlugins(own);
    // Tracked while it runs, released once it ended.
    const waiting = own.waitForPlugins(5_000);
    await op;
    expect(await waiting).toBe(true);
    expect(await own.waitForPlugins(5_000)).toBe(false);
  });
});

describe('server lifecycle order', () => {
  const server = () => fs.readFile(path.resolve(__dirname, '../../src/web/server.ts'), 'utf8');
  const bodyOf = (src: string, head: string) => {
    const start = src.indexOf(head);
    expect(start, head).toBeGreaterThan(-1);
    const end = src.indexOf('\nexport ', start + head.length);
    return src.slice(start, end === -1 ? undefined : end);
  };

  it('a boot opens the plugin gate before its first await and closes it after the walk', async () => {
    const boot = bodyOf(await server(), 'export async function startServer(');
    const gate = boot.indexOf('registry.beginLoading()');
    expect(gate).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(boot.indexOf('await '));
    const walk = boot.indexOf('await loadPlugins(registry)');
    expect(walk).toBeGreaterThan(gate);
    expect(boot.indexOf('registry.endLoading()', walk)).toBeGreaterThan(walk);
  });

  it('a shutdown marks the registry closing before it disposes the plugins', async () => {
    const stop = bodyOf(await server(), 'export async function stopServer(');
    const closing = stop.indexOf('registry.beginClosing()');
    expect(closing).toBeGreaterThan(-1);
    expect(closing).toBeLessThan(stop.indexOf('disposeLoadedPlugins(registry)'));
    expect(closing).toBeLessThan(stop.indexOf('registry.clear()'));
  });
});
