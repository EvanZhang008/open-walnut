/**
 * Remote-sync test isolation — a throwaway server must never write to the user's
 * REAL provider account.
 *
 * The leak this pins (2026-09-02 → 2026-09-08): a temp-home test server copied
 * the user's real config.yaml to get its `hosts` block, which also handed its
 * ms-todo plugin the user's live credentials. A fixture task created against that
 * server was pushed to the user's actual account and created a remote list there;
 * days later the PRODUCTION server's full reconcile pulled that list back and
 * re-created a project the user had deleted, with the fixture task inside it.
 *
 * Two independent layers, one per test group here:
 *   1. the predicate (`remoteSyncIsolationReason`) — what makes a process
 *      "not the user's real Walnut";
 *   2. the loader gate — a SHIPPED sync plugin loses its sync (so it is not a
 *      task source, is never polled, and claims no project) while a test's own
 *      fixture plugin is untouched.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-remote-sync-isolation'));

const pluginConfigs: Record<string, Record<string, unknown>> = {};
vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: pluginConfigs,
  })),
  seedConfigDefaults: vi.fn(async () => {}),
  updatePluginConfig: vi.fn(async () => {}),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { remoteSyncIsolationReason } from '../../src/core/remote-sync-isolation.js';
import { registry } from '../../src/core/integration-registry.js';
import { loadPlugins, disposeLoadedPlugins } from '../../src/core/integration-loader.js';
import { addTask, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';

const NOOP_SYNC_SOURCE = `{
  createTask: async () => null,
  deleteTask: async () => {},
  updateTitle: async () => {},
  updateDescription: async () => {},
  updateSummary: async () => {},
  updateNote: async () => {},
  updateConversationLog: async () => {},
  updatePriority: async () => {},
  updatePhase: async () => {},
  updateDueDate: async () => {},
  updateProject: async () => {},
  updateDependencies: async () => {},
  associateSubtask: async () => {},
  disassociateSubtask: async () => {},
  pushTask: async () => ({ serverTimestamp: new Date().toISOString() }),
  syncPoll: async () => {},
}`;

/** A test's OWN plugin, written into the temp home — must stay fully functional. */
async function writeFixturePlugin(id: string): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: `Fixture ${id}`, version: '1.0.0',
  }));
  await fsp.writeFile(path.join(dir, 'index.mjs'),
    `export default function register(api) {\n  api.registerSync(${NOOP_SYNC_SOURCE});\n  api.registerSourceClaim(() => true, { priority: 5 });\n}\n`);
}

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
  for (const key of Object.keys(pluginConfigs)) delete pluginConfigs[key];
  // The SINGLETON, not a fresh instance: task-manager's addTask consults
  // `registry` from integration-registry.ts, so a private registry would make
  // the "stays local" case below vacuous (it passed with the gate removed).
  registry.clear();
  // Belt and braces for the mutant: with the gate gone the plugin WOULD push,
  // and that must fail here instead of reaching a real Microsoft endpoint.
  vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network refused in test'); }));
});

afterEach(async () => {
  delete process.env.WALNUT_ALLOW_REMOTE_SYNC_IN_TEST;
  await disposeLoadedPlugins(registry).catch(() => {});
  registry.clear();
  vi.unstubAllGlobals();
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('the predicate', () => {
  it('reports a reason inside the test runner', () => {
    expect(remoteSyncIsolationReason()).toBeTruthy();
  });

  it('is silenced by the explicit opt-in', () => {
    process.env.WALNUT_ALLOW_REMOTE_SYNC_IN_TEST = '1';
    expect(remoteSyncIsolationReason()).toBeNull();
  });
});

describe('the loader gate', () => {
  it('strips sync + claim from a SHIPPED sync plugin, even fully configured', async () => {
    // Exactly the leaked shape: real credentials present in the config.
    pluginConfigs['ms-todo'] = { client_id: 'a-real-looking-client-id' };
    await loadPlugins(registry);

    const msTodo = registry.get('ms-todo');
    expect(msTodo, 'the plugin still loads — only its remote writing is refused').toBeDefined();
    expect(msTodo!.hasSync).toBe(false);
    expect(msTodo!.claim).toBeUndefined();
    expect(registry.isTaskSource('ms-todo')).toBe(false);
    expect(registry.getSyncPlugins().map((p) => p.id)).not.toContain('ms-todo');
  });

  it('so a task naming any project stays LOCAL — nothing is ever pushed', async () => {
    pluginConfigs['ms-todo'] = { client_id: 'a-real-looking-client-id' };
    await loadPlugins(registry);

    // ms-todo claims EVERY project (priority 0), so without the gate this task
    // would be born source=ms-todo and pushed. Assert the decision at both
    // layers: the registry has no ms-todo claim, and the row that lands is local.
    expect((await registry.getForProject('Fix Walnut')).id).toBe('local');
    // The 2026-09-02 command, verbatim in shape: task_create with a project.
    const { task } = await addTask({ title: 'A8 probe plain', project: 'Fix Walnut' });
    expect(task.source).toBe('local');
    expect(task.ext).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('leaves a TEST FIXTURE plugin fully functional (it is not the leak)', async () => {
    await writeFixturePlugin('fixture-sync');
    await loadPlugins(registry);

    const fixture = registry.get('fixture-sync');
    expect(fixture).toBeDefined();
    expect(fixture!.hasSync).toBe(true);
    expect(registry.isTaskSource('fixture-sync')).toBe(true);
  });

  it('opting in restores the shipped plugin as a task source', async () => {
    process.env.WALNUT_ALLOW_REMOTE_SYNC_IN_TEST = '1';
    pluginConfigs['ms-todo'] = { client_id: 'a-real-looking-client-id' };
    await loadPlugins(registry);

    expect(registry.get('ms-todo')?.hasSync).toBe(true);
    expect(registry.isTaskSource('ms-todo')).toBe(true);
  });
});
