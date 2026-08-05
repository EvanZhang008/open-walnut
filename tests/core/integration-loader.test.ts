/**
 * Unit tests for integration-loader.ts.
 *
 * Tests:
 * - migrateConfigToPlugins: legacy config key migration
 * - runPluginMigrations: task data migration
 *
 * Uses a real temp filesystem via createMockConstants.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants('loader-test'));

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: {},
  })),
  // ensureInit() → initDirectories() calls seedConfigDefaults(); mock it so the
  // task-store-touching migration tests don't hit a missing-export error.
  seedConfigDefaults: vi.fn(async () => {}),
}));

import { WALNUT_HOME, TASKS_FILE, CONFIG_FILE } from '../../src/constants.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import { runPluginMigrations, migrateConfigToPlugins } from '../../src/core/integration-loader.js';
import { getConfig } from '../../src/core/config-manager.js';
import { _resetForTesting, listTasks } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';

// ── Helpers ──

function makeNoopSync() {
  return {
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
    updateStar: async () => {},
    updateProject: async () => {},
    updateDependencies: async () => {},
    associateSubtask: async () => {},
    disassociateSubtask: async () => {},
    syncPoll: async () => {},
  };
}

// ── Setup / teardown ──

// Tasks live in SQLite; the handle and task-manager's init flag / store cache are
// module singletons, so removing WALNUT_HOME alone leaves the previous test's rows
// visible through the still-open handle (and blocks the one-shot tasks.json import
// that these fixtures rely on, since it only runs when the table is empty).
beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  closeDb();
  _resetForTesting();
  await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });

  vi.mocked(getConfig).mockResolvedValue({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: {},
  } as any);
});

afterEach(async () => {
  closeDb();
  _resetForTesting();
  await fsp.rm(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

// ── migrateConfigToPlugins ──

/**
 * Install a plugin dir (manifest.json only) under EXTERNAL_DIR = WALNUT_HOME/plugins.
 * That file IS the evidence the migration keys off, so a test for a plugin that
 * isn't in the known-legacy list has to create it.
 */
async function installPluginDir(id: string): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', id);
  await fsp.mkdir(dir, { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ id, name: id }));
}

describe('migrateConfigToPlugins', () => {
  it('migrates ms_todo to plugins.ms-todo', async () => {
    const config = {
      version: 1,
      ms_todo: { client_id: 'abc123' },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(true);

    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(content) as Record<string, unknown>;
    expect(result.ms_todo).toBeUndefined();
    const plugins = result.plugins as Record<string, unknown>;
    expect(plugins['ms-todo']).toEqual({ enabled: true, client_id: 'abc123' });
  });

  it('migrates plugin-a to plugins.plugin-a', async () => {
    await installPluginDir('plugin-a');
    const config = {
      version: 1,
      'plugin-a': { project: 'Work', base_url: 'https://plugin-a.example.com' },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(true);

    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(content) as Record<string, unknown>;
    expect(result['plugin-a']).toBeUndefined();
    const plugins = result.plugins as Record<string, unknown>;
    expect(plugins['plugin-a']).toEqual({
      enabled: true,
      project: 'Work',
      base_url: 'https://plugin-a.example.com',
    });
  });

  it('migrates plugin-b to plugins.plugin-b', async () => {
    await installPluginDir('plugin-b');
    const config = {
      version: 1,
      'plugin-b': { host: 'plugin-b.example.com', project: 'PROJ' },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(true);

    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(content) as Record<string, unknown>;
    expect(result['plugin-b']).toBeUndefined();
    const plugins = result.plugins as Record<string, unknown>;
    expect(plugins['plugin-b']).toEqual({
      enabled: true,
      host: 'plugin-b.example.com',
      project: 'PROJ',
    });
  });

  it('migrates all three at once', async () => {
    await installPluginDir('plugin-a');
    await installPluginDir('plugin-b');
    const config = {
      version: 1,
      ms_todo: { client_id: 'x' },
      'plugin-a': { project: 'W' },
      'plugin-b': { host: 'j' },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(true);

    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(content) as Record<string, unknown>;
    const plugins = result.plugins as Record<string, Record<string, unknown>>;
    expect(plugins['ms-todo'].client_id).toBe('x');
    expect(plugins['plugin-a'].project).toBe('W');
    expect(plugins['plugin-b'].host).toBe('j');
  });

  it('does not overwrite existing plugins section entries', async () => {
    const config = {
      version: 1,
      ms_todo: { client_id: 'old' },
      plugins: { 'ms-todo': { client_id: 'already-migrated' } },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(true);

    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(content) as Record<string, unknown>;
    const plugins = result.plugins as Record<string, Record<string, unknown>>;
    expect(plugins['ms-todo'].client_id).toBe('already-migrated');
  });

  it('returns false when config file does not exist', async () => {
    // Ensure no config file
    try { await fsp.unlink(CONFIG_FILE); } catch { /* OK */ }
    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(false);
  });

  it('returns false when no legacy keys present', async () => {
    const config = { version: 1, user: { name: 'test' } };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(false);
  });

  // Regression: `providers` is a first-class config key (the butler reads
  // config.providers). It must NOT be migrated into plugins.providers, which used
  // to silently break Bedrock auth for every onboarding path that writes a provider.
  it('does NOT migrate the first-class `providers` key into plugins', async () => {
    const config = {
      version: 1,
      providers: { bedrock: { api: 'bedrock', region: 'us-west-2', bearer_token: 'tok' } },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(false);

    const result = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    expect(result.providers).toBeDefined();
    expect((result.providers as Record<string, unknown>).bedrock).toBeDefined();
    expect((result.plugins as Record<string, unknown> | undefined)?.providers).toBeUndefined();
  });

  // Self-heal: a previous build mis-migrated providers into plugins.providers.
  // The migration must move it back to the top level so the butler can authenticate.
  it('self-heals a mis-migrated plugins.providers back to top-level providers', async () => {
    const config = {
      version: 1,
      plugins: { providers: { enabled: true, bedrock: { api: 'bedrock', region: 'us-west-2', bearer_token: 'tok' } } },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(true);

    const result = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    const providers = result.providers as Record<string, unknown>;
    expect(providers).toBeDefined();
    expect(providers.bedrock).toEqual({ api: 'bedrock', region: 'us-west-2', bearer_token: 'tok' });
    // the injected `enabled` flag is dropped and plugins.providers is gone
    expect(providers.enabled).toBeUndefined();
    expect((result.plugins as Record<string, unknown>).providers).toBeUndefined();
  });

  // ── The sentinel this bug was missing twice ──
  //
  // `providers` and `ui` were both swallowed because the migration matched
  // "any top-level object NOT in a hand-maintained allowlist". Config sections
  // grow with the product, so every new one was a forgotten allowlist edit away
  // from vanishing. These two tests pin the inverted rule: no on-disk plugin and
  // not known-legacy ⇒ leave it completely alone.
  it('leaves an unknown top-level config section untouched (no plugin installed)', async () => {
    const config = {
      version: 1,
      ui: { session_panels: '4' },
      audio: { retention_days: 7 },
      // A section invented after this test was written must behave the same way.
      some_future_section: { enabled_thing: true },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(false);

    const result = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    expect(result.ui).toEqual({ session_panels: '4' });
    expect(result.audio).toEqual({ retention_days: 7 });
    expect(result.some_future_section).toEqual({ enabled_thing: true });
    expect(result.plugins).toBeUndefined();
  });

  it('self-heals a mis-migrated plugins.ui back to top-level ui', async () => {
    // Exactly the shape found in a live config: the whole `ui` section moved
    // under plugins with an injected `enabled: true`, so the client read
    // config.ui.session_panels as undefined and silently fell back to auto.
    const config = {
      version: 1,
      plugins: { ui: { enabled: true, session_panels: '3' } },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(true);

    const result = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    expect(result.ui).toEqual({ session_panels: '3' });
    expect((result.plugins as Record<string, unknown>).ui).toBeUndefined();
  });

  it('does not clobber a real installed plugin that shares a config section name', async () => {
    // If `ui` is genuinely an installed plugin AND a top-level ui section
    // exists, the self-heal must not overwrite the plugin's own entry.
    await installPluginDir('ui');
    const config = {
      version: 1,
      ui: { session_panels: '2' },
      plugins: { ui: { enabled: true, some_plugin_setting: 'keep-me' } },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    await migrateConfigToPlugins();

    const result = yaml.load(await fsp.readFile(CONFIG_FILE, 'utf-8')) as Record<string, unknown>;
    const plugins = result.plugins as Record<string, Record<string, unknown>>;
    expect(plugins.ui.some_plugin_setting).toBe('keep-me');
  });
});

// ── runPluginMigrations ──

describe('runPluginMigrations', () => {
  it('runs plugin migrations and writes changed data', async () => {
    const store = {
      version: 1,
      tasks: [
        {
          id: 'task-1',
          title: 'Test task',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          project: 'Inbox',
          source: 'ms-todo',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
          ms_todo_id: 'abc123',
          ms_todo_list: 'list456',
        },
      ],
    };
    await fsp.writeFile(TASKS_FILE, JSON.stringify(store));

    const registry = new IntegrationRegistry();
    registry.register('test-plugin', {
      id: 'test-plugin',
      name: 'Test Plugin',
      config: {},
      sync: makeNoopSync(),
      migrations: [
        (tasks) => {
          for (const task of tasks) {
            const raw = task as Record<string, unknown>;
            if (raw.ms_todo_id) {
              if (!task.ext) task.ext = {};
              task.ext['ms-todo'] = { id: raw.ms_todo_id, list: raw.ms_todo_list };
              delete raw.ms_todo_id;
              delete raw.ms_todo_list;
            }
          }
          return tasks;
        },
      ],
      httpRoutes: [],
    });

    await runPluginMigrations(registry);

    // tasks.json is only the one-shot import seed now — the store of record is
    // SQLite, so migrated data must be read back through task-manager.
    const [migrated] = await listTasks();
    expect((migrated as Record<string, unknown>).ms_todo_id).toBeUndefined();
    expect((migrated as Record<string, unknown>).ms_todo_list).toBeUndefined();
    expect(migrated.ext).toEqual({ 'ms-todo': { id: 'abc123', list: 'list456' } });
  });

  it('does not write when no data changes', async () => {
    const store = {
      version: 1,
      tasks: [
        {
          id: 'task-1',
          title: 'Clean task',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          project: 'Inbox',
          source: 'local',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    await fsp.writeFile(TASKS_FILE, JSON.stringify(store));

    const registry = new IntegrationRegistry();
    registry.register('noop', {
      id: 'noop',
      name: 'Noop',
      config: {},
      sync: makeNoopSync(),
      migrations: [(tasks) => tasks],
      httpRoutes: [],
    });

    // Assert against the store of record (SQLite). A tasks.json mtime check
    // would pass vacuously — nothing writes that file since the SQLite cutover.
    const before = await listTasks();
    await runPluginMigrations(registry);
    const after = await listTasks();

    expect(after).toEqual(before);
  });

  it('does nothing when no plugins have migrations', async () => {
    const store = { version: 1, tasks: [] };
    await fsp.writeFile(TASKS_FILE, JSON.stringify(store));

    const registry = new IntegrationRegistry();
    registry.register('empty', {
      id: 'empty',
      name: 'Empty',
      config: {},
      sync: makeNoopSync(),
      migrations: [],
      httpRoutes: [],
    });

    // Should not throw
    await runPluginMigrations(registry);
  });

  it('continues running other migrations when one fails', async () => {
    const store = {
      version: 1,
      tasks: [
        {
          id: 'task-1',
          title: 'Test',
          status: 'todo',
          phase: 'TODO',
          priority: 'none',
          project: 'Inbox',
          source: 'local',
          session_ids: [],
          description: '',
          summary: '',
          note: '',
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:00:00Z',
        },
      ],
    };
    await fsp.writeFile(TASKS_FILE, JSON.stringify(store));

    const registry = new IntegrationRegistry();
    registry.register('failing', {
      id: 'failing',
      name: 'Failing',
      config: {},
      sync: makeNoopSync(),
      migrations: [() => { throw new Error('boom'); }],
      httpRoutes: [],
    });
    registry.register('succeeding', {
      id: 'succeeding',
      name: 'Succeeding',
      config: {},
      sync: makeNoopSync(),
      migrations: [(tasks) => {
        for (const t of tasks) {
          if (!t.ext) t.ext = {};
          t.ext['migrated'] = true;
        }
        return tasks;
      }],
      httpRoutes: [],
    });

    await runPluginMigrations(registry);

    const [migrated] = await listTasks();
    expect(migrated.ext?.migrated).toBe(true);
  });

  it('handles empty task store', async () => {
    const store = { version: 1, tasks: [] };
    await fsp.writeFile(TASKS_FILE, JSON.stringify(store));

    const registry = new IntegrationRegistry();
    registry.register('migrator', {
      id: 'migrator',
      name: 'Migrator',
      config: {},
      sync: makeNoopSync(),
      migrations: [(tasks) => tasks],
      httpRoutes: [],
    });

    await runPluginMigrations(registry);
  });

  it('handles missing tasks.json file', async () => {
    try { await fsp.unlink(TASKS_FILE); } catch { /* OK */ }

    const registry = new IntegrationRegistry();
    registry.register('migrator', {
      id: 'migrator',
      name: 'Migrator',
      config: {},
      sync: makeNoopSync(),
      migrations: [(tasks) => tasks],
      httpRoutes: [],
    });

    // Should not throw — reads default empty store
    await runPluginMigrations(registry);
  });
});
