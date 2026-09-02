/**
 * How a file is RENDERED, by extension — the one answer both the viewer and the
 * things that fetch on its behalf need.
 *
 * It lived inside FileContentView, which was fine while the pane was the only
 * thing that cared. The tree's hover prefetch cares too: a `rawKind` file never
 * goes through the JSON content fetch at all, so prefetching one would be a
 * whole-file read (over the SSH tunnel, for a remote host) that nothing will ever
 * use. One shared predicate means the prefetcher and the pane cannot disagree
 * about which files those are.
 */

const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'mov']);
const AUDIO_EXTS = new Set(['mp3', 'wav', 'm4a', 'ogg']);
// PDFs and rasters are rendered by the BROWSER's own viewer (PDF.js / image
// decoder) from the raw-bytes URL — we deliberately don't bundle a PDF renderer
// or build a zoom/rotate UI. Chrome and Firefox already have a better one.
const DOC_EXTS = new Set(['pdf']);
// svg is NOT here: it's text, so the source/preview toggle is more useful (and
// the markdown/HTML path already renders it when embedded).
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'heic', 'tiff', 'tif']);
// Office documents — read-only preview rendered CLIENT-SIDE by lazy-loaded
// open-source libs (docx-preview / SheetJS / pptx-preview) from the raw-bytes
// URL. Legacy binary formats (.doc/.ppt) have no browser renderer and stay on
// the binary-download fallback.
const WORD_EXTS = new Set(['docx']);
const SHEET_EXTS = new Set(['xlsx', 'xls', 'xlsm', 'xlsb', 'ods']);
const SLIDES_EXTS = new Set(['pptx']);

export type RawKind = 'video' | 'audio' | 'doc' | 'image' | 'word' | 'sheet' | 'slides';

/**
 * Files served as RAW BYTES and rendered by a native browser control or a
 * client-side office renderer, never through the JSON content fetch — a
 * whole-file text read would corrupt them (and a remote 100MB video would kill
 * the tunnel).
 *   video/audio → <video>/<audio> (+ our speed/skip toolbar)
 *   doc         → <iframe> → the browser's built-in PDF viewer
 *   image       → <img>
 *   word/sheet/slides → lazy-loaded office preview
 */
export function rawKind(path: string): RawKind | null {
  const e = (path.split('.').pop() || '').toLowerCase();
  if (VIDEO_EXTS.has(e)) return 'video';
  if (AUDIO_EXTS.has(e)) return 'audio';
  if (DOC_EXTS.has(e)) return 'doc';
  if (IMAGE_EXTS.has(e)) return 'image';
  if (WORD_EXTS.has(e)) return 'word';
  if (SHEET_EXTS.has(e)) return 'sheet';
  if (SLIDES_EXTS.has(e)) return 'slides';
  return null;
}

/** The subset of rawKind that owns the playback toolbar (speed / skip keys). */
export function isPlayable(kind: RawKind | null): kind is 'video' | 'audio' {
  return kind === 'video' || kind === 'audio';
}

export function isMarkdownExt(ext: string | undefined, path: string): boolean {
  const e = (ext || path.split('.').pop() || '').toLowerCase();
  return e === 'md' || e === 'markdown' || e === 'mdx';
}
