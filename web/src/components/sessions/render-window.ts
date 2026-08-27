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
}

/** The PREVIOUS pass — may be the fresh-view state (nothing rendered yet). */
export interface RenderWindowState {
  start: number | null;
  anchor: RenderWindowAnchor | null;
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

  const start = ratchet === null ? natural : Math.min(natural, ratchet);
  return { start, anchor: anchorAt(messages, start) };
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
