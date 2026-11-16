/**
 * The session-chat render window (which slice of `messages[]` becomes DOM).
 *
 * It is a TAIL slice that only ever ratchets DOWN (older): once a row is
 * rendered it stays rendered, so message growth can never evict rows from above
 * the reader (inc-1786553756848). The trap this module exists to close: the
 * ratchet used to be a plain INDEX into `messages[]`, but that array's indexing
 * changes under us all the time —
 *
 *   - "Load earlier" backfill PREPENDS rows (every index shifts up),
 *   - a tail-bounded refetch returns the last N while we held N+k (head drop),
 *   - Phase 1 (local streams) and Phase 2 (archive) can hold DIFFERENT-length
 *     windows of the same conversation, so first open re-windows the array
 *     1-2s after it first painted,
 *   - /compact rewrites the transcript and the old head simply vanishes.
 *
 * A numeric ratchet survives none of those: keeping index 131 after the array
 * grew a 239-row head means 269 rows render instead of 30 (measured: 35,505px
 * of content instead of 2,907px, the whole first-open flicker), and re-basing
 * it one render too late means the NEXT array change evicts 240 rows at once
 * under a scrolled-up reader (the teleport class).
 *
 * So the window start is anchored to CONTENT (a msgId + its offset from the
 * start) and re-derived on every pass, during render, before the slice is cut.
 *
 * The one exception is a reader who FOLLOWS the bottom (`follow`): nothing above
 * them is on screen, so once the window holds `slack` rows more than the default
 * tail it is cut back to that tail in one step. Without it a column left open on
 * a live session kept every row it ever drew (2026-11-10: 630 rows and 23,000 DOM
 * nodes after three hours of a busy session, about 40 KB of JS heap a row in the
 * production build and the main thread's layout cost growing with them).
 *
 * The window GROWS upward in steps (`growth`): a pass draws at most `rows` rows
 * above the ones already drawn, unless the reader asked for them (`mustShow`:
 * "Load earlier turns", a jump, an older page). The turn window has no row bound
 * (ten turns of an agent's session can be its whole 400-row tail) and the
 * server's first screen is 40 rows, so the full read landing after it drew some
 * 360 rows in one task: 1.8 s on the Mac app beside the Org page (2026-11-16,
 * task 9bceb9f2), 2.2 s on a 4x slower Chromium. The caller draws the next step
 * after the frame; `held` says how many rows the window still owes.
 */

export interface RenderWindowAnchor {
  /** msgId of a row at (or just after) the window start. */
  msgId: string;
  /** How many rows AFTER the window start that msgId sat at. */
  offset: number;
}

/** A computed window: `start` is always a real index. */
export interface RenderWindow {
  start: number;
  /** Content anchor for `start`, or null when no row near the start had a msgId. */
  anchor: RenderWindowAnchor | null;
  /** The window was cut back to the tail for a reader following the bottom. */
  trimmed?: boolean;
  /** Rows the window still owes above `start`, held back by `growth`: drawn in a later pass. */
  held: number;
}

/** How far one pass may grow the window above the rows already drawn. */
export interface RenderWindowGrowth {
  /** Rows a pass may add above what is drawn. */
  rows: number;
  /** Rows a pass draws when its anchor is gone: a fresh view, a rewritten transcript, a slid
   *  window. A slid window (its newest drawn row still there) keeps as many rows as it drew
   *  (`prev.drawn`), so nothing drawn unmounts; a rewritten one starts again from `first`. */
  first: number;
  /** Rows from the end the reader asked to see: always drawn in this pass. */
  mustShow: number;
}

/** A reader parked at the bottom: the window may drop rows above them. */
export interface RenderWindowFollow {
  /** The default tail (rows) the window is cut back to. */
  tailLimit: number;
  /** Rows past the tail held before a cut, so a cut is rare, not one per new row. */
  slack: number;
  /** Whether every row above `tailStart` is off screen; asked only when a cut is due. */
  canCut?: (tailStart: number) => boolean;
}

/** The PREVIOUS pass — may be the fresh-view state (nothing rendered yet). */
export interface RenderWindowState {
  start: number | null;
  anchor: RenderWindowAnchor | null;
  /** What the previous pass drew, when the caller kept it: how many rows from the end, and the id
   *  of the newest of them. */
  drawn?: { rows: number; tailId?: string };
}

/** How far past the window start we look for a row with a msgId to anchor to.
 *  Small: rows without ids are the exception (synthesized/system rows). */
const ANCHOR_SCAN = 20;

/**
 * Compute the render window start for this pass.
 *
 * @param messages current history array (only `msgId` is read)
 * @param limit    how many trailing messages the window should cover
 *                 (INITIAL_RENDER_LIMIT + truncationOffset)
 * @param prev     the previous pass's state (`{start: null, anchor: null}` on
 *                 a fresh session view)
 */
export function computeRenderWindow(
  messages: ReadonlyArray<{ msgId?: string }>,
  limit: number,
  prev: RenderWindowState,
  follow?: RenderWindowFollow,
  growth?: RenderWindowGrowth,
): RenderWindow {
  const natural = Math.max(0, messages.length - limit);

  // Re-base the ratchet onto the row it was actually pinning. Found = the
  // array shifted (prepend/head-drop/window swap) and we follow the content.
  // Not found = those rows are genuinely gone from the data (/compact, window
  // slide); nothing can keep them rendered, so fall back to the tail.
  let ratchet: number | null = prev.start;
  if (prev.anchor) {
    const at = indexOfMsgId(messages, prev.anchor.msgId);
    ratchet = at >= 0 ? Math.max(0, at - prev.anchor.offset) : null;
  }

  const wanted = ratchet === null ? natural : Math.min(natural, ratchet);
  // What is drawn starts at the ratchet; with nothing drawn, the pass draws `first` rows.
  const slid = prev.drawn?.tailId !== undefined && indexOfMsgId(messages, prev.drawn.tailId) >= 0;
  const lowest = ratchet === null
    ? messages.length - Math.max(growth?.first ?? 0, slid ? prev.drawn!.rows : 0)
    : ratchet - (growth?.rows ?? 0);
  const start = growth ? Math.max(wanted, Math.min(lowest, messages.length - growth.mustShow)) : wanted;
  const held = start - wanted;
  if (follow) {
    const tail = Math.max(0, messages.length - follow.tailLimit);
    if (tail - start > follow.slack && (follow.canCut?.(tail) ?? true)) return { start: tail, anchor: anchorAt(messages, tail), trimmed: true, held: 0 };
  }
  return { start, anchor: anchorAt(messages, start), held };
}

function indexOfMsgId(messages: ReadonlyArray<{ msgId?: string }>, msgId: string): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].msgId === msgId) return i;
  }
  return -1;
}

function anchorAt(
  messages: ReadonlyArray<{ msgId?: string }>,
  start: number,
): RenderWindowAnchor | null {
  const end = Math.min(messages.length, start + ANCHOR_SCAN);
  for (let i = start; i < end; i++) {
    const msgId = messages[i].msgId;
    if (msgId) return { msgId, offset: i - start };
  }
  return null;
}
