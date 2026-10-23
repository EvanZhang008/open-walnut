/**
 * Component install against a real local HTTP server: verify, resume, retry,
 * deadlines, the lock, atomic install, versions and pruning, and the archive a
 * host is handed instead of a download. Two real processes: install-processes.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { installComponent, findInstalled, findUsable } from '../../../src/core/components/install.js';
import { acquireLock } from '../../../src/core/components/lock.js';
import { setManifestForTests } from '../../../src/core/components/manifest.js';
import { MARKER } from '../../../src/core/components/paths.js';
import { compareVersions } from '../../../src/core/components/version.js';
import { fakeComponent, startReleaseServer, tmpDir, type ReleaseServer } from './helpers.js';

let srv: ReleaseServer;
const PLATFORM = 'linux-x64' as const;
const fast = { retries: 3, backoffMs: 20, idleTimeoutMs: 400, lock: { pollMs: 20 } };

beforeAll(async () => {
  srv = await startReleaseServer();
  process.env.WALNUT_COMPONENTS_BASE_URL = srv.base;
});
afterAll(async () => {
  delete process.env.WALNUT_COMPONENTS_BASE_URL;
  setManifestForTests(undefined);
  await srv.close();
});
beforeEach(() => { srv.requests.length = 0; });

function setup(opts: Parameters<typeof fakeComponent>[2] = {}) {
  const c = fakeComponent('images', PLATFORM, opts);
  srv.serve(c.entry.asset, c.archive);
  return { ...c, root: tmpDir() };
}

describe('installComponent', () => {
  it('downloads, verifies, unpacks into <name>/<version>/<platform>, and loads from there', async () => {
    const c = setup();
    const inst = await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(inst.dir).toBe(path.join(c.root, 'images', '1.0.0-1', PLATFORM));
    const marker = JSON.parse(fs.readFileSync(path.join(inst.dir, MARKER), 'utf8'));
    expect(marker.tarSha256).toBe(c.entry.tarSha256);
    // The tree resolves its own dependencies: what a feature's createRequire does.
    const req = createRequire(path.join(inst.dir, 'index.js'));
    expect(req('fake-lib').hello()).toBe('hello from images-1.0.0-1');
    // The archive is not kept, and no staging dir is left behind.
    expect(fs.readdirSync(path.join(c.root, '.downloads'))).toEqual([]);
    expect(fs.readdirSync(path.join(c.root, 'images', '1.0.0-1'))).toEqual([PLATFORM]);
    // Installed: the next call fetches nothing.
    srv.requests.length = 0;
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(srv.requests).toEqual([]);
  });

  it('follows a redirect (GitHub sends assets to its storage)', async () => {
    const c = setup();
    process.env.WALNUT_COMPONENTS_BASE_URL = `${srv.base}/redirect`;
    try {
      await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    } finally {
      process.env.WALNUT_COMPONENTS_BASE_URL = srv.base;
    }
    expect(await findInstalled('images', { root: c.root, platform: PLATFORM, manifest: c.manifest })).not.toBeNull();
  });

  it('never retries a refusal no retry can fix (403)', async () => {
    const c = setup();
    srv.fault(c.entry.asset, { status: 403 });
    await expect(installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast }))
      .rejects.toMatchObject({ code: 'http', status: 403 });
    expect(srv.requests).toHaveLength(1);
  });

  it('refuses a corrupt download after fetching it twice, and installs nothing', async () => {
    const c = setup();
    const bad = Buffer.from(c.archive);
    bad[bad.length - 20] ^= 0xff; // still a complete download, wrong content
    srv.fault(c.entry.asset, { body: bad }, { body: bad });
    await expect(installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast }))
      .rejects.toMatchObject({ code: 'checksum' });
    expect(srv.requests.filter((r) => r.url.endsWith(c.entry.asset))).toHaveLength(2);
    expect(fs.existsSync(path.join(c.root, 'images', '1.0.0-1', PLATFORM))).toBe(false);
    expect(fs.readdirSync(path.join(c.root, '.downloads'))).toEqual([]);
  });

  it('installs when a corrupt first download is followed by a good one', async () => {
    const c = setup();
    srv.fault(c.entry.asset, { body: Buffer.from('not a gzip at all') });
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(await findInstalled('images', { root: c.root, platform: PLATFORM, manifest: c.manifest })).not.toBeNull();
  });

  it('resumes a connection cut short with a Range request', async () => {
    const c = setup({ padBytes: 300_000 });
    srv.fault(c.entry.asset, { cutAfter: 100_000 });
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    const asks = srv.requests.filter((r) => r.url.endsWith(c.entry.asset));
    expect(asks).toHaveLength(2);
    expect(asks[0].range).toBeUndefined();
    expect(asks[1].range).toMatch(/^bytes=\d+-$/);
    expect(Number(/\d+/.exec(asks[1].range!)![0])).toBeGreaterThan(0);
  });

  it('drops a stalled connection and resumes', async () => {
    const c = setup({ padBytes: 200_000 });
    srv.fault(c.entry.asset, { stallAfter: 32 * 1024, stallMs: 5_000 });
    const t0 = Date.now();
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(Date.now() - t0).toBeLessThan(4_000);
    expect(srv.requests.filter((r) => r.url.endsWith(c.entry.asset))[1]?.range).toMatch(/^bytes=/);
  });

  it('retries a server error, then gives up with the reason', async () => {
    const c = setup();
    srv.fault(c.entry.asset, { status: 503 });
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    srv.fault(c.entry.asset, { status: 500 }, { status: 500 }, { status: 500 }, { status: 500 });
    const root2 = tmpDir();
    await expect(installComponent('images', { root: root2, platform: PLATFORM, manifest: c.manifest, ...fast }))
      .rejects.toMatchObject({ code: 'http', message: expect.stringMatching(/500/) });
  });

  it('does not retry a missing asset', async () => {
    const c = setup();
    const manifest = structuredClone(c.manifest);
    manifest.components.images.platforms[PLATFORM]!.asset = 'nope.tar.gz';
    await expect(installComponent('images', { root: c.root, platform: PLATFORM, manifest, ...fast }))
      .rejects.toMatchObject({ code: 'http', message: expect.stringMatching(/404/) });
    expect(srv.requests).toHaveLength(1);
  });

  it('stops at its deadline on a link that never finishes', async () => {
    const c = setup({ padBytes: 2_000_000 });
    srv.fault(c.entry.asset, { chunkDelayMs: 100 });
    await expect(installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast, deadlineMs: 600 }))
      .rejects.toMatchObject({ code: 'deadline' });
  });

  it('says a platform without an archive is unsupported, and fetches nothing', async () => {
    const c = setup();
    await expect(installComponent('images', { root: c.root, platform: 'darwin-x64', manifest: c.manifest, ...fast }))
      .rejects.toMatchObject({ code: 'unsupported' });
    expect(srv.requests).toEqual([]);
  });

  it('two installers at once: one downloads, the other waits for it and finds it installed', async () => {
    const c = setup({ padBytes: 400_000 });
    srv.fault(c.entry.asset, { chunkDelayMs: 5 });
    const [a, b] = await Promise.all([
      installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast }),
      installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast }),
    ]);
    expect(a.dir).toBe(b.dir);
    expect(srv.requests.filter((r) => r.url.endsWith(c.entry.asset))).toHaveLength(1);
    expect(fs.existsSync(path.join(c.root, '.locks', 'images.lock'))).toBe(false);
  });

  it('takes over the lock of an installer that died', async () => {
    const c = setup();
    const lock = path.join(c.root, '.locks', 'images.lock');
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ token: 'dead', pid: 1 }));
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(lock, old, old);
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(fs.existsSync(lock)).toBe(false);
  });

  it('waits for a live holder and gives up at its wait limit', async () => {
    const root = tmpDir();
    const held = await acquireLock(path.join(root, 'x.lock'), { heartbeatMs: 50 });
    await expect(acquireLock(path.join(root, 'x.lock'), { waitMs: 200, pollMs: 20 })).rejects.toMatchObject({ code: 'locked' });
    await held.release();
    const next = await acquireLock(path.join(root, 'x.lock'), { waitMs: 200, pollMs: 20 });
    expect(next.lost()).toBe(false);
    await next.release();
  });

  it('a lost lock is found out before anything is published', async () => {
    const lockFile = path.join(tmpDir(), 'y.lock');
    const held = await acquireLock(lockFile, { heartbeatMs: 60_000 });
    expect(await held.stillHeld()).toBe(true);
    // Another installer took it over while this one was paused: the file names its token now.
    fs.writeFileSync(lockFile, JSON.stringify({ token: 'other' }));
    expect(await held.stillHeld()).toBe(false);
    expect(held.lost()).toBe(true);
    await held.release();
    expect(fs.existsSync(lockFile)).toBe(true); // the other holder's, left alone
  });

  it('a newer version replaces the old one on disk', async () => {
    const v1 = setup({ version: '1.0.0-1' });
    await installComponent('images', { root: v1.root, platform: PLATFORM, manifest: v1.manifest, ...fast });
    const v2 = fakeComponent('images', PLATFORM, { version: '1.0.0-2' });
    srv.serve(v2.entry.asset, v2.archive);
    const inst = await installComponent('images', { root: v1.root, platform: PLATFORM, manifest: v2.manifest, ...fast });
    expect(fs.readdirSync(path.join(v1.root, 'images'))).toEqual(['1.0.0-2']);
    expect(createRequire(path.join(inst.dir, 'index.js'))('fake-lib').hello()).toBe('hello from images-1.0.0-2');
  });

  it('a dir without the finished marker is replaced, never trusted', async () => {
    const c = setup();
    const dir = path.join(c.root, 'images', '1.0.0-1', PLATFORM);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'half-written.js'), 'x');
    expect(await findInstalled('images', { root: c.root, platform: PLATFORM, manifest: c.manifest })).toBeNull();
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(fs.existsSync(path.join(dir, 'half-written.js'))).toBe(false);
    expect(fs.existsSync(path.join(dir, MARKER))).toBe(true);
  });

  it('stops when asked to', async () => {
    const c = setup({ padBytes: 2_000_000 });
    srv.fault(c.entry.asset, { chunkDelayMs: 50 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 150);
    await expect(installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast, signal: ac.signal }))
      .rejects.toMatchObject({ code: 'aborted' });
  });
});


describe('versions on one data home', () => {
  it('orders versions by package version, then revision', () => {
    expect(compareVersions('1.0.0-1', '1.0.0-2')).toBeLessThan(0);
    expect(compareVersions('1.10.0-1', '1.9.0-7')).toBeGreaterThan(0);
    expect(compareVersions('0.34.5-2', '0.34.5-2')).toBe(0);
    expect(compareVersions('4.2.0-1', '4.2.1-1')).toBeLessThan(0);
  });

  it('never removes a newer version: another Walnut build on this data home uses it', async () => {
    const v2 = setup({ version: '1.0.0-2' });
    await installComponent('images', { root: v2.root, platform: PLATFORM, manifest: v2.manifest, ...fast });
    const v1 = fakeComponent('images', PLATFORM, { version: '1.0.0-1' });
    srv.serve(v1.entry.asset, v1.archive);
    await installComponent('images', { root: v2.root, platform: PLATFORM, manifest: v1.manifest, ...fast });
    expect(fs.readdirSync(path.join(v2.root, 'images')).sort()).toEqual(['1.0.0-1', '1.0.0-2']);
    expect((await findInstalled('images', { root: v2.root, platform: PLATFORM, manifest: v2.manifest }))?.version).toBe('1.0.0-2');
    expect((await findInstalled('images', { root: v2.root, platform: PLATFORM, manifest: v1.manifest }))?.version).toBe('1.0.0-1');
  });

  it('until the pinned version is installed, the newest finished older one serves', async () => {
    const v1 = setup({ version: '1.0.0-1' });
    await installComponent('images', { root: v1.root, platform: PLATFORM, manifest: v1.manifest, ...fast });
    // An unfinished install of another older version is never used.
    fs.mkdirSync(path.join(v1.root, 'images', '1.0.0-0', PLATFORM), { recursive: true });
    const v3 = fakeComponent('images', PLATFORM, { version: '1.0.0-3' });
    const usable = await findUsable('images', { root: v1.root, platform: PLATFORM, manifest: v3.manifest });
    expect(usable).toMatchObject({ version: '1.0.0-1', fallback: true });
    expect(createRequire(path.join(usable!.dir, 'index.js'))('fake-lib').hello()).toBe('hello from images-1.0.0-1');
    expect(await findInstalled('images', { root: v1.root, platform: PLATFORM, manifest: v3.manifest })).toBeNull();
  });

  it('a marker that names another hash than the pin is not the pinned install', async () => {
    const c = setup();
    const inst = await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    const marker = JSON.parse(fs.readFileSync(path.join(inst.dir, MARKER), 'utf8'));
    fs.writeFileSync(path.join(inst.dir, MARKER), JSON.stringify({ ...marker, tarSha256: '0'.repeat(64) }));
    expect(await findInstalled('images', { root: c.root, platform: PLATFORM, manifest: c.manifest })).toBeNull();
    // Installing again replaces it.
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(await findInstalled('images', { root: c.root, platform: PLATFORM, manifest: c.manifest })).not.toBeNull();
  });

  it('an install clears older versions\' leftovers from .downloads and keeps a newer build\'s and a live holder\'s', async () => {
    const c = setup({ version: '1.0.0-2' });
    const downloads = path.join(c.root, '.downloads');
    fs.mkdirSync(downloads, { recursive: true });
    const put = (f: string, ageMs = 0) => {
      fs.writeFileSync(path.join(downloads, f), 'x');
      if (ageMs) { const t = new Date(Date.now() - ageMs); fs.utimesSync(path.join(downloads, f), t, t); }
    };
    put(`walnut-images-1.0.0-1-${PLATFORM}.tar.gz`); // an older build's handed archive
    put(`walnut-images-1.0.0-1-${PLATFORM}.tar.gz.abc.part`); // an older build's partial download
    put(`walnut-images-1.0.0-2-${PLATFORM}.tar.gz.live.part`); // another holder of this version, writing now
    put(`walnut-images-1.0.0-2-${PLATFORM}.tar.gz.dead.part`, 30 * 60_000); // one that went quiet long ago
    put(`walnut-images-1.0.0-3-${PLATFORM}.tar.gz.newer.part`); // a newer build's
    put('walnut-embedding-9.9.9-1-linux-x64.tar.gz'); // another component's
    await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(fs.readdirSync(downloads).sort()).toEqual([
      'walnut-embedding-9.9.9-1-linux-x64.tar.gz',
      `walnut-images-1.0.0-2-${PLATFORM}.tar.gz.live.part`,
      `walnut-images-1.0.0-3-${PLATFORM}.tar.gz.newer.part`,
    ]);
  });
});

describe('a host without internet', () => {
  const offline: typeof fetch = async () => { throw new TypeError('fetch failed: no network'); };

  it('installs an archive placed in .downloads by hand, with no network', async () => {
    const c = setup();
    fs.mkdirSync(path.join(c.root, '.downloads'), { recursive: true });
    fs.writeFileSync(path.join(c.root, '.downloads', c.entry.asset), c.archive);
    const inst = await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast, fetchImpl: offline });
    expect(createRequire(path.join(inst.dir, 'index.js'))('fake-lib').hello()).toBe('hello from images-1.0.0-1');
    expect(fs.readdirSync(path.join(c.root, '.downloads'))).toEqual([]);
  });

  it('a placed archive that is not the pinned one is removed, and the download used instead', async () => {
    const c = setup();
    fs.mkdirSync(path.join(c.root, '.downloads'), { recursive: true });
    fs.writeFileSync(path.join(c.root, '.downloads', c.entry.asset), fakeComponent('images', PLATFORM, { marker: 'other' }).archive);
    const inst = await installComponent('images', { root: c.root, platform: PLATFORM, manifest: c.manifest, ...fast });
    expect(createRequire(path.join(inst.dir, 'index.js'))('fake-lib').hello()).toBe('hello from images-1.0.0-1');
    expect(srv.requests.filter((r) => r.url.endsWith(c.entry.asset))).toHaveLength(1);
  });

  it('without one, an offline host fails with a network reason', async () => {
    const c = setup();
    await expect(installComponent('images', { root: tmpDir(), platform: PLATFORM, manifest: c.manifest, ...fast, fetchImpl: offline }))
      .rejects.toMatchObject({ code: 'network', message: expect.stringMatching(/no network/) });
  });
});
