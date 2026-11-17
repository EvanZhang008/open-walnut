/**
 * The envelope the Files preview keeps a page's state in between two documents of the same file
 * (src/web/preview-state-script.ts writes and reads it in the page; the console keeps a copy per
 * file and names a new frame with it, web/src/components/common/preview-frame.ts).
 */

/** The mark an envelope in the frame's `window.name` starts with. */
export const PREVIEW_STATE_PREFIX = '\u0001walnut-preview-state:'
/** The most an envelope may hold (characters); past it the page's storage is left out. */
export const PREVIEW_STATE_MAX = 1_000_000
