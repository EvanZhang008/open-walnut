import sharp from 'sharp';

/**
 * Bedrock hard limit: 5,242,880 bytes for base64-encoded image data.
 * We target slightly below to leave headroom.
 * Exported so callers can use the same constant for their own guard checks.
 */
export const MAX_BASE64_BYTES = 5_000_000;

/**
 * Compress an image buffer so its base64 representation fits under Bedrock's 5 MB limit.
 *
 * Strategy:
 *   1. Early-exit if already small enough.
 *   2. GIFs: try WebP (preserves animation), then static JPEG frame as last resort.
 *   3. PNG/JPEG/WebP: convert to JPEG, step quality 85→30 in steps of 10.
 *   4. If quality reduction isn't enough, halve dimensions up to 3 passes.
 *   5. If sharp fails (corrupt data, unsupported format), return original unchanged.
 *
 * Returns { buffer, mimeType } — mimeType may change (e.g. image/png → image/jpeg).
 */
export async function compressForApi(
  buffer: Buffer,
  mimeType: string,
): Promise<{ buffer: Buffer; mimeType: string }> {
  // Already small enough — no work needed
  if (buffer.toString('base64').length <= MAX_BASE64_BYTES) {
    return { buffer, mimeType };
  }

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
