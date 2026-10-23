/**
 * An image waits for the images component only up to the install's own
 * deadline, once per image however many steps need sharp, and not at all once
 * that deadline has passed: a release server that stalls never makes a send
 * slow by more than the cap. Past it, the image passes through unchanged.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import sharpForTest from 'sharp';
import { componentStatus, resetComponentsForTests } from '../../../src/core/components/index.js';
import { setManifestForTests } from '../../../src/core/components/manifest.js';
import { resetPlatformForTests } from '../../../src/core/components/platform.js';
import { fakeComponent, startReleaseServer, tmpDir, type ReleaseServer } from './helpers.js';

const ENV = ['WALNUT_COMPONENTS_DIR', 'WALNUT_COMPONENTS_FROM', 'WALNUT_COMPONENTS_PLATFORM', 'WALNUT_COMPONENTS_BASE_URL'];
const saved: Record<string, string | undefined> = {};
const CAP_MS = 1_500;
let srv: ReleaseServer;
const stop = new AbortController();

beforeAll(async () => {
  for (const k of ENV) saved[k] = process.env[k];
  srv = await startReleaseServer();
  const c = fakeComponent('images', 'linux-x64', { padBytes: 100_000 });
  srv.serve(c.entry.asset, c.archive);
  // Headers, then nothing: the connection neither fails nor finishes.
  srv.fault(c.entry.asset, { stallAfter: 0, stallMs: 60_000 });
  setManifestForTests(c.manifest);
  process.env.WALNUT_COMPONENTS_DIR = tmpDir();
  process.env.WALNUT_COMPONENTS_FROM = 'download';
  process.env.WALNUT_COMPONENTS_PLATFORM = 'linux-x64';
  process.env.WALNUT_COMPONENTS_BASE_URL = srv.base;
  resetPlatformForTests();
  resetComponentsForTests({ idleTimeoutMs: 60_000, featureWaitMs: CAP_MS, signal: stop.signal });
});

afterAll(async () => {
  stop.abort();
  for (const k of ENV) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  setManifestForTests(undefined);
  resetComponentsForTests();
  resetPlatformForTests();
  await srv.close();
});

/** Too many pixels on a side and too many bytes: both the clamp and the byte budget need sharp. */
async function bigNoisyPng(): Promise<Buffer> {
  const width = 2400;
  const height = 1700;
  const raw = Buffer.alloc(width * height * 3);
  let x = 0x12345678;
  for (let i = 0; i < raw.length; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; raw[i] = x & 0xff; }
  return sharpForTest(raw, { raw: { width, height, channels: 3 } }).png({ compressionLevel: 1 }).toBuffer();
}

describe('an image while the images component cannot download', () => {
  it('waits once, up to the cap, then passes through; the next send does not wait at all', async () => {
    const { compressForApi, clampImageDimensions, MAX_BASE64_BYTES } = await import('../../../src/utils/image-compress.js');
    const png = await bigNoisyPng();
    expect(png.toString('base64').length).toBeGreaterThan(MAX_BASE64_BYTES);

    const t0 = Date.now();
    const first = await compressForApi(png, 'image/png');
    const firstMs = Date.now() - t0;
    expect(first.buffer).toBe(png);
    expect(first.mimeType).toBe('image/png');
    // One wait for the whole image, not one per step that needs sharp.
    expect(firstMs).toBeGreaterThanOrEqual(CAP_MS - 50);
    expect(firstMs).toBeLessThan(CAP_MS * 1.6);

    const t1 = Date.now();
    const second = await compressForApi(png, 'image/png');
    const replayed = await clampImageDimensions(png, 'image/png');
    expect(Date.now() - t1).toBeLessThan(300);
    expect(second.buffer).toBe(png);
    expect(replayed.buffer).toBe(png);
    // Still downloading in the background, for the image after it lands.
    expect(componentStatus('images').state).toBe('downloading');
  }, 30_000);
});
