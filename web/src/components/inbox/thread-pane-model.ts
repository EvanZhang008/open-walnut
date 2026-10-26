/**
 * The letter reader's two scrolls, as plain numbers.
 *
 * A letter with a thread splits into the DOCUMENT pane (decision, body, items)
 * and the CONVERSATION pane (the thread), each scrolling on its own. Before the
 * split, one scroll held both: a long digest body, whose sandboxed iframe takes
 * every wheel event over it, sat between the human and the newest reply, so a
 * long thread could not be scrolled to its end (2026-10-25).
 *
 * The conversation opens at its newest turn and stays there while the reader is
 * at the end; a reader who scrolled up is never moved, and learns about a new
 * turn from a "New reply" button instead.
 */

/** The document's share of the reader when both panes have more than fits. */
export const DOC_SHARE = 0.4;
/** The smallest and largest share a drag of the divider may give the document. */
export const DOC_SHARE_MIN = 0.12;
export const DOC_SHARE_MAX = 0.85;

/**
 * How tall the document pane may be.
 *
 * Whatever does not fit is split so the conversation keeps the larger part: the
 * document gets `share` of the space, or more when the conversation needs less
 * than the rest. A share the human dragged to is used as given.
 */
export function docPaneMax(avail: number, threadNeed: number, dragged?: number): number {
  if (avail <= 0) return 0;
  if (dragged !== undefined) return Math.round(avail * clampShare(dragged));
  return Math.round(Math.max(avail * DOC_SHARE, avail - threadNeed));
}

export function clampShare(share: number): number {
  return Math.min(DOC_SHARE_MAX, Math.max(DOC_SHARE_MIN, share));
}

/** Within this many px of the end, the conversation follows new turns. */
export const FOLLOW_WITHIN = 40;

export function distanceFromEnd(el: { scrollHeight: number; scrollTop: number; clientHeight: number }): number {
  return Math.max(0, el.scrollHeight - el.scrollTop - el.clientHeight);
}
