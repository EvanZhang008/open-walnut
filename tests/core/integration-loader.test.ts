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
    defaults: { priority: 'none', category: 'Inbox' },
    provider: { type: 'bedrock' },
    plugins: {},
  })),
}));

import { WALNUT_HOME, TASKS_FILE, CONFIG_FILE } from '../../src/constants.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import { runPluginMigrations, migrateConfigToPlugins } from '../../src/core/integration-loader.js';
import { getConfig } from '../../src/core/config-manager.js';

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
    updateCategory: async () => {},
    updateDependencies: async () => {},
    associateSubtask: async () => {},
    disassociateSubtask: async () => {},
    syncPoll: async () => {},
  };
}

// ── Setup / teardown ──

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });

  vi.mocked(getConfig).mockResolvedValue({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none', category: 'Inbox' },
    provider: { type: 'bedrock' },
    plugins: {},
  } as any);
});

afterEach(async () => {
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── migrateConfigToPlugins ──

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
    const config = {
      version: 1,
      'plugin-a': { category: 'Work', base_url: 'https://plugin-a.example.com' },
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
      category: 'Work',
      base_url: 'https://plugin-a.example.com',
    });
  });

  it('migrates plugin-b to plugins.plugin-b', async () => {
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
    const config = {
      version: 1,
      ms_todo: { client_id: 'x' },
      'plugin-a': { category: 'W' },
      'plugin-b': { host: 'j' },
    };
    await fsp.writeFile(CONFIG_FILE, yaml.dump(config));

    const changed = await migrateConfigToPlugins();
    expect(changed).toBe(true);

    const content = await fsp.readFile(CONFIG_FILE, 'utf-8');
    const result = yaml.load(content) as Record<string, unknown>;
    const plugins = result.plugins as Record<string, Record<string, unknown>>;
    expect(plugins['ms-todo'].client_id).toBe('x');
    expect(plugins['plugin-a'].category).toBe('W');
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
          category: 'Inbox',
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

    const result = JSON.parse(await fsp.readFile(TASKS_FILE, 'utf-8'));
    expect(result.tasks[0].ms_todo_id).toBeUndefined();
    expect(result.tasks[0].ms_todo_list).toBeUndefined();
    expect(result.tasks[0].ext).toEqual({ 'ms-todo': { id: 'abc123', list: 'list456' } });
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
          category: 'Inbox',
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

    const before = await fsp.stat(TASKS_FILE);
    await new Promise(r => setTimeout(r, 50));
    await runPluginMigrations(registry);
    const after = await fsp.stat(TASKS_FILE);

    expect(after.mtimeMs).toBe(before.mtimeMs);
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
          category: 'Inbox',
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

    const result = JSON.parse(await fsp.readFile(TASKS_FILE, 'utf-8'));
    expect(result.tasks[0].ext?.migrated).toBe(true);
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
