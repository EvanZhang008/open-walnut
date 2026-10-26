/**
 * The manifest's `storage` block, end to end through the real loader: a plugin that
 * declares `files` and `tmp` gets `walnut.storage.files` and `walnut.storage.tmp` at
 * WALNUT_HOME/plugin-files/<id>/ and WALNUT_HOME/tmp/plugins/<id>/; one that does not
 * gets areas that refuse every call; a bad entry costs that entry, with a warning,
 * never the plugin. A synced write is pending until the plugin stops, then on disk.
 *
 * The rules of each area are pinned in plugin-file-area.test.ts; this pins the seam.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('plugin-storage-areas-test'));

const captured = vi.hoisted(() => ({
  warnings: [] as Array<{ subsystem: string; message: string; meta?: Record<string, unknown> }>,
}));
vi.mock('../../src/logging/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/logging/index.js')>();
  return {
    ...actual,
    createSubsystemLogger: (subsystem: string) => ({
      ...actual.createSubsystemLogger(subsystem),
      warn: (message: string, meta?: Record<string, unknown>) => {
        captured.warnings.push({ subsystem, message, meta });
      },
    }),
  };
});

import { WALNUT_HOME, CONFIG_FILE, TASKS_FILE } from '../../src/constants.js';
import { IntegrationRegistry } from '../../src/core/integration-registry.js';
import { loadPlugins, disposeLoadedPlugins, getPluginLifecycleRecords } from '../../src/core/integration-loader.js';

interface Seen { [key: string]: unknown }
const seen = () => (globalThis as unknown as { __storageSeen: Record<string, Seen> }).__storageSeen;

/** A plugin whose activate tries both areas and reports what happened. */
async function writePlugin(id: string, storage: unknown): Promise<void> {
  const dir = path.join(WALNUT_HOME, 'plugins', id);
  await fsp.mkdir(path.join(dir, 'dist'), { recursive: true });
  await fsp.writeFile(path.join(dir, 'manifest.json'), JSON.stringify({
    id, name: id, version: '1.0.0', apiVersion: 1, engines: { walnut: '>=0.0.0' }, server: 'dist/server.mjs',
    ...(storage === undefined ? {} : { storage }),
  }));
  await fsp.writeFile(path.join(dir, 'dist', 'server.mjs'), `
const report = (globalThis.__storageSeen ??= {})[${JSON.stringify(id)}] = {};
const attempt = async (key, run) => {
  try { report[key] = { ok: await run() }; } catch (error) { report[key] = { error: String(error.message) }; }
};
export async function activate(walnut) {
  report.filesDir = walnut.storage.files.dir;
  report.tmpDir = walnut.storage.tmp.dir;
  await attempt('filesWrite', async () => { await walnut.storage.files.writeText('reviews/first.md', '# first'); return true; });
  await attempt('filesRead', () => walnut.storage.files.readText('reviews/first.md'));
  await attempt('tmpWrite', async () => { await walnut.storage.tmp.writeText('scratch.txt', 'tmp'); return true; });
  await attempt('localList', () => walnut.storage.list());
}
`);
}

const registries: IntegrationRegistry[] = [];
async function load(): Promise<IntegrationRegistry> {
  const registry = new IntegrationRegistry();
  registries.push(registry);
  await loadPlugins(registry);
  return registry;
}

beforeEach(async () => {
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  await fsp.mkdir(path.dirname(TASKS_FILE), { recursive: true });
  await fsp.writeFile(TASKS_FILE, JSON.stringify({ version: 1, tasks: [] }));
  await fsp.writeFile(CONFIG_FILE, yaml.dump({ version: 1, user: { name: 'test' }, defaults: { priority: 'none' }, plugins: {} }), 'utf-8');
  (globalThis as unknown as { __storageSeen: Record<string, Seen> }).__storageSeen = {};
  captured.warnings.length = 0;
});

afterEach(async () => {
  for (const registry of registries.splice(0)) await disposeLoadedPlugins(registry);
  delete (globalThis as unknown as { __storageSeen?: unknown }).__storageSeen;
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('manifest storage areas', () => {
  it('a declared plugin gets both areas at their folders; the synced write lands when it stops', async () => {
    await writePlugin('practice', { files: true, tmp: { ttlHours: 2 } });
    const registry = await load();
    expect(getPluginLifecycleRecords(registry).find((r) => r.id === 'practice')?.state).toBe('active');

    const report = seen().practice;
    expect(report.filesDir).toBe(path.join(WALNUT_HOME, 'plugin-files', 'practice'));
    expect(report.tmpDir).toBe(path.join(WALNUT_HOME, 'tmp', 'plugins', 'practice'));
    expect(report.filesWrite).toEqual({ ok: true });
    expect(report.filesRead).toEqual({ ok: '# first' });
    expect(report.tmpWrite).toEqual({ ok: true });
    // The pending copy is not in the plugin's own machine-local listing.
    expect(report.localList).toEqual({ ok: [] });
    expect(await fsp.readFile(path.join(WALNUT_HOME, 'tmp', 'plugins', 'practice', 'scratch.txt'), 'utf8')).toBe('tmp');
    // Pending: not in the synced folder (or git) yet.
    expect(existsSync(path.join(WALNUT_HOME, 'plugin-files', 'practice', 'reviews', 'first.md'))).toBe(false);

    await disposeLoadedPlugins(registry);
    expect(await fsp.readFile(path.join(WALNUT_HOME, 'plugin-files', 'practice', 'reviews', 'first.md'), 'utf8')).toBe('# first');
  });

  it('an undeclared plugin is refused by both areas and still loads', async () => {
    await writePlugin('plain', undefined);
    const registry = await load();
    expect(getPluginLifecycleRecords(registry).find((r) => r.id === 'plain')?.state).toBe('active');
    const report = seen().plain;
    expect(report.filesWrite).toEqual({ error: expect.stringContaining('"storage": { "files": true }') });
    expect(report.tmpWrite).toEqual({ error: expect.stringContaining('"storage": { "tmp": true }') });
    expect(existsSync(path.join(WALNUT_HOME, 'plugin-files'))).toBe(false);
  });

  it('a bad entry costs that area, with a warning naming it; the plugin loads', async () => {
    await writePlugin('typo', { files: 'yes', tmp: true, cloud: {} });
    const registry = await load();
    expect(getPluginLifecycleRecords(registry).find((r) => r.id === 'typo')?.state).toBe('active');
    const report = seen().typo;
    expect(report.filesWrite).toEqual({ error: expect.stringContaining('no synced files area') });
    expect(report.tmpWrite).toEqual({ ok: true });
    // The manifest is read at discovery and again at load, each time with the same warning.
    const reasons = new Set(captured.warnings.filter((w) => w.message === 'Manifest storage entry dropped').map((w) => w.meta?.reason));
    expect([...reasons]).toEqual(['storage.files must be true or an object', 'storage.cloud is not an area this Walnut knows']);
  });

  it('writes a crash left pending go out at the next start', async () => {
    const pending = path.join(WALNUT_HOME, 'plugin-data', '.pending-files', 'practice', 'left.md');
    await fsp.mkdir(path.dirname(pending), { recursive: true });
    await fsp.writeFile(pending, 'from the last run');
    await writePlugin('practice', { files: true });
    const registry = await load();
    // Published while the plugin runs (after the short first delay), not only by the stop.
    const published = path.join(WALNUT_HOME, 'plugin-files', 'practice', 'left.md');
    await vi.waitFor(async () => expect(await fsp.readFile(published, 'utf8').catch(() => null)).toBe('from the last run'), { timeout: 20_000, interval: 250 });
    expect(existsSync(pending)).toBe(false);
    await disposeLoadedPlugins(registry);
  }, 30_000);
});
