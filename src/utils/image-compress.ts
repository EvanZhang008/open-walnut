import type sharpType from 'sharp';
import { log } from '../logging/index.js';

type SharpFn = typeof sharpType;

/**
 * sharp is an OPTIONAL dependency (package.json optionalDependencies). Its prebuilt
 * binary needs glibc 2.28+, and its source build needs libvips, which older distros
 * (glibc 2.26 boxes, for one) do not package, so on such a machine `npm install`
 * skips it rather than failing the whole install. Walnut still runs: pasted images
 * pass through uncompressed and the callers' existing size guards decide. Loaded
 * once, on first use, so a missing module costs one warning, not one per image.
 */
let sharpLoad: Promise<SharpFn | null> | undefined;

async function loadSharp(): Promise<SharpFn | null> {
  sharpLoad ??= import('sharp').then(
    (m) => (m.default ?? m) as unknown as SharpFn,
    (err: unknown) => {
      log.agent.warn('sharp is not installed; images are sent uncompressed', {
        error: err instanceof Error ? err.message : String(err),
        fix: 'a machine with glibc 2.28+ installs sharp prebuilt; otherwise install libvips and re-run npm install',
      });
      return null;
    },
  );
  return sharpLoad;
}

/** Test seam: force the next load to resolve to this module (or to "missing" with null). */
export function __setSharpForTests(sharp: SharpFn | null | undefined): void {
  sharpLoad = sharp === undefined ? undefined : Promise.resolve(sharp);
}

/**
 * Bedrock hard limit: 5,242,880 bytes for base64-encoded image data.
 * We target slightly below to leave headroom.
 * Exported so callers can use the same constant for their own guard checks.
 */
export const MAX_BASE64_BYTES = 5_000_000;

/**
 * Model providers reject a multi-image request when ANY image exceeds this many
 * pixels on either dimension ("At least one of the image dimensions exceed max
 * allowed size for many-image requests: 2000 pixels"). Byte-size compression
 * alone does NOT protect against it — a 1 MB 2048px JPEG is small enough to
 * skip compression entirely and still poisons the request. Because a stored
 * image is replayed with every later turn in the same conversation, one
 * oversized image permanently bricks the thread, so this clamp runs on both
 * ingest and replay.
 */
export const MAX_IMAGE_DIMENSION = 1568;

/**
 * Downscale so the longest side is at most MAX_IMAGE_DIMENSION, leaving smaller
 * images byte-identical. Returns the input unchanged if sharp can't read it (or
 * is not installed).
 */
export async function clampImageDimensions(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  const sharp = await loadSharp();
  if (!sharp) return { buffer, mimeType };
  try {
    const meta = await sharp(buffer).metadata();
    const longest = Math.max(meta.width ?? 0, meta.height ?? 0);
    if (longest <= MAX_IMAGE_DIMENSION) return { buffer, mimeType };
    // GIFs keep their format (animation) — everything else re-encodes as JPEG,
    // which is what the byte-compression path below would produce anyway.
    if (mimeType === 'image/gif') {
      const resized = await sharp(buffer, { animated: true })
        .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside' })
        .gif()
        .toBuffer();
      return { buffer: resized, mimeType };
    }
    const resized = await sharp(buffer)
      .resize({ width: MAX_IMAGE_DIMENSION, height: MAX_IMAGE_DIMENSION, fit: 'inside' })
      .jpeg({ quality: 80 })
      .toBuffer();
    return { buffer: resized, mimeType: 'image/jpeg' };
  } catch {
    // Unsupported/corrupt input — leave it to the caller's existing fallbacks.
    return { buffer, mimeType };
  }
}

/**
 * Compress an image buffer so its base64 representation fits under Bedrock's 5 MB limit.
 *
 * Strategy:
 *   0. Clamp dimensions to MAX_IMAGE_DIMENSION (provider hard limit, independent of bytes).
 *   1. Early-exit if already small enough.
 *   2. GIFs: try WebP (preserves animation), then static JPEG frame as last resort.
 *   3. PNG/JPEG/WebP: convert to JPEG, step quality 85→30 in steps of 10.
 *   4. If quality reduction isn't enough, halve dimensions up to 3 passes.
 *   5. If sharp fails (corrupt data, unsupported format) or is not installed, return original unchanged.
 *
 * Returns { buffer, mimeType } — mimeType may change (e.g. image/png → image/jpeg).
 */
export async function compressForApi(
  inputBuffer: Buffer,
  inputMimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Dimension clamp FIRST: it is a hard provider limit, not a byte budget, so
  // it must apply even to images that are already small enough byte-wise.
  const clamped = await clampImageDimensions(inputBuffer, inputMimeType);
  const buffer = clamped.buffer;
  const mimeType = clamped.mimeType;

  // Already small enough — no work needed
  if (buffer.toString('base64').length <= MAX_BASE64_BYTES) {
    return { buffer, mimeType };
  }

  const sharp = await loadSharp();
  if (!sharp) return { buffer, mimeType };
  try {
    // GIFs: WebP preserves animation and compresses well; JPEG fallback loses animation
    if (mimeType === 'image/gif') {
      const webp = await sharp(buffer, { animated: true }).webp({ quality: 80 }).toBuffer();
      if (webp.toString('base64').length <= MAX_BASE64_BYTES) {
        return { buffer: webp, mimeType: 'image/webp' };
      }
      // Animated WebP still too large — extract first frame as JPEG
      const frame = await sharp(buffer).jpeg({ quality: 70 }).toBuffer();
      if (frame.toString('base64').length <= MAX_BASE64_BYTES) {
        return { buffer: frame, mimeType: 'image/jpeg' };
      }
      // Caller will substitute placeholder
      return { buffer, mimeType };
    }

    // PNG / JPEG / WebP: convert to JPEG and step down quality
    let quality = 85;
    let candidate = await sharp(buffer).jpeg({ quality }).toBuffer();
    let b64Len = candidate.toString('base64').length;

    while (b64Len > MAX_BASE64_BYTES && quality > 30) {
      quality -= 10;
      candidate = await sharp(buffer).jpeg({ quality }).toBuffer();
      b64Len = candidate.toString('base64').length;
    }

    if (b64Len <= MAX_BASE64_BYTES) {
      return { buffer: candidate, mimeType: 'image/jpeg' };
    }

    // Quality reduction alone wasn't enough — halve dimensions up to 3 passes
    const meta = await sharp(buffer).metadata();
    let w = meta.width ?? 1920;
    let h = meta.height ?? 1080;
    for (let pass = 0; pass < 3 && b64Len > MAX_BASE64_BYTES; pass++) {
      w = Math.max(1, Math.round(w / 2));
      h = Math.max(1, Math.round(h / 2));
      candidate = await sharp(buffer).resize(w, h).jpeg({ quality: 70 }).toBuffer();
      b64Len = candidate.toString('base64').length;
    }

    return { buffer: candidate, mimeType: 'image/jpeg' };
  } catch {
    // Unsupported format (SVG, BMP, etc.) — return as-is, caller will handle the fallback
    return { buffer, mimeType };
  }
}
