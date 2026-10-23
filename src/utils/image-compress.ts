import type sharpType from 'sharp';
import { log } from '../logging/index.js';
import { componentStatus, ensureComponent, loadComponent, markBundledBroken, markInstalledBroken, whenComponentReady } from '../core/components/index.js';

type SharpFn = typeof sharpType;

/**
 * sharp is an optional part of Walnut. Running from source or an npm install,
 * it comes from node_modules; the compiled file carries none and downloads the
 * `images` component (src/core/components/) the first time an image needs
 * resizing. An image waits for that download only up to the install's own
 * deadline (20 s from its start, shared by every image that arrives meanwhile),
 * and once per image, however many steps need sharp. Past it, and on a machine
 * where neither loads (no network, no build for the platform), images pass
 * through uncompressed and the callers' existing size guards decide. A stored
 * image is clamped again on replay, so a conversation heals once the component
 * lands.
 */
let sharpFn: SharpFn | null = null;
let sharpLoading: Promise<SharpFn | null> | null = null;
let sharpForTests: SharpFn | null | undefined;
let warnedFor: string | null = null;

function moduleFn(m: unknown): SharpFn {
  return ((m as { default?: unknown }).default ?? m) as SharpFn;
}

function warnOnce(reason: string, extra: Record<string, unknown> = {}): void {
  if (warnedFor === reason) return;
  warnedFor = reason;
  log.agent.warn('image resizing is not available; images are sent uncompressed', { reason, ...extra });
}

const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

async function tryLoadSharp(): Promise<SharpFn | null> {
  let comp = await loadComponent('images');
  if (comp?.source === 'bundled') {
    try {
      return moduleFn(await import('sharp'));
    } catch (err) {
      // An npm install on an older C library than sharp's prebuilt needs: the component's build runs there.
      markBundledBroken('images', err);
      comp = null;
    }
  }
  if (!comp) {
    void ensureComponent('images', 'feature');
    if (!(await whenComponentReady('images'))) {
      const status = componentStatus('images');
      warnOnce(status.state, { error: status.error, code: status.code });
      return null;
    }
    comp = await loadComponent('images');
  }
  if (comp?.source !== 'installed') return null;
  try {
    return moduleFn(comp.require('sharp'));
  } catch (err) {
    warnOnce('load-failed', { error: errText(err) });
    markInstalledBroken('images', err);
    return null;
  }
}

/** sharp, once it loads; null while it does not (asked again on the next image). Never throws. */
async function loadSharp(): Promise<SharpFn | null> {
  if (sharpForTests !== undefined) return sharpForTests;
  if (sharpFn) return sharpFn;
  sharpLoading ??= tryLoadSharp()
    .catch((err: unknown) => { warnOnce('error', { error: errText(err) }); return null; })
    .then((fn) => { sharpFn = fn; return fn; })
    .finally(() => { sharpLoading = null; });
  return sharpLoading;
}

/** Test seam: force the next load to resolve to this module (or to "missing" with null). */
export function __setSharpForTests(sharp: SharpFn | null | undefined): void {
  sharpForTests = sharp;
  if (sharp === undefined) { sharpFn = null; warnedFor = null; }
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
  return clampWith(await loadSharp(), buffer, mimeType);
}

async function clampWith(sharp: SharpFn | null, buffer: Buffer, mimeType: string): Promise<{ buffer: Buffer; mimeType: string }> {
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
  // One load per image: a missing component costs one wait, not one per step.
  const sharp = await loadSharp();
  // Dimension clamp FIRST: it is a hard provider limit, not a byte budget, so
  // it must apply even to images that are already small enough byte-wise.
  const clamped = await clampWith(sharp, inputBuffer, inputMimeType);
  const buffer = clamped.buffer;
  const mimeType = clamped.mimeType;

  // Already small enough — no work needed
  if (buffer.toString('base64').length <= MAX_BASE64_BYTES) {
    return { buffer, mimeType };
  }

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
