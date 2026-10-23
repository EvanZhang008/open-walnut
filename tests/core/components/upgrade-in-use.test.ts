/**
 * An upgrade never removes the version a running feature still loads from: a
 * worker that imported the older install's entry and reads another of its
 * files later (a lazy import) still finds it after the newer version landed.
 * New loads take the new version at once; the next server start removes the old.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';
import {
  loadComponent, resetComponentsForTests, resolveComponent, startComponentUpgrades,
} from '../../../src/core/components/index.js';
import { installComponent } from '../../../src/core/components/install.js';
import { setManifestForTests } from '../../../src/core/components/manifest.js';
import { resetPlatformForTests } from '../../../src/core/components/platform.js';
import { fakeComponent, startReleaseServer, tmpDir, type ReleaseServer } from './helpers.js';

const CHILD = path.join(import.meta.dirname, 'lazy-user-child.mjs');
const ENV = ['WALNUT_COMPONENTS_DIR', 'WALNUT_COMPONENTS_FROM', 'WALNUT_COMPONENTS_PLATFORM', 'WALNUT_COMPONENTS_BASE_URL'];
const saved: Record<string, string | undefined> = {};
const tuning = { backoffMs: 20, lock: { pollMs: 20 } };
let srv: ReleaseServer;
let root = '';

/** A component whose entry imports a second file only when asked. */
const lazyComponent = (version: string) => fakeComponent('images', 'linux-x64', {
  version,
  files: {
    'node_modules/fake-lib/index.mjs': "export const hello = () => 'esm hello';\nexport const later = async () => (await import('./later.mjs')).value;\n",
    'node_modules/fake-lib/later.mjs': `export const value = 'later from ${version}';\n`,
  },
});

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  for (const t0 = Date.now(); !cond(); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
  }
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  srv = await startReleaseServer();
});
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setManifestForTests(undefined);
  resetComponentsForTests();
  resetPlatformForTests();
  await srv.close();
});
beforeEach(() => {
  root = tmpDir();
  process.env.WALNUT_COMPONENTS_DIR = root;
  process.env.WALNUT_COMPONENTS_FROM = 'download';
  process.env.WALNUT_COMPONENTS_PLATFORM = 'linux-x64';
  process.env.WALNUT_COMPONENTS_BASE_URL = srv.base;
  resetPlatformForTests();
});

describe('an upgrade while a feature runs on the older install', () => {
  it('keeps the older dir for a worker that reads it lazily, and the next server start removes it', async () => {
    const v1 = lazyComponent('1.0.0-1');
    srv.serve(v1.entry.asset, v1.archive);
    await installComponent('images', { root, platform: 'linux-x64', manifest: v1.manifest, ...tuning });
    const v2 = lazyComponent('1.0.0-2');
    srv.serve(v2.entry.asset, v2.archive);
    setManifestForTests(v2.manifest);
    resetComponentsForTests(tuning);

    // This Walnut pins 1.0.0-2; the older install serves, and a worker starts on it.
    const old = await loadComponent('images');
    if (old?.source !== 'installed' || old.version !== '1.0.0-1') throw new Error(`not the older install: ${JSON.stringify(old)}`);
    const child = spawn(process.execPath, [CHILD], { env: { ...process.env, LAZY_ENTRY: old.entryUrl }, stdio: ['pipe', 'pipe', 'inherit'] });
    const lines: Array<{ ready?: boolean; value?: string; error?: string }> = [];
    createInterface({ input: child.stdout! }).on('line', (l) => { try { lines.push(JSON.parse(l)); } catch { /* not ours */ } });
    const exited = new Promise<void>((r) => child.on('exit', () => r()));
    try {
      await until(() => lines.some((l) => l.ready));

      await startComponentUpgrades();
      await until(() => (resolveComponent('images') as { version?: string } | null)?.version === '1.0.0-2');

      // The worker reads the rest of what it loaded, after the upgrade.
      child.stdin!.write('go\n');
      await until(() => lines.some((l) => l.value !== undefined || l.error !== undefined));
      const answer = lines.find((l) => l.value !== undefined || l.error !== undefined);
      expect(answer).toEqual({ value: 'later from 1.0.0-1' });
      expect(fs.existsSync(old.dir)).toBe(true);
    } finally {
      if (child.exitCode === null) child.kill();
      await exited;
    }

    // A new load takes the new version at once.
    const now = resolveComponent('images');
    if (now?.source !== 'installed') throw new Error('not installed');
    expect(await (await import(now.entryUrl)).later()).toBe('later from 1.0.0-2');
    expect(fs.readdirSync(path.join(root, 'images')).sort()).toEqual(['1.0.0-1', '1.0.0-2']);

    // The next server start: nothing loads from the older one any more, so it goes.
    resetComponentsForTests(tuning);
    await startComponentUpgrades();
    expect(fs.readdirSync(path.join(root, 'images'))).toEqual(['1.0.0-2']);
    expect((await loadComponent('images'))?.source).toBe('installed');
  });

  it('an older install nothing in this process loaded is removed by the upgrade itself', async () => {
    const v1 = lazyComponent('1.0.0-1');
    srv.serve(v1.entry.asset, v1.archive);
    await installComponent('images', { root, platform: 'linux-x64', manifest: v1.manifest, ...tuning });
    const v2 = lazyComponent('1.0.0-2');
    srv.serve(v2.entry.asset, v2.archive);
    setManifestForTests(v2.manifest);
    resetComponentsForTests(tuning);
    await startComponentUpgrades();
    await until(() => fs.readdirSync(path.join(root, 'images')).join() === '1.0.0-2');
  });
});
