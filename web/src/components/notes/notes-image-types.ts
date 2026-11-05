/**
 * Vault file types the notes surfaces draw as a picture (`![[x.tif]]` embeds,
 * the tree's attachment preview). tif/bmp are scans and exports, which WebKit
 * draws; heic is what an iPhone camera writes; svg is served under a sandbox
 * CSP. A browser that cannot decode one fails the <img> and the surface falls
 * back to its click-to-open card. Must cover every image type the attachment
 * route serves inline (tests/web/notes-image-forms.test.ts).
 */
export const NOTE_IMAGE_EXTS: ReadonlySet<string> = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'heif', 'tif', 'tiff', 'bmp', 'avif', 'svg',
]);
