/**
 * sharp's first load runs in a worker first (src/utils/warm-module.ts), so the
 * loop thread never reads libvips from disk itself: on the Mac that read held
 * every request 4.1 s (2026-11-19 01:25Z stall profile: 99% of the hold in
 * sharp's require).
 */
import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { __setSharpForTests, __setSharpWarmForTests, loadSharp } from '../../src/utils/image-compress.js';
import { warmModuleOffThread } from '../../src/utils/warm-module.js';

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);
const sharpEntry = (() => { try { return createRequire(import.meta.url).resolve('sharp'); } catch { return null; } })();

afterEach(() => {
  __setSharpWarmForTests(null);
  __setSharpForTests(undefined);
});

describe('warmModuleOffThread', () => {
  it.skipIf(!sharpEntry)('loads sharp in a worker thread', async () => {
    expect(await warmModuleOffThread(sharpEntry!)).toBe(true);
  });

  it('answers false for a module that is missing or throws, and never rejects', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'warm-'));
    const throws = path.join(dir, 'throws.cjs');
    fs.writeFileSync(throws, "throw new Error('no native library here')");
    try {
      expect(await warmModuleOffThread(path.join(dir, 'missing.cjs'))).toBe(false);
      expect(await warmModuleOffThread(throws)).toBe(false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('loadSharp', () => {
  it.skipIf(!sharpEntry)('warms sharp off the loop thread before loading it, then works', async () => {
    const order: string[] = [];
    __setSharpWarmForTests(async (resolveEntry) => {
      const entry = resolveEntry();
      order.push(`warm ${path.basename(path.dirname(path.dirname(entry)))}`);
      expect(await warmModuleOffThread(entry)).toBe(true);
      order.push('warmed');
    });
    __setSharpForTests(undefined);
    const sharp = await loadSharp();
    expect(sharp).not.toBeNull();
    expect(order).toEqual(['warm sharp', 'warmed']);
    const meta = await sharp!(tinyPng).metadata();
    expect(meta.width).toBe(1);
  });
});
