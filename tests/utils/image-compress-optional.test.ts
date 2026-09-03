import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __setSharpForTests,
  clampImageDimensions,
  compressForApi,
  MAX_BASE64_BYTES,
} from '../../src/utils/image-compress.js';

// sharp is an optional dependency: on a machine whose C library predates its prebuilt
// binary (and has no libvips to build from source) `npm install` skips it. Walnut must
// keep working there, with images passed through untouched, and must not touch sharp
// at all for images that are already small enough.

const tinyPng = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

afterEach(() => __setSharpForTests(undefined));

describe('image compression without sharp', () => {
  it('clampImageDimensions returns the input byte-for-byte', async () => {
    __setSharpForTests(null);
    const out = await clampImageDimensions(tinyPng, 'image/png');
    expect(out.buffer).toBe(tinyPng);
    expect(out.mimeType).toBe('image/png');
  });

  it('compressForApi returns an oversized image unchanged instead of throwing', async () => {
    __setSharpForTests(null);
    const big = Buffer.alloc(MAX_BASE64_BYTES, 1); // base64 of this is > MAX_BASE64_BYTES
    const out = await compressForApi(big, 'image/jpeg');
    expect(out.buffer).toBe(big);
    expect(out.mimeType).toBe('image/jpeg');
  });
});

describe('image compression with sharp present', () => {
  it('does no sharp work beyond metadata for an image that is already small', async () => {
    const metadata = vi.fn().mockResolvedValue({ width: 1, height: 1 });
    const toBuffer = vi.fn();
    const fake = vi.fn(() => ({ metadata, jpeg: () => ({ toBuffer }), resize: () => ({ jpeg: () => ({ toBuffer }) }) }));
    __setSharpForTests(fake as never);
    const out = await compressForApi(tinyPng, 'image/png');
    expect(out.buffer).toBe(tinyPng);
    expect(metadata).toHaveBeenCalledTimes(1);
    expect(toBuffer).not.toHaveBeenCalled();
  });

  it('re-encodes an oversized image through sharp', async () => {
    const small = Buffer.from('jpeg-bytes');
    const chain = { toBuffer: vi.fn().mockResolvedValue(small) };
    const fake = vi.fn(() => ({
      metadata: vi.fn().mockResolvedValue({ width: 10, height: 10 }),
      jpeg: () => chain,
      resize: () => ({ jpeg: () => chain }),
    }));
    __setSharpForTests(fake as never);
    const big = Buffer.alloc(MAX_BASE64_BYTES, 1);
    const out = await compressForApi(big, 'image/png');
    expect(out.buffer).toBe(small);
    expect(out.mimeType).toBe('image/jpeg');
  });
});
