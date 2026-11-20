/**
 * An uploaded avatar as the server keeps it: any picture, an SVG too, cut to its middle square
 * and drawn at 128 px (WebP, else PNG, else JPEG), a few KB that ride every task list. An SVG is
 * drawn here rather than sent as text: most exported SVGs (comments, a DOCTYPE, <use>, <image>,
 * no viewBox) would be refused by the server's checks, and a drawn one needs none.
 */
import type { OrgAvatarSet } from '@/api/org';

const SIDE = 128;
/** The server's limit (MAX_AVATAR_IMAGE in src/core/org/avatars/avatar-store.ts). */
const MAX_IMAGE_CHARS = 48_000;

/** A picture the canvas can draw, with its size. */
async function drawable(file: File): Promise<{ source: CanvasImageSource; width: number; height: number; done: () => void }> {
  if (file.type === 'image/svg+xml' || /\.svg$/i.test(file.name)) {
    const url = URL.createObjectURL(new Blob([await file.text()], { type: 'image/svg+xml' }));
    const img = new Image();
    try {
      await new Promise<void>((resolve, reject) => { img.onload = () => resolve(); img.onerror = () => reject(new Error('That SVG could not be drawn.')); img.src = url; });
    } catch (err) {
      URL.revokeObjectURL(url);
      throw err;
    }
    // An SVG with no size of its own draws at the browser's default; any square of it will do.
    const width = img.naturalWidth || SIDE;
    const height = img.naturalHeight || SIDE;
    return { source: img, width, height, done: () => URL.revokeObjectURL(url) };
  }
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error('Choose a PNG, JPEG, WebP, GIF or SVG picture.');
  const bitmap = await createImageBitmap(file);
  return { source: bitmap, width: bitmap.width, height: bitmap.height, done: () => bitmap.close() };
}

export async function avatarFileValue(file: File): Promise<OrgAvatarSet> {
  const pic = await drawable(file);
  try {
    const side = Math.min(pic.width, pic.height);
    const canvas = document.createElement('canvas');
    canvas.width = SIDE; canvas.height = SIDE;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('This browser cannot resize pictures.');
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(pic.source, (pic.width - side) / 2, (pic.height - side) / 2, side, side, 0, 0, SIDE, SIDE);
    // A browser that cannot write WebP gives a PNG back instead.
    let image = canvas.toDataURL('image/webp', 0.85);
    if (!/^data:image\/(webp|png);/.test(image) || image.length > MAX_IMAGE_CHARS) image = canvas.toDataURL('image/jpeg', 0.85);
    if (image.length > MAX_IMAGE_CHARS) throw new Error('That picture is still too big at 128 px.');
    return { image };
  } finally {
    pic.done();
  }
}
