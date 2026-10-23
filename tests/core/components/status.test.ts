/**
 * The per-process component state (src/core/components/index.ts): the status a
 * settings row reads, one install however many ask, where a feature loads from,
 * what starts a download (only a person, a feature, or the server's upgrade),
 * how automatic retries back off, and what a selftest may not do.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
  componentStatus, ensureComponent, holdComponentInstalls, initComponents, loadComponent, markInstalledBroken, onComponentStatus,
  resetComponentsForTests, resolveComponent, startComponentUpgrades, whenComponentReady, type ComponentStatus,
} from '../../../src/core/components/index.js';
import { installComponent } from '../../../src/core/components/install.js';
import { acquireLock } from '../../../src/core/components/lock.js';
import { setManifestForTests } from '../../../src/core/components/manifest.js';
import { resetPlatformForTests } from '../../../src/core/components/platform.js';
import { componentsRouter } from '../../../src/web/routes/components.js';
import { fakeComponent, startReleaseServer, tmpDir, type ReleaseServer } from './helpers.js';

let srv: ReleaseServer;
const saved: Record<string, string | undefined> = {};
const ENV = ['WALNUT_COMPONENTS_DIR', 'WALNUT_COMPONENTS_FROM', 'WALNUT_COMPONENTS_PLATFORM', 'WALNUT_COMPONENTS_BASE_URL'];
let root = '';

beforeAll(async () => {
  srv = await startReleaseServer();
  for (const k of ENV) saved[k] = process.env[k];
});
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setManifestForTests(undefined);
  resetComponentsForTests();
  resetPlatformForTests();
  await srv.close();
});

function useFake(opts: Parameters<typeof fakeComponent>[2] = {}) {
  const c = fakeComponent('images', 'linux-x64', opts);
  srv.serve(c.entry.asset, c.archive);
  setManifestForTests(c.manifest);
  return c;
}

beforeEach(() => {
  root = tmpDir();
  process.env.WALNUT_COMPONENTS_DIR = root;
  process.env.WALNUT_COMPONENTS_FROM = 'download';
  process.env.WALNUT_COMPONENTS_PLATFORM = 'linux-x64';
  process.env.WALNUT_COMPONENTS_BASE_URL = srv.base;
  resetPlatformForTests();
  resetComponentsForTests({ backoffMs: 20, idleTimeoutMs: 1_000, lock: { pollMs: 20 } });
  srv.requests.length = 0;
});
afterEach(() => { setManifestForTests(undefined); });

describe('component status', () => {
  it('missing until asked; downloading with progress; ready; then the feature loads from the component dir', async () => {
    const c = useFake({ padBytes: 300_000 });
    srv.fault(c.entry.asset, { chunkDelayMs: 15 });
    await initComponents();
    expect(componentStatus('images')).toMatchObject({ state: 'missing', version: '1.0.0-1', size: c.entry.size, platform: 'linux-x64' });
    expect(srv.requests).toEqual([]); // init downloads nothing
    expect(resolveComponent('images')).toBeNull();

    const seen: ComponentStatus[] = [];
    const off = onComponentStatus((s) => { if (s.name === 'images') seen.push(s); });
    const done = await ensureComponent('images', 'user');
    off();
    expect(done).toMatchObject({ state: 'ready', source: 'installed' });
    const states = seen.map((s) => s.state);
    expect(states[0]).toBe('downloading');
    expect(states).toContain('installing');
    expect(states.at(-1)).toBe('ready');
    const progress = seen.filter((s) => s.progress).map((s) => s.progress!.done);
    expect(progress.length).toBeGreaterThan(1);
    expect(progress.at(-1)).toBe(c.entry.size);

    const loaded = resolveComponent('images');
    expect(loaded?.source).toBe('installed');
    if (loaded?.source !== 'installed') throw new Error('not installed');
    expect(loaded.require('fake-lib').hello()).toBe('hello from images-1.0.0-1');
    expect((await import(loaded.entryUrl)).hello()).toBe('esm hello');
  });

  it('one install however many ask at once', async () => {
    const c = useFake({ padBytes: 100_000 });
    const all = await Promise.all([ensureComponent('images', 'user'), ensureComponent('images', 'feature'), ensureComponent('images', 'user')]);
    expect(all.every((s) => s.state === 'ready')).toBe(true);
    expect(srv.requests.filter((r) => r.url.endsWith(c.entry.asset))).toHaveLength(1);
  });

  it('a new process finds what an earlier one installed, without downloading', async () => {
    useFake();
    await ensureComponent('images', 'user');
    resetComponentsForTests();
    srv.requests.length = 0;
    expect((await loadComponent('images'))?.source).toBe('installed');
    expect(componentStatus('images').state).toBe('ready');
    expect(srv.requests).toEqual([]);
  });

  it('a failure is the status, with its reason; one no retry fixes is never retried automatically, a person can retry at once', async () => {
    const c = useFake();
    resetComponentsForTests({ backoffMs: 20, lock: { pollMs: 20 }, retryBaseMs: 30 });
    srv.fault(c.entry.asset, { status: 404 });
    expect(await ensureComponent('images', 'feature')).toMatchObject({ state: 'failed', code: 'http', error: expect.stringMatching(/404/) });
    expect(await whenComponentReady('images', 100)).toBe(false);
    srv.requests.length = 0;
    await new Promise((r) => setTimeout(r, 100)); // past any backoff: still never
    expect((await ensureComponent('images', 'feature')).state).toBe('failed');
    expect(srv.requests).toEqual([]);
    expect((await ensureComponent('images', 'user')).state).toBe('ready');
  });

  it('a failure a retry may fix is retried automatically, after a backoff that doubles', async () => {
    const c = useFake();
    resetComponentsForTests({ backoffMs: 5, retries: 0, lock: { pollMs: 20 }, retryBaseMs: 300 });
    const fails = () => srv.fault(c.entry.asset, { status: 503 });
    const asks = () => srv.requests.filter((r) => r.url.endsWith(c.entry.asset)).length;
    fails();
    expect((await ensureComponent('images', 'feature')).state).toBe('failed');
    expect(asks()).toBe(1);
    expect((await ensureComponent('images', 'feature')).state).toBe('failed'); // inside the first 300 ms
    expect(asks()).toBe(1);
    await new Promise((r) => setTimeout(r, 400));
    fails();
    expect((await ensureComponent('images', 'feature')).state).toBe('failed'); // the second try
    expect(asks()).toBe(2);
    await new Promise((r) => setTimeout(r, 300)); // the next wait is 600 ms now
    expect((await ensureComponent('images', 'feature')).state).toBe('failed');
    expect(asks()).toBe(2);
    await new Promise((r) => setTimeout(r, 400));
    expect((await ensureComponent('images', 'feature')).state).toBe('ready');
    expect(asks()).toBe(3);
  });

  it('every feature waits for one install only up to that install\'s own deadline', async () => {
    const c = useFake({ padBytes: 200_000 });
    const stop = new AbortController();
    resetComponentsForTests({ backoffMs: 20, idleTimeoutMs: 20_000, lock: { pollMs: 20 }, featureWaitMs: 600, signal: stop.signal });
    srv.fault(c.entry.asset, { stallAfter: 0, stallMs: 20_000 });
    const t0 = Date.now();
    void ensureComponent('images', 'feature');
    const first = whenComponentReady('images');
    await new Promise((r) => setTimeout(r, 400));
    const t1 = Date.now();
    expect(await whenComponentReady('images')).toBe(false); // what was left: about 200 ms
    expect(Date.now() - t1).toBeLessThan(450);
    expect(await first).toBe(false);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(550);
    expect(Date.now() - t0).toBeLessThan(1_500);
    // Past the deadline a feature does not wait at all.
    const t2 = Date.now();
    expect(await whenComponentReady('images')).toBe(false);
    expect(Date.now() - t2).toBeLessThan(50);
    stop.abort();
  });

  it('says it is waiting while another process holds the install, then finishes', async () => {
    useFake();
    const other = await acquireLock(path.join(root, '.locks', 'images.lock'), { heartbeatMs: 50 });
    const seen: string[] = [];
    const off = onComponentStatus((s) => { if (s.name === 'images') seen.push(s.state); });
    const done = ensureComponent('images', 'user');
    await new Promise((r) => setTimeout(r, 200));
    expect(componentStatus('images').state).toBe('waiting');
    await other.release();
    expect((await done).state).toBe('ready');
    off();
    expect(seen.indexOf('waiting')).toBeGreaterThanOrEqual(0);
    expect(seen.indexOf('waiting')).toBeLessThan(seen.lastIndexOf('downloading'));
  });

  it('an installed component that stops loading is moved aside and installed again, once per process', async () => {
    const c = useFake();
    await ensureComponent('images', 'user');
    const first = resolveComponent('images');
    if (first?.source !== 'installed') throw new Error('not installed');
    fs.rmSync(path.join(first.dir, 'node_modules', 'fake-lib'), { recursive: true });
    srv.requests.length = 0;
    markInstalledBroken('images', new Error('Cannot find module fake-lib'));
    expect(resolveComponent('images')).toBeNull();
    for (let i = 0; i < 100 && componentStatus('images').state !== 'ready'; i++) await new Promise((r) => setTimeout(r, 50));
    const again = resolveComponent('images');
    if (again?.source !== 'installed') throw new Error('not installed again');
    expect(again.require('fake-lib').hello()).toBe('hello from images-1.0.0-1');
    expect(srv.requests.filter((r) => r.url.endsWith(c.entry.asset))).toHaveLength(1);
    // A second break in the same process is not repaired again (no loop on a machine where it never loads).
    markInstalledBroken('images', new Error('again'));
    await new Promise((r) => setTimeout(r, 300));
    expect(srv.requests.filter((r) => r.url.endsWith(c.entry.asset))).toHaveLength(1);
  });

  it('a platform with no archive is unsupported and never downloads', async () => {
    useFake();
    process.env.WALNUT_COMPONENTS_PLATFORM = 'darwin-x64';
    resetPlatformForTests();
    resetComponentsForTests();
    await initComponents();
    expect(componentStatus('images')).toMatchObject({ state: 'unsupported', code: 'unsupported' });
    expect((await ensureComponent('images', 'user')).state).toBe('unsupported');
    expect(srv.requests).toEqual([]);
  });

  it('audio capture is unsupported off macOS', async () => {
    if (process.platform === 'darwin') return;
    await initComponents();
    expect(componentStatus('audio-capture').state).toBe('unsupported');
  });

  it('an older version on disk means the person had it on: the server\'s upgrade installs the new one and removes the old', async () => {
    useFake({ version: '1.0.0-2' });
    fs.mkdirSync(path.join(root, 'images', '1.0.0-1', 'linux-x64'), { recursive: true });
    await initComponents();
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.requests).toEqual([]); // init alone upgrades nothing
    await startComponentUpgrades();
    expect(await whenComponentReady('images', 10_000)).toBe(true);
    expect(fs.readdirSync(path.join(root, 'images'))).toEqual(['1.0.0-2']);
  });

  it('an older finished install serves the feature until the server upgrades it, quietly', async () => {
    const v1 = fakeComponent('images', 'linux-x64', { version: '1.0.0-1' });
    srv.serve(v1.entry.asset, v1.archive);
    await installComponent('images', { root, platform: 'linux-x64', manifest: v1.manifest, backoffMs: 20 });
    const v2 = useFake({ version: '1.0.0-2', padBytes: 100_000 });
    srv.requests.length = 0;
    const loaded = await loadComponent('images');
    if (loaded?.source !== 'installed') throw new Error('the older install does not serve');
    expect(loaded.version).toBe('1.0.0-1');
    expect(componentStatus('images')).toMatchObject({ state: 'ready', version: '1.0.0-1' });
    // A feature that the older install serves starts no upgrade.
    await ensureComponent('images', 'feature');
    expect(srv.requests).toEqual([]);
    const seen: string[] = [];
    const off = onComponentStatus((s) => { if (s.name === 'images') seen.push(s.state); });
    await startComponentUpgrades();
    for (let i = 0; i < 100 && (resolveComponent('images') as { version?: string } | null)?.version !== '1.0.0-2'; i++) await new Promise((r) => setTimeout(r, 50));
    off();
    expect(seen.every((st) => st === 'ready')).toBe(true); // the row never left ready
    expect(srv.requests.filter((r) => r.url.endsWith(v2.entry.asset))).toHaveLength(1);
    const now = resolveComponent('images');
    if (now?.source !== 'installed') throw new Error('not installed');
    expect(now.require('fake-lib').hello()).toBe('hello from images-1.0.0-2');
    expect(fs.readdirSync(path.join(root, 'images'))).toEqual(['1.0.0-2']);
  });

  it('a selftest reports and installs nothing: no upgrade, no feature download, not even a click', async () => {
    const v1 = fakeComponent('images', 'linux-x64', { version: '1.0.0-1' });
    srv.serve(v1.entry.asset, v1.archive);
    await installComponent('images', { root, platform: 'linux-x64', manifest: v1.manifest, backoffMs: 20 });
    useFake({ version: '1.0.0-2' });
    srv.requests.length = 0;
    const { componentSelftest } = await import('../../../src/core/components/selftest.js');
    // The fake archive carries no sharp, so the check fails; what matters is that it started nothing.
    await componentSelftest('images').catch(() => {});
    await startComponentUpgrades();
    await ensureComponent('images', 'feature');
    await ensureComponent('images', 'user');
    expect(srv.requests).toEqual([]);
    expect(fs.readdirSync(path.join(root, 'images'))).toEqual(['1.0.0-1']);
  });

  it('holdComponentInstalls keeps a missing component missing', async () => {
    useFake();
    holdComponentInstalls();
    expect((await ensureComponent('images', 'user')).state).toBe('missing');
    expect(srv.requests).toEqual([]);
  });

  it('a malformed manifest override keeps the compiled manifest, and init still finishes', async () => {
    const { COMPONENTS_MANIFEST } = await import('../../../src/core/components/manifest-data.js');
    const { getManifest, manifestProblem } = await import('../../../src/core/components/manifest.js');
    setManifestForTests(undefined);
    const file = path.join(tmpDir(), 'manifest.json');
    fs.writeFileSync(file, JSON.stringify({ schema: 1, repo: 'a/b', components: { images: { version: '1' } } }));
    process.env.WALNUT_COMPONENTS_MANIFEST = file;
    try {
      resetComponentsForTests();
      await initComponents();
      expect(getManifest()).toBe(COMPONENTS_MANIFEST);
      expect(componentStatus('images').version).toBe(COMPONENTS_MANIFEST.components.images.version);
    } finally {
      delete process.env.WALNUT_COMPONENTS_MANIFEST;
    }
    expect(manifestProblem(COMPONENTS_MANIFEST)).toBeNull();
    const broken = (patch: (m: Record<string, any>) => void) => { const m = structuredClone(COMPONENTS_MANIFEST) as Record<string, any>; patch(m); return manifestProblem(m); };
    expect(broken((m) => { m.schema = 2; })).toMatch(/schema/);
    expect(broken((m) => { delete m.components.embedding; })).toMatch(/embedding is missing/);
    expect(broken((m) => { m.components.images.entry = '../../x.js'; })).toMatch(/leaves its dir/);
    const plat = Object.keys(COMPONENTS_MANIFEST.components.images.platforms)[0];
    expect(broken((m) => { m.components.images.platforms[plat].tarSha256 = 'abc'; })).toMatch(/SHA-256/);
    expect(broken((m) => { m.components.images.platforms[plat].tarSize = -1; })).toMatch(/positive integers/);
    expect(broken((m) => { m.components.images.platforms[plat].asset = '../x.tar.gz'; })).toMatch(/archive name/);
    expect(broken((m) => { m.components.images.platforms['windows-x64'] = m.components.images.platforms[plat]; })).toMatch(/unknown platform/);
  });

  it('with nothing installed before, init starts no download', async () => {
    useFake();
    await initComponents();
    await new Promise((r) => setTimeout(r, 50));
    expect(srv.requests).toEqual([]);
    expect(componentStatus('images').state).toBe('missing');
  });

  it('running from source, the package in node_modules is used and nothing is downloaded', async () => {
    delete process.env.WALNUT_COMPONENTS_FROM;
    resetComponentsForTests();
    await initComponents();
    // This repo installs @huggingface/transformers and sharp as optional dependencies.
    expect(componentStatus('embedding')).toMatchObject({ state: 'ready', source: 'bundled' });
    expect(componentStatus('images')).toMatchObject({ state: 'ready', source: 'bundled' });
    expect(await loadComponent('embedding')).toEqual({ source: 'bundled' });
    expect(srv.requests).toEqual([]);
  });
});

describe('GET/POST /api/components', () => {
  const app = express().use('/api/components', componentsRouter);

  it('lists every component and starts an install that the status then follows', async () => {
    useFake({ padBytes: 200_000 });
    const list = await request(app).get('/api/components').expect(200);
    expect(list.body.platform).toBe('linux-x64');
    expect(list.body.components.map((c: ComponentStatus) => c.name)).toEqual(['embedding', 'images', 'audio-capture']);
    const started = await request(app).post('/api/components/images/install').expect(202);
    expect(['downloading', 'installing', 'ready']).toContain(started.body.state);
    expect(await whenComponentReady('images', 10_000)).toBe(true);
    const after = await request(app).get('/api/components/images').expect(200);
    expect(after.body).toMatchObject({ state: 'ready', source: 'installed' });
    await request(app).post('/api/components/images/install').expect(200);
  });

  it('answers 404 for an unknown component and 409 for one not built here', async () => {
    useFake();
    await request(app).get('/api/components/nope').expect(404);
    await request(app).post('/api/components/nope/install').expect(404);
    await request(app).post('/api/components/embedding/install').expect(409);
  });
});
