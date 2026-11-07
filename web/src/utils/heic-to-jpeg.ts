/**
 * A HEIC or HEIF photo (an iPhone's default) as a JPEG, so it is sent as a
 * picture the model can see. Safari and the Mac app decode HEIC natively;
 * a browser that cannot (Chrome on Linux) gets null, and the photo is then
 * attached as a file, as it was picked.
 */

const HEIC_TYPES = new Set(['image/heic', 'image/heif', 'image/heic-sequence', 'image/heif-sequence']);

export function isHeicFile(file: File): boolean {
  if (HEIC_TYPES.has(file.type.toLowerCase())) return true;
  return /\.(heic|heif)$/i.test(file.name);
}

/** The JPEG's name: the photo's own, with `.jpg` in place of `.heic`. */
export function jpegNameFor(name: string): string {
  const base = name.replace(/\.(heic|heif)$/i, '');
  return `${base || 'photo'}.jpg`;
}

async function decode(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void } | null> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bmp = await createImageBitmap(file);
      return { source: bmp, width: bmp.width, height: bmp.height, done: () => bmp.close() };
    } catch { /* fall through to an <img> */ }
  }
  if (typeof Image === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    if (!img.naturalWidth || !img.naturalHeight) { URL.revokeObjectURL(url); return null; }
    return { source: img, width: img.naturalWidth, height: img.naturalHeight, done: () => URL.revokeObjectURL(url) };
  } catch {
    URL.revokeObjectURL(url);
    return null;
  }
}

export async function heicToJpeg(file: File, quality = 0.9): Promise<File | null> {
  const decoded = await decode(file);
  if (!decoded) return null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = decoded.width;
    canvas.height = decoded.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(decoded.source, 0, 0);
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (!blob) return null;
    return new File([blob], jpegNameFor(file.name), { type: 'image/jpeg', lastModified: file.lastModified });
  } catch {
    return null;
  } finally {
    decoded.done();
  }
}
