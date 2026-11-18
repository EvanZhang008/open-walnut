/**
 * The envelope the Files preview keeps a page's state in (src/web/preview-state-script.ts writes
 * and reads it in the page). Three copies, each with the parts its place keeps:
 *  - on disk, per file (src/web/routes/preview-storage.ts): what a browser keeps for a site
 *    (localStorage, persistent cookies, IndexedDB, the Cache API, the page's place);
 *  - in this Walnut window's own sessionStorage, per file (web/src/components/common/preview-frame.ts):
 *    what a browser keeps for a tab (sessionStorage, session cookies);
 *  - in the frame's `window.name`, all of it, from one document of the frame to the next.
 */

/** The mark an envelope in the frame's `window.name` starts with. */
export const PREVIEW_STATE_PREFIX = '\u0001walnut-preview-state:'
/** The most the disk copy may hold (characters); past it the largest parts keep their last copy. */
export const PREVIEW_STATE_MAX = 8 * 1024 * 1024
/** The most the session copy may hold (characters). */
export const PREVIEW_SESSION_MAX = 1024 * 1024
/** The most the frame's name may carry (characters); past it IndexedDB and the Cache API stay on disk only. */
export const PREVIEW_NAME_MAX = 4 * 1024 * 1024
