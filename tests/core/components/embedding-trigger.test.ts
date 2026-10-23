/**
 * Search by meaning fetches its library when the semantic lane asks for it
 * (src/core/search/wiring.ts embeddingModuleUrl): in the background, on the
 * primary as on a follower, and again after a failure once its backoff has
 * passed. Until the library lands, every ask answers null (keyword only) at once.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { componentStatus, resetComponentsForTests, resolveComponent } from '../../../src/core/components/index.js';
import { setManifestForTests } from '../../../src/core/components/manifest.js';
import { resetPlatformForTests } from '../../../src/core/components/platform.js';
import { embeddingModuleUrl } from '../../../src/core/search/wiring.js';
import { fakeComponent, startReleaseServer, tmpDir, type ReleaseServer } from './helpers.js';

const ENV = ['WALNUT_COMPONENTS_DIR', 'WALNUT_COMPONENTS_FROM', 'WALNUT_COMPONENTS_PLATFORM', 'WALNUT_COMPONENTS_BASE_URL'];
const saved: Record<string, string | undefined> = {};
let srv: ReleaseServer;
const c = fakeComponent('embedding', 'linux-x64');
const asks = () => srv.requests.filter((r) => r.url.endsWith(c.entry.asset)).length;

async function until(cond: () => boolean, ms = 10_000): Promise<void> {
  for (const t0 = Date.now(); !cond(); await new Promise((r) => setTimeout(r, 20))) {
    if (Date.now() - t0 > ms) throw new Error('timed out');
  }
}

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  srv = await startReleaseServer();
  srv.serve(c.entry.asset, c.archive);
});
afterAll(async () => {
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setManifestForTests(undefined);
  resetComponentsForTests();
  resetPlatformForTests();
  await srv.close();
});
beforeEach(() => {
  process.env.WALNUT_COMPONENTS_DIR = tmpDir();
  process.env.WALNUT_COMPONENTS_FROM = 'download';
  process.env.WALNUT_COMPONENTS_PLATFORM = 'linux-x64';
  process.env.WALNUT_COMPONENTS_BASE_URL = srv.base;
  setManifestForTests(c.manifest);
  resetPlatformForTests();
  srv.requests.length = 0;
});

describe('embeddingModuleUrl', () => {
  it('answers null at once, installs in the background, then names the downloaded library', async () => {
    resetComponentsForTests({ backoffMs: 10, lock: { pollMs: 20 } });
    const t0 = Date.now();
    expect(embeddingModuleUrl()).toBeNull();
    expect(Date.now() - t0).toBeLessThan(50);
    await until(() => componentStatus('embedding').state === 'ready');
    const loaded = resolveComponent('embedding');
    if (loaded?.source !== 'installed') throw new Error('not installed');
    expect(embeddingModuleUrl()).toBe(loaded.entryUrl);
    expect(asks()).toBe(1);
  });

  it('after a failure, asks again only once the backoff has passed', async () => {
    resetComponentsForTests({ backoffMs: 10, retries: 0, lock: { pollMs: 20 }, retryBaseMs: 400 });
    srv.fault(c.entry.asset, { status: 503 });
    expect(embeddingModuleUrl()).toBeNull();
    await until(() => componentStatus('embedding').state === 'failed');
    expect(asks()).toBe(1);
    expect(embeddingModuleUrl()).toBeNull(); // the backfill's next pass, inside the backoff
    await new Promise((r) => setTimeout(r, 50));
    expect(asks()).toBe(1);
    await new Promise((r) => setTimeout(r, 450));
    expect(embeddingModuleUrl()).toBeNull();
    await until(() => componentStatus('embedding').state === 'ready');
    expect(asks()).toBe(2);
    expect(embeddingModuleUrl()).toMatch(/^file:/);
  });
});
