/**
 * Unit tests for external plugin loading in integration-loader.ts.
 *
 * Tests:
 * - External plugin discovery from WALNUT_HOME/plugins/
 * - esbuild on-the-fly bundling for .ts plugins with parent imports
 * - Skips directories without manifest.json
 * - Built-in plugins take precedence over external with same ID
 * - registerSync() is required or plugin is rejected
 *
 * Uses a real temp filesystem via createMockConstants.
 * The EXTERNAL_DIR in integration-loader.ts is path.join(WALNUT_HOME, 'plugins').
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants('ext-loader-test'));

const esbuildControl = vi.hoisted(() => ({ delayMs: 0 }));
vi.mock('esbuild', async (importOriginal) => {
  const actual = await importOriginal<typeof import('esbuild')>();
  return {
    ...actual,
    async build(...args: Parameters<typeof actual.build>) {
      if (esbuildControl.delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, esbuildControl.delayMs));
      }
      return actual.build(...args);
    },
  };
});

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: {},
  })),
  updatePluginConfig: vi.fn(async (_id: string, patch: Record<string, unknown>) => patch),
}));

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import { disableLoadedPlugin, loadNewPlugins, loadPlugins, reloadLoadedPlugin, getPluginLifecycleRecords, getUnconfiguredPlugins, getUnsupportedPlugins, setPluginCodeTimeoutForTesting } from '../../src/core/integration-loader.js';
import { getConfig, updatePluginConfig } from '../../src/core/config-manager.js';
import { createPluginRouteDispatcher } from '../../src/web/plugin-route-dispatcher.js';

// ── Helpers ──

/** The 16-method noop sync object required by every plugin. */
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
  syncPoll: async () => {},
}`;

/** Write a manifest.json to a plugin directory. */
async function writeManifest(pluginDir: string, manifest: Record<string, unknown>): Promise<void> {
  await fsp.mkdir(pluginDir, { recursive: true });
  await fsp.writeFile(path.join(pluginDir, 'manifest.json'), JSON.stringify(manifest));
}

/** Write a plugin.ts file to a plugin directory. */
async function writePluginTs(pluginDir: string, source: string): Promise<void> {
  await fsp.writeFile(path.join(pluginDir, 'plugin.ts'), source);
}

async function writeCountingUnifiedPlugin(pluginDir: string, id: string): Promise<void> {
  await writeManifest(pluginDir, {
    id,
    name: id,
    apiVersion: 1,
    engines: { walnut: '>=0.0.0' },
    server: 'dist/server.mjs',
  });
  await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(pluginDir, 'dist', 'server.mjs'), `
export async function activate(walnut) {
  await walnut.storage.updateJson('activations.json', { count: 0 }, (current) => ({ count: current.count + 1 }));
}
`);
}

async function readActivationCount(id: string): Promise<number> {
  const file = path.join(tmpDir, 'plugin-data', id, 'activations.json');
  return JSON.parse(await fsp.readFile(file, 'utf8')).count;
}

// ── Setup / teardown ──

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });

  // Ensure tasks.json exists (loadPlugins does not require it, but just in case)
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));

  vi.mocked(updatePluginConfig).mockClear();
  vi.mocked(getConfig).mockResolvedValue({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none' },
    provider: { type: 'bedrock' },
    plugins: {},
  } as any);
});

afterEach(async () => {
  delete (globalThis as any).__walnutLiveSyncRegistration;
  esbuildControl.delayMs = 0;
  setPluginCodeTimeoutForTesting(null);
  await fsp.rm(tmpDir, { recursive: true, force: true });
});

// ── External plugin loading tests ──

describe('external plugin loading', () => {
  it('discovers and loads an external plugin from plugins/ dir', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'test-ext');
    await writeManifest(pluginDir, {
      id: 'test-ext',
      name: 'Test External',
      version: '1.0.0',
    });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.has('test-ext')).toBe(true);
    const plugin = registry.get('test-ext');
    expect(plugin).toBeDefined();
    expect(plugin!.name).toBe('Test External');
    expect(plugin!.sync).toBeDefined();
    expect(typeof plugin!.sync.createTask).toBe('function');
  });

  it('rejects unsafe ids in legacy manifests before creating Plugin state', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'unsafe-id');
    await writeManifest(pluginDir, { id: '../escape', name: 'Unsafe' });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.has('../escape')).toBe(false);
    await expect(fsp.access(path.join(tmpDir, 'escape'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('esbuild bundles .ts plugin with parent imports', async () => {
    // This plugin imports a type from ../../core/types.js — a parent-relative path
    // that would normally fail because the plugin lives in ~/.open-walnut/plugins/,
    // not in src/integrations/. The esbuild rebase-walnut-imports plugin handles this.
    const pluginDir = path.join(tmpDir, 'plugins', 'import-test');
    await writeManifest(pluginDir, {
      id: 'import-test',
      name: 'Import Test',
      version: '1.0.0',
    });
    await writePluginTs(pluginDir, `
import type { Task } from '../../core/types.js';

// Use the type to prove the import resolved (type-only imports are erased,
// but esbuild still needs to resolve the path during bundling).
type TaskId = Task['id'];

export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.has('import-test')).toBe(true);
    const plugin = registry.get('import-test');
    expect(plugin).toBeDefined();
    expect(plugin!.name).toBe('Import Test');
  });

  it('skips directory without manifest.json', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'no-manifest');
    await fsp.mkdir(pluginDir, { recursive: true });
    // Only write an index.ts — no manifest.json
    await fsp.writeFile(path.join(pluginDir, 'index.ts'), `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.has('no-manifest')).toBe(false);
  });

  it('built-in takes precedence over external plugin with same ID', async () => {
    // The built-in 'local' plugin is always loaded first by loadPlugins.
    // Create an external plugin with id 'local' — it should be skipped.
    const pluginDir = path.join(tmpDir, 'plugins', 'local');
    await writeManifest(pluginDir, {
      id: 'local',
      name: 'Local External Override',
      version: '9.9.9',
    });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
  api.registerDisplay({
    badge: 'X',
    badgeColor: '#FF0000',
    externalLinkLabel: 'Override',
    getExternalUrl: () => null,
    isSynced: () => false,
  });
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    // 'local' should be registered (from built-in), not from our external override
    expect(registry.has('local')).toBe(true);
    const plugin = registry.get('local');
    expect(plugin).toBeDefined();
    // The built-in local plugin has name 'Local', not 'Local External Override'
    expect(plugin!.name).toBe('Local');
    // The built-in local does have a display with badge 'L', not 'X'
    expect(plugin!.display?.badge).toBe('L');
  });

  it('rejects plugin that does not call registerSync()', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'no-sync');
    await writeManifest(pluginDir, {
      id: 'no-sync',
      name: 'No Sync Plugin',
      version: '1.0.0',
    });
    // This plugin only calls registerDisplay but NOT registerSync
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerDisplay({
    badge: 'N',
    badgeColor: '#000000',
    externalLinkLabel: 'No Sync',
    getExternalUrl: () => null,
    isSynced: () => false,
  });
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.has('no-sync')).toBe(false);
  });

  it('records plugin with missing required config as unconfigured (with schema + uiHints)', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'needs-config');
    await writeManifest(pluginDir, {
      id: 'needs-config',
      name: 'Needs Config',
      configSchema: {
        type: 'object',
        properties: { room_id: { type: 'string' } },
        required: ['room_id'],
      },
      uiHints: {
        room_id: { label: 'Room ID', help: 'Find it at https://example.com/rooms' },
      },
    });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    // Not loaded — required room_id absent from config
    expect(registry.has('needs-config')).toBe(false);

    // But surfaced for the Settings UI with exactly what's missing
    const unconfigured = getUnconfiguredPlugins();
    const entry = unconfigured.find(p => p.id === 'needs-config');
    expect(entry).toBeDefined();
    expect(entry!.missing).toEqual(['room_id']);
    expect(entry!.uiHints?.room_id?.help).toContain('https://example.com/rooms');
    expect((entry!.configSchema as any)?.required).toEqual(['room_id']);
  });

  it('clears unconfigured list once required config is provided', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'now-configured');
    await writeManifest(pluginDir, {
      id: 'now-configured',
      name: 'Now Configured',
      configSchema: {
        type: 'object',
        properties: { room_id: { type: 'string' } },
        required: ['room_id'],
      },
    });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);

    // First load: missing config → unconfigured
    const registry1 = new IntegrationRegistry();
    await loadPlugins(registry1);
    expect(getUnconfiguredPlugins().some(p => p.id === 'now-configured')).toBe(true);

    // Provide the required field and reload
    vi.mocked(getConfig).mockResolvedValue({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      provider: { type: 'bedrock' },
      plugins: { 'now-configured': { room_id: 'abc-123' } },
    } as any);

    const registry2 = new IntegrationRegistry();
    await loadPlugins(registry2);
    expect(registry2.has('now-configured')).toBe(true);
    expect(getUnconfiguredPlugins().some(p => p.id === 'now-configured')).toBe(false);
    // Loaded plugin carries its manifest schema for the settings form
    expect((registry2.get('now-configured')!.configSchema as any)?.required).toEqual(['room_id']);
  });

  it('target-reloads a newly configured Plugin without duplicating diagnostics', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'target-configured');
    await writeManifest(pluginDir, {
      id: 'target-configured',
      name: 'Target Configured',
      configSchema: {
        type: 'object',
        properties: { room_id: { type: 'string' } },
        required: ['room_id'],
      },
    });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    await reloadLoadedPlugin(registry, 'target-configured');
    await reloadLoadedPlugin(registry, 'target-configured');
    expect(getUnconfiguredPlugins().filter((plugin) => plugin.id === 'target-configured')).toHaveLength(1);

    vi.mocked(getConfig).mockResolvedValue({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      provider: { type: 'bedrock' },
      plugins: { 'target-configured': { room_id: 'abc-123' } },
    } as any);
    await reloadLoadedPlugin(registry, 'target-configured');

    expect(registry.has('target-configured')).toBe(true);
    expect(getUnconfiguredPlugins().filter((plugin) => plugin.id === 'target-configured')).toHaveLength(0);
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'target-configured', state: 'active' }),
    ]));
  });

  it('keeps the current Plugin registered when reload manifest preflight fails', async () => {
    await writeCountingUnifiedPlugin(path.join(tmpDir, 'plugins', 'preflight'), 'preflight');
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    await fsp.writeFile(path.join(tmpDir, 'plugins', 'preflight', 'manifest.json'), '{bad json');

    await expect(reloadLoadedPlugin(registry, 'preflight')).rejects.toThrow('manifest cannot be read');

    expect(registry.has('preflight')).toBe(true);
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'preflight', state: 'active' }),
    ]));
    expect(await readActivationCount('preflight')).toBe(1);
  });

  it('reflects mid-life disposal of a singleton contribution', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'live-singleton');
    await writeManifest(pluginDir, {
      id: 'live-singleton',
      name: 'Live Singleton',
      apiVersion: 1,
      engines: { walnut: '>=0.0.0' },
      server: 'dist/server.mjs',
    });
    await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, 'dist', 'server.mjs'), `
export function activate(walnut) {
  globalThis.__walnutLiveSyncRegistration = walnut.registry.sync(${NOOP_SYNC_SOURCE});
}
`);
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    const plugin = registry.get('live-singleton')!;
    expect(plugin.hasSync).toBe(true);

    await (globalThis as any).__walnutLiveSyncRegistration.dispose();

    expect(plugin.hasSync).toBe(false);
    expect(plugin.sync).toBeDefined();
    delete (globalThis as any).__walnutLiveSyncRegistration;
  });

  it('loads apiVersion 1 through activate(walnut) without legacy capability gates', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'unified-plugin');
    await writeManifest(pluginDir, {
      id: 'unified-plugin',
      name: 'Unified Plugin',
      apiVersion: 1,
      engines: { walnut: '>=0.0.0' },
      server: 'dist/server.mjs',
    });
    await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, 'dist', 'server.mjs'), `
export async function activate(walnut) {
  walnut.registry.tool({
    name: 'inspect',
    description: 'Inspect unified Plugin state',
    async execute() { return { pluginId: walnut.pluginId }; }
  });
  walnut.http.route('GET', '/status', async () => ({ json: { active: true } }));
  await walnut.storage.writeJson('loaded.json', { active: true });
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    const plugin = registry.get('unified-plugin');
    expect(plugin).toMatchObject({ apiVersion: 1, serverEntry: 'dist/server.mjs', hasSync: false });
    expect(plugin?.tools?.map((tool) => tool.name)).toEqual(['unified_plugin_inspect']);
    expect(plugin?.httpRoutes).toHaveLength(1);
    expect(JSON.parse(await fsp.readFile(path.join(tmpDir, 'plugin-data', 'unified-plugin', 'loaded.json'), 'utf8'))).toEqual({ active: true });
  });

  it('fails a unified Plugin whose module evaluation exceeds the code deadline', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'module-timeout');
    await writeManifest(pluginDir, {
      id: 'module-timeout',
      name: 'Module Timeout',
      apiVersion: 1,
      engines: { walnut: '>=0.0.0' },
      server: 'plugin.ts',
    });
    await writePluginTs(pluginDir, `
await new Promise(() => {});
export function activate() {}
`);
    setPluginCodeTimeoutForTesting(10);
    const registry = new IntegrationRegistry();

    await loadPlugins(registry);

    expect(getPluginLifecycleRecords(registry)).toContainEqual(expect.objectContaining({
      id: 'module-timeout',
      state: 'failed',
      error: 'Plugin "module-timeout" module evaluation timed out after 10ms',
    }));
    const cacheDir = path.join(import.meta.dirname, '..', '..', '.plugin-cache');
    const cached = await fsp.readdir(cacheDir).catch(() => [] as string[]);
    expect(cached.filter((file) => file.startsWith('module-timeout-'))).toEqual([]);
  });

  it('fails a unified Plugin whose activate function exceeds the code deadline', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'activation-timeout');
    await writeManifest(pluginDir, {
      id: 'activation-timeout',
      name: 'Activation Timeout',
      apiVersion: 1,
      engines: { walnut: '>=0.0.0' },
      server: 'dist/server.mjs',
    });
    await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, 'dist', 'server.mjs'), `
export function activate() { return new Promise(() => {}); }
`);
    setPluginCodeTimeoutForTesting(1_000);
    const registry = new IntegrationRegistry();

    await loadPlugins(registry);

    expect(getPluginLifecycleRecords(registry)).toContainEqual(expect.objectContaining({
      id: 'activation-timeout',
      state: 'failed',
      error: 'Plugin "activation-timeout" activation timed out after 1000ms',
    }));
  });

  it('does not count external TypeScript bundling against the Plugin code deadline', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'slow-bundle');
    await writeManifest(pluginDir, {
      id: 'slow-bundle',
      name: 'Slow Bundle',
      apiVersion: 1,
      engines: { walnut: '>=0.0.0' },
      server: 'plugin.ts',
    });
    await writePluginTs(pluginDir, 'export function activate() {}\n');
    setPluginCodeTimeoutForTesting(500);
    esbuildControl.delayMs = 600;
    const registry = new IntegrationRegistry();

    await loadPlugins(registry);

    expect(registry.has('slow-bundle')).toBe(true);
    expect(getPluginLifecycleRecords(registry)).toContainEqual(expect.objectContaining({
      id: 'slow-bundle',
      state: 'active',
    }));
  });

  it('preserves this for object-style activate and deactivate methods', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'object-plugin');
    await writeManifest(pluginDir, {
      id: 'object-plugin',
      name: 'Object Plugin',
      apiVersion: 1,
      engines: { walnut: '>=0.0.0' },
      server: 'dist/server.mjs',
    });
    await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, 'dist', 'server.mjs'), `
export default {
  walnut: null,
  async activate(walnut) {
    this.walnut = walnut;
    await this.walnut.storage.writeJson('state.json', { active: true });
  },
  async deactivate() {
    await this.walnut.storage.writeJson('state.json', { active: false });
  }
};
`);
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    const stateFile = path.join(tmpDir, 'plugin-data', 'object-plugin', 'state.json');
    expect(JSON.parse(await fsp.readFile(stateFile, 'utf8'))).toEqual({ active: true });

    await disableLoadedPlugin(registry, 'object-plugin');

    expect(JSON.parse(await fsp.readFile(stateFile, 'utf8'))).toEqual({ active: false });
  });

  it('keeps contributions registered after activation live', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'late-plugin');
    await writeManifest(pluginDir, {
      id: 'late-plugin',
      name: 'Late Plugin',
      apiVersion: 1,
      engines: { walnut: '>=0.0.0' },
      server: 'dist/server.mjs',
    });
    await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, 'dist', 'server.mjs'), `
export async function activate(walnut) {
  walnut.http.route('POST', '/register-late', async () => {
    walnut.http.route('GET', '/late', async () => ({ json: { late: true } }));
    walnut.registry.tool({ name: 'late', description: 'Late tool', async execute() { return 'late'; } });
    walnut.registry.agentContext('Late contribution is active.');
    return { json: { registered: true } };
  });
}
`);
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    const plugin = registry.get('late-plugin')!;
    const app = express();
    app.use('/api/plugins', createPluginRouteDispatcher(registry));

    await request(app).get('/api/plugins/late-plugin/late').expect(404);
    await request(app).post('/api/plugins/late-plugin/register-late').expect(200, { registered: true });

    expect(plugin.tools?.map((tool) => tool.name)).toEqual(['late_plugin_late']);
    expect(plugin.agentContext).toBe('Late contribution is active.');
    expect(plugin.httpRoutes).toHaveLength(2);
    await request(app).get('/api/plugins/late-plugin/late').expect(200, { late: true });
  });

  it('additive discovery activates only newly installed Plugins', async () => {
    await writeCountingUnifiedPlugin(path.join(tmpDir, 'plugins', 'existing-plugin'), 'existing-plugin');
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(await readActivationCount('existing-plugin')).toBe(1);

    await writeCountingUnifiedPlugin(path.join(tmpDir, 'plugins', 'new-plugin'), 'new-plugin');
    await loadNewPlugins(registry);

    expect(await readActivationCount('existing-plugin')).toBe(1);
    expect(await readActivationCount('new-plugin')).toBe(1);
    expect(registry.getAll().filter((plugin) => plugin.id === 'existing-plugin')).toHaveLength(1);
    expect(registry.getAll().filter((plugin) => plugin.id === 'new-plugin')).toHaveLength(1);
  });

  it('replaces a loaded plugin on global reload without duplicate contributions', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'reloadable');
    await writeManifest(pluginDir, { id: 'reloadable', name: 'Before' });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.get('reloadable')?.name).toBe('Before');

    await writeManifest(pluginDir, { id: 'reloadable', name: 'After' });
    await loadPlugins(registry);

    expect(registry.get('reloadable')?.name).toBe('After');
    expect(registry.getAll().filter((plugin) => plugin.id === 'reloadable')).toHaveLength(1);
    expect(registry.getTombstone('reloadable')).toBeUndefined();
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'reloadable', state: 'active' }),
    ]));
  });

  it('reloads only the requested plugin', async () => {
    await writeCountingUnifiedPlugin(path.join(tmpDir, 'plugins', 'plugin-a'), 'plugin-a');
    await writeCountingUnifiedPlugin(path.join(tmpDir, 'plugins', 'plugin-b'), 'plugin-b');
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    await reloadLoadedPlugin(registry, 'plugin-a');

    expect(await readActivationCount('plugin-a')).toBe(2);
    expect(await readActivationCount('plugin-b')).toBe(1);
    expect(registry.getAll().filter((plugin) => plugin.id === 'plugin-a')).toHaveLength(1);
    expect(vi.mocked(updatePluginConfig)).toHaveBeenCalledWith('plugin-a', { enabled: true });
  });

  it('persists disable before a later global reload', async () => {
    await writeCountingUnifiedPlugin(path.join(tmpDir, 'plugins', 'persistent-disable'), 'persistent-disable');
    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    await disableLoadedPlugin(registry, 'persistent-disable');
    expect(vi.mocked(updatePluginConfig)).toHaveBeenCalledWith('persistent-disable', { enabled: false });

    vi.mocked(getConfig).mockResolvedValue({
      version: 1,
      user: { name: 'test' },
      defaults: { priority: 'none' },
      provider: { type: 'bedrock' },
      plugins: { 'persistent-disable': { enabled: false } },
    } as any);
    await loadPlugins(registry);

    expect(registry.has('persistent-disable')).toBe(false);
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'persistent-disable', state: 'disabled' }),
    ]));
    expect(await readActivationCount('persistent-disable')).toBe(1);
  });

  it('serializes concurrent global reloads', async () => {
    await writeCountingUnifiedPlugin(path.join(tmpDir, 'plugins', 'serialized'), 'serialized');
    const registry = new IntegrationRegistry();

    await Promise.all([loadPlugins(registry), loadPlugins(registry)]);

    expect(registry.getAll().filter((plugin) => plugin.id === 'serialized')).toHaveLength(1);
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'serialized', state: 'active' }),
    ]));
    expect(await readActivationCount('serialized')).toBe(2);
  });

  it('follows a local development symlink and canonicalizes its target', async () => {
    const target = path.join(tmpDir, 'linked-source');
    await writeManifest(target, { id: 'linked-plugin', name: 'Linked Plugin' });
    await writePluginTs(target, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);
    const externalDir = path.join(tmpDir, 'plugins');
    await fsp.mkdir(externalDir, { recursive: true });
    await fsp.symlink(target, path.join(externalDir, 'linked-plugin'), 'dir');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.get('linked-plugin')?.pluginDir).toBe(await fsp.realpath(target));
  });
});

describe('manifest v2 capabilities', () => {
  it('loads a plugin with explicit capabilities.sync', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'cap-sync');
    await writeManifest(pluginDir, {
      id: 'cap-sync',
      name: 'Cap Sync',
      capabilities: { sync: {} },
    });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.has('cap-sync')).toBe(true);
  });

  // `tools` and `ui` became SUPPORTED capabilities (see plugin-capabilities.test.ts),
  // so this forward-compat check now uses the two still-reserved names.
  it('skips a plugin declaring only unsupported capabilities, without importing it', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'future-only');
    await writeManifest(pluginDir, {
      id: 'future-only',
      name: 'Future Only',
      capabilities: { hooks: { entry: 'hooks.ts' }, routines: { entry: 'routines.ts' } },
    });
    // Deliberately broken entry — must NOT be imported/bundled
    await writePluginTs(pluginDir, 'this is not valid typescript {{{');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.has('future-only')).toBe(false);
    const entry = getUnsupportedPlugins().find(p => p.id === 'future-only');
    expect(entry).toBeDefined();
    expect(entry!.capabilities.sort()).toEqual(['hooks', 'routines']);
  });

  it('rejects unsupported apiVersion before importing plugin code', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'future-api');
    await writeManifest(pluginDir, {
      id: 'future-api',
      name: 'Future API',
      apiVersion: 99,
      engines: { walnut: '>=0.0.0' },
      server: 'dist/server.mjs',
    });
    await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, 'dist', 'server.mjs'), 'throw new Error("must not import")');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.has('future-api')).toBe(false);
    expect(getUnsupportedPlugins()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'future-api', apiVersion: 99, reason: expect.stringContaining('Unsupported') }),
    ]));
    expect(getPluginLifecycleRecords(registry)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'future-api', state: 'unsupported' }),
    ]));
  });

  it('enforces engines.walnut before importing unified plugin code', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'newer-walnut');
    await writeManifest(pluginDir, {
      id: 'newer-walnut',
      name: 'Newer Walnut',
      apiVersion: 1,
      engines: { walnut: '>=999.0.0' },
      server: 'dist/server.mjs',
    });
    await fsp.mkdir(path.join(pluginDir, 'dist'), { recursive: true });
    await fsp.writeFile(path.join(pluginDir, 'dist', 'server.mjs'), 'throw new Error("must not import")');

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);

    expect(registry.has('newer-walnut')).toBe(false);
    expect(getUnsupportedPlugins()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'newer-walnut', reason: expect.stringContaining('Requires Walnut') }),
    ]));
  });

  it('loads a sync plugin that also declares unknown capabilities (warn + ignore)', async () => {
    const pluginDir = path.join(tmpDir, 'plugins', 'mixed-caps');
    await writeManifest(pluginDir, {
      id: 'mixed-caps',
      name: 'Mixed Caps',
      capabilities: { sync: {}, hooks: { entry: 'hooks.ts' } },
    });
    await writePluginTs(pluginDir, `
export default function register(api) {
  api.registerSync(${NOOP_SYNC_SOURCE});
}
`);

    const registry = new IntegrationRegistry();
    await loadPlugins(registry);
    expect(registry.has('mixed-caps')).toBe(true);
    expect(getUnsupportedPlugins().some(p => p.id === 'mixed-caps')).toBe(false);
  });
});
