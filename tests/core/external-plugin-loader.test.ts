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
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants('ext-loader-test'));

vi.mock('../../src/core/config-manager.js', () => ({
  getConfig: vi.fn(async () => ({
    version: 1,
    user: { name: 'test' },
    defaults: { priority: 'none', category: 'Inbox' },
    provider: { type: 'bedrock' },
    plugins: {},
  })),
}));

import { WALNUT_HOME, TASKS_FILE } from '../../src/constants.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import { loadPlugins } from '../../src/core/integration-loader.js';
import { getConfig } from '../../src/core/config-manager.js';

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
  updateStar: async () => {},
  updateCategory: async () => {},
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

// ── Setup / teardown ──

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  await fsp.rm(tmpDir, { recursive: true, force: true });
  await fsp.mkdir(tmpDir, { recursive: true });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });

  // Ensure tasks.json exists (loadPlugins does not require it, but just in case)
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));

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

  it('esbuild bundles .ts plugin with parent imports', async () => {
    // This plugin imports a type from ../../core/types.js — a parent-relative path
    // that would normally fail because the plugin lives in ~/.walnut/plugins/,
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
});
