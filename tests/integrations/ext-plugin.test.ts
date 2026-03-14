/**
 * External plugin tests — verifies register() works correctly when loaded
 * as an external plugin from ~/.open-walnut/plugins/ext-sync/.
 *
 * Uses esbuild to bundle the plugin on-the-fly (same approach as the
 * production integration-loader), then dynamically imports the bundle.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createTestPluginApi, createMockTask } from '../core/plugin-test-utils.js';
import type { IntegrationSync } from '../../src/core/integration-types.js';

// ── Plugin location ──

const PLUGIN_DIR = path.join(os.homedir(), '.open-walnut', 'plugins', 'ext-sync');
const PLUGIN_ENTRY = path.join(PLUGIN_DIR, 'plugin.ts');

// The built-in integrations dir inside the walnut repo (used for rebasing imports)
const SRC_DIR = path.resolve(__dirname, '..', '..', 'src');
const BUILTIN_DIR = path.join(SRC_DIR, 'integrations');

// ── Bundle state ──

let bundledFile: string | null = null;
let register: (api: any) => void;

// ── Setup: bundle the external plugin like the production loader does ──

beforeAll(async () => {
  if (!fs.existsSync(PLUGIN_ENTRY)) {
    throw new Error(
      `External plugin not found at ${PLUGIN_ENTRY}. ` +
      'This test requires the external plugin to be installed.',
    );
  }

  const { build } = await import('esbuild');
  const pluginName = 'ext-sync';
  const outfile = path.join(os.tmpdir(), `open-walnut-test-plugin-${pluginName}-${Date.now()}.mjs`);

  await build({
    entryPoints: [PLUGIN_ENTRY],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    external: ['better-sqlite3'],
    logLevel: 'silent',
    plugins: [{
      name: 'rebase-walnut-imports',
      setup(b) {
        // Rebase parent-directory imports (../../core/, ../../utils/, etc.)
        // to the walnut src/ tree so they resolve correctly at bundle time.
        b.onResolve({ filter: /^\.\.\// }, (args) => {
          const subPath = path.relative(PLUGIN_DIR, args.importer);
          const assumedImporter = path.join(BUILTIN_DIR, pluginName, subPath);
          const resolved = path.resolve(path.dirname(assumedImporter), args.path);
          for (const candidate of [
            resolved.replace(/\.js$/, '.ts'),
            resolved,
            path.join(resolved.replace(/\.js$/, ''), 'index.ts'),
          ]) {
            try { if (fs.statSync(candidate).isFile()) return { path: candidate }; } catch { /* next */ }
          }
          return undefined;
        });
      },
    }],
  });

  bundledFile = outfile;

  // Dynamically import the bundled module and extract the default export
  const mod = await import(pathToFileURL(outfile).href);
  register = mod.default;

  if (typeof register !== 'function') {
    throw new Error(
      `Expected default export to be a function, got ${typeof register}. ` +
      'The bundled plugin may have a different export shape.',
    );
  }
});

afterAll(async () => {
  // Clean up the temporary bundled file
  if (bundledFile) {
    await fsp.unlink(bundledFile).catch(() => {});
  }
});

// ── Helpers ──

function extPluginApi(configOverrides?: Record<string, unknown>) {
  return createTestPluginApi(
    { id: 'ext-sync', name: 'ExtSync' },
    { room_id: 'R-123456', category: 'Work', ...configOverrides },
  );
}

function extPluginTask(overrides?: Partial<ReturnType<typeof createMockTask>>) {
  return createMockTask({ category: 'Work', source: 'ext-sync', ...overrides });
}

// ── Tests ──

describe('External plugin registration', () => {
  it('registers sync with all 16 methods', () => {
    const { api, collected } = extPluginApi();
    register(api);

    expect(collected.sync).not.toBeNull();
    const methods: (keyof IntegrationSync)[] = [
      'createTask', 'deleteTask', 'updateTitle', 'updateDescription',
      'updateSummary', 'updateNote', 'updateConversationLog', 'updatePriority',
      'updatePhase', 'updateDueDate', 'updateStar', 'updateCategory',
      'updateDependencies', 'associateSubtask', 'disassociateSubtask', 'syncPoll',
    ];
    for (const m of methods) {
      expect(typeof collected.sync![m], `sync.${m} should be a function`).toBe('function');
    }
  });

  it('registers source claim at priority 10', () => {
    const { api, collected } = extPluginApi({ category: 'Work' });
    register(api);

    expect(collected.claim).not.toBeNull();
    expect(collected.claim!.priority).toBe(10);
  });

  it('source claim returns true for configured category (case-insensitive)', () => {
    const { api, collected } = extPluginApi({ category: 'Work' });
    register(api);

    // Exact match
    expect(collected.claim!.fn('Work')).toBe(true);
    // Case-insensitive
    expect(collected.claim!.fn('work')).toBe(true);
    expect(collected.claim!.fn('WORK')).toBe(true);
    // Non-matching categories
    expect(collected.claim!.fn('Personal')).toBe(false);
    expect(collected.claim!.fn('Inbox')).toBe(false);
  });

  it('source claim returns false for all categories when category config is empty', () => {
    const { api, collected } = extPluginApi({ category: '' });
    register(api);

    expect(collected.claim!.fn('Work')).toBe(false);
    expect(collected.claim!.fn('Personal')).toBe(false);
    expect(collected.claim!.fn('')).toBe(false);
  });

  it('registers display metadata with badge "T" and green color', () => {
    const { api, collected } = extPluginApi();
    register(api);

    expect(collected.display).not.toBeNull();
    expect(collected.display!.badge).toBe('T');
    expect(collected.display!.badgeColor).toBe('#00A86B');
    expect(collected.display!.externalLinkLabel).toBe('ExtSync');
  });

  it('display isSynced checks ext.ext-sync.id', () => {
    const { api, collected } = extPluginApi();
    register(api);

    const syncedTask = extPluginTask({ ext: { ext-sync: { id: 'SIM-123' } } });
    expect(collected.display!.isSynced(syncedTask)).toBe(true);

    const unsyncedTask = extPluginTask();
    expect(collected.display!.isSynced(unsyncedTask)).toBe(false);

    const emptyExtTask = extPluginTask({ ext: {} });
    expect(collected.display!.isSynced(emptyExtTask)).toBe(false);
  });

  it('display getExternalUrl returns task external_url', () => {
    const { api, collected } = extPluginApi();
    register(api);

    const taskWithUrl = extPluginTask({ external_url: 'https://ext-sync.example.com/SIM-123' } as any);
    expect(collected.display!.getExternalUrl(taskWithUrl)).toBe('https://ext-sync.example.com/SIM-123');

    const taskWithoutUrl = extPluginTask();
    expect(collected.display!.getExternalUrl(taskWithoutUrl)).toBeNull();
  });

  it('display syncTooltip shows error when sync_error is present', () => {
    const { api, collected } = extPluginApi();
    register(api);

    const errorTask = extPluginTask({ sync_error: 'GraphQL timeout' });
    expect(collected.display!.syncTooltip!(errorTask)).toContain('GraphQL timeout');

    const okTask = extPluginTask();
    expect(collected.display!.syncTooltip!(okTask)).toBe('Synced to ExtSync');
  });

  it('registers agent context mentioning ExtSync', () => {
    const { api, collected } = extPluginApi();
    register(api);

    expect(collected.agentContext).not.toBeNull();
    expect(collected.agentContext).toContain('ExtSync');
    expect(collected.agentContext).toContain('ext-sync');
  });

  it('registers at least one migration function', () => {
    const { api, collected } = extPluginApi();
    register(api);

    expect(collected.migrations.length).toBeGreaterThanOrEqual(1);
  });
});

describe('External plugin migration', () => {
  it('migrates ext-sync_id to ext.ext-sync.id', () => {
    const { api, collected } = extPluginApi();
    register(api);

    const task = extPluginTask() as any;
    task.ext-sync_id = 'SIM-456';
    task.ext-sync_short_id = 'S456';
    task.ext-sync_comment_id = 'comment-789';
    task.ext-sync_tags = ['bug', 'p1'];

    const migrated = collected.migrations[0]([task]);

    expect(migrated[0].ext?.ext-sync).toEqual({
      id: 'SIM-456',
      short_id: 'S456',
      comment_id: 'comment-789',
      tags: ['bug', 'p1'],
    });
    // Old fields should be removed
    expect(task.ext-sync_id).toBeUndefined();
    expect(task.ext-sync_short_id).toBeUndefined();
    expect(task.ext-sync_comment_id).toBeUndefined();
    expect(task.ext-sync_tags).toBeUndefined();
  });

  it('skips tasks already migrated (ext.ext-sync exists)', () => {
    const { api, collected } = extPluginApi();
    register(api);

    const task = extPluginTask({
      ext: { ext-sync: { id: 'existing-id', short_id: 'E1' } },
    }) as any;
    // Even if old field exists, migration should skip because ext.ext-sync is set
    task.ext-sync_id = 'old-id';

    const migrated = collected.migrations[0]([task]);
    // ext.ext-sync should remain unchanged
    expect(migrated[0].ext?.ext-sync).toEqual({ id: 'existing-id', short_id: 'E1' });
  });

  it('handles tasks without ext-sync_id (no-op)', () => {
    const { api, collected } = extPluginApi();
    register(api);

    const task = createMockTask({ source: 'local' });
    const migrated = collected.migrations[0]([task]);
    expect(migrated[0].ext).toBeUndefined();
  });

  it('migration is idempotent', () => {
    const { api, collected } = extPluginApi();
    register(api);

    const task = extPluginTask() as any;
    task.ext-sync_id = 'SIM-100';
    task.ext-sync_short_id = 'S100';

    const first = collected.migrations[0]([task]);
    const second = collected.migrations[0](first);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
