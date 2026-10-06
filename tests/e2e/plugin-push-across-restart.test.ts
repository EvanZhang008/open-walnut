/**
 * A task change made while the server restarts reaches the plugin, and never
 * cards an error, through the REAL server lifecycle (startServer → plugin walk →
 * stopServer → the next startServer's sync retry).
 *
 * 2026-10-06: a deploy's SIGTERM disposed the plugins first, and a session's phase
 * move a few ms later pushed into the empty registry: "plugin not loaded" at error
 * level, an error card, and the change sent only by the next server's retry. A
 * boot has the same gap the other way round, because sessions reattach before the
 * plugin walk. The push in the shutdown window is placed exactly there by wrapping
 * disposeLoadedPlugins, the step after which the plugin is gone.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Server as HttpServer } from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('push-across-restart'));

const hooks = vi.hoisted(() => ({ afterDispose: null as null | (() => Promise<void>) }));
vi.mock('../../src/core/integration-loader.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../src/core/integration-loader.js')>();
  return {
    ...real,
    disposeLoadedPlugins: async (...args: Parameters<typeof real.disposeLoadedPlugins>) => {
      await real.disposeLoadedPlugins(...args);
      await hooks.afterDispose?.();
    },
  };
});

import { WALNUT_HOME } from '../../src/constants.js';
import { startServer, stopServer } from '../../src/web/server.js';
import { registry } from '../../src/core/integration-registry.js';
import { addTask, autoPushIfConfigured, getTask, updateTaskRaw, type SyncResult } from '../../src/core/task-manager.js';
import { log } from '../../src/logging/index.js';

const PLUGIN_ID = 'restartfix';
const TICK_MS = 250;
const DEFERRED = `Walnut stopped before this change reached "${PLUGIN_ID}"; it is sent after the restart`;

let server: HttpServer | null = null;
let port = 0;
let taskId = '';
const savedEnv: Record<string, string | undefined> = {};

const pluginDir = () => path.join(WALNUT_HOME, 'plugins', PLUGIN_ID);
const pushesFile = () => path.join(pluginDir(), 'pushes.jsonl');

async function boot(): Promise<void> {
  server = await startServer({ port: 0, dev: true });
  const addr = server.address();
  port = typeof addr === 'object' && addr ? addr.port : 0;
}

async function pushedTitles(): Promise<string[]> {
  try {
    const text = await fs.readFile(pushesFile(), 'utf-8');
    return text.split('\n').filter(Boolean).map((line) => (JSON.parse(line) as { title: string }).title);
  } catch {
    return [];
  }
}

async function waitFor<T>(label: string, probe: () => Promise<T | undefined | false>, timeoutMs = 60_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((r) => setTimeout(r, 100));
  }
}

async function feedTitles(): Promise<string[]> {
  const res = await fetch(`http://localhost:${port}/api/notifications`);
  expect(res.status).toBe(200);
  return ((await res.json()) as { feed: Array<{ title: string }> }).feed.map((r) => r.title);
}

const notLoaded = (spy: { mock: { calls: unknown[][] } }) =>
  spy.mock.calls.filter(([msg]) => msg === 'sync skipped: plugin not loaded');

beforeAll(async () => {
  for (const key of ['WALNUT_SYNC_FIRST_TICK_MS', 'WALNUT_DISABLE_SEARCH', 'WALNUT_DISABLE_BACKGROUND_AI']) {
    savedEnv[key] = process.env[key];
  }
  process.env.WALNUT_SYNC_FIRST_TICK_MS = '200';
  process.env.WALNUT_DISABLE_SEARCH = '1';
  process.env.WALNUT_DISABLE_BACKGROUND_AI = '1';

  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(path.join(pluginDir(), 'dist'), { recursive: true });
  await fs.writeFile(path.join(WALNUT_HOME, 'config.yaml'), JSON.stringify({
    version: 1,
    plugins: { [PLUGIN_ID]: { enabled: true, sync_interval_ms: TICK_MS } },
  }, null, 2));
  await fs.writeFile(path.join(pluginDir(), 'manifest.json'), JSON.stringify({
    id: PLUGIN_ID,
    name: 'Restartfix',
    description: 'A fixture sync plugin that records every push.',
    version: '1.0.0',
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
  }, null, 2));
  await fs.writeFile(path.join(pluginDir(), 'dist', 'server.mjs'), `
import fs from 'node:fs';
const PUSHES = ${JSON.stringify(pushesFile())};
const noop = async () => {};
const sync = {
  createTask: async () => null,
  deleteTask: noop, updateTitle: noop, updateDescription: noop, updateSummary: noop, updateNote: noop,
  updateConversationLog: noop, updatePriority: noop, updatePhase: noop, updateDueDate: noop,
  updateProject: noop, updateDependencies: noop,
  pushTask: async (task) => {
    fs.appendFileSync(PUSHES, JSON.stringify({ id: task.id, title: task.title }) + '\\n');
    return { serverTimestamp: new Date().toISOString() };
  },
  associateSubtask: noop, disassociateSubtask: noop,
  syncPoll: noop,
  extractRemoteId: (task) => task.ext?.['${PLUGIN_ID}']?.id,
};
export function activate(walnut) {
  walnut.registry.sync(sync);
  walnut.registry.extIndex({ source: '${PLUGIN_ID}', paths: [{ key: 'id', json: '$."${PLUGIN_ID}".id', unique: true }] });
}
export function deactivate() {}
`);

  await boot();
  await waitFor('plugin loaded', async () => registry.has(PLUGIN_ID));
  const { task } = await addTask({ title: 'restart notes', project: 'marina-restart', source: PLUGIN_ID, _skipPluginOps: true });
  taskId = task.id;
  await updateTaskRaw(taskId, { ext: { [PLUGIN_ID]: { id: 'r-1' } } });
}, 90_000);

afterAll(async () => {
  hooks.afterDispose = null;
  if (server) await stopServer();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

describe('a task change across a server restart', () => {
  it('made after shutdown let the plugins go: handed to the next server, sent by its sync, no error card', async () => {
    const errors = vi.spyOn(log.task, 'error');
    let deferred: SyncResult | null = null;
    hooks.afterDispose = async () => {
      expect(registry.has(PLUGIN_ID), 'the window under test: plugin already gone').toBe(false);
      await updateTaskRaw(taskId, { title: 'restart notes (moved during shutdown)' });
      deferred = await autoPushIfConfigured(await getTask(taskId));
    };
    try {
      await stopServer();
    } finally {
      hooks.afterDispose = null;
      server = null;
    }
    expect(deferred).toEqual({ success: false, error: DEFERRED });
    expect(notLoaded(errors)).toHaveLength(0);

    await boot();
    await waitFor('the next server sends the change', async () =>
      (await pushedTitles()).includes('restart notes (moved during shutdown)'));
    await waitFor('the hand-off stamp is cleared', async () => !(await getTask(taskId)).sync_error);
    expect((await feedTitles()).filter((t) => /plugin not loaded/i.test(t))).toEqual([]);
    expect(notLoaded(errors)).toHaveLength(0);
    errors.mockRestore();
  }, 120_000);

  it('made during a boot, before the plugin walk: waits for the plugin and is sent at once', async () => {
    await stopServer();
    server = null;
    await updateTaskRaw(taskId, { title: 'restart notes (moved during boot)' });
    const errors = vi.spyOn(log.task, 'error');

    const booting = startServer({ port: 0, dev: true });
    expect(registry.has(PLUGIN_ID), 'the window under test: plugin not loaded yet').toBe(false);
    const push = autoPushIfConfigured(await getTask(taskId));
    server = await booting;
    const addr = server.address();
    port = typeof addr === 'object' && addr ? addr.port : 0;

    expect(await push).toEqual({ success: true });
    expect(await pushedTitles()).toContain('restart notes (moved during boot)');
    expect((await getTask(taskId)).sync_error ?? null).toBeNull();
    expect(notLoaded(errors)).toHaveLength(0);
    errors.mockRestore();
  }, 120_000);
});
