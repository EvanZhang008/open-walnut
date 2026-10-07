/**
 * Hit testing for question marks (spec 5.4). A CSS Custom Highlight cannot be
 * hit-tested and takes no `cursor`, so the timeline maps the pointer to a text
 * position (caretPositionFromPoint in Chromium, caretRangeFromPoint in WebKit)
 * and asks each mark's Range whether it holds that position. The point must
 * also sit inside one of the Range's line boxes: a caret snaps to the nearest
 * character, so a point in the empty run after a line would otherwise "hit" the
 * mark that ends there.
 */

export interface CaretPoint {
  node: Node;
  offset: number;
}

type CaretDoc = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** The text position under a viewport point, in whichever form the engine offers. */
export function caretFromPoint(doc: Document, x: number, y: number): CaretPoint | null {
  const d = doc as CaretDoc;
  try {
    if (typeof d.caretPositionFromPoint === 'function') {
      const p = d.caretPositionFromPoint(x, y);
      if (p?.offsetNode) return { node: p.offsetNode, offset: p.offset };
    }
    if (typeof d.caretRangeFromPoint === 'function') {
      const r = d.caretRangeFromPoint(x, y);
      if (r) return { node: r.startContainer, offset: r.startOffset };
    }
  } catch { /* a detached node mid-render: no hit this frame */ }
  return null;
}

export interface RectLike {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

/** Is the point inside any of these boxes (with a pixel of slop)? */
export function pointInRects(rects: ArrayLike<RectLike>, x: number, y: number, slop = 1): boolean {
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    if (x >= r.left - slop && x <= r.right + slop && y >= r.top - slop && y <= r.bottom + slop) return true;
  }
  return false;
}

export interface MarkRangeLike {
  isPointInRange: (node: Node, offset: number) => boolean;
  getClientRects: () => ArrayLike<RectLike>;
}

export interface ThreadMark<R extends MarkRangeLike = Range> {
  /** Thread key the mark opens. */
  key: string;
  /** The question's head row id, for logs (the key carries the quote). */
  headId?: string;
  range: R;
  hue: number;
  resolved: boolean;
  title: string;
  /** One neutral paint (Conversation Mode), see markHighlightName. */
  neutral?: boolean;
  /** Its answer is coming in: the scanning line instead of the underline. */
  live?: boolean;
}

/** The mark under the pointer, or null. First match wins (marks never overlap:
 *  one passage, one question). */
export function hitMark<R extends MarkRangeLike>(
  marks: readonly ThreadMark<R>[],
  caret: CaretPoint | null,
  x: number,
  y: number,
): ThreadMark<R> | null {
  if (!caret || marks.length === 0) return null;
  for (const mark of marks) {
    let inside = false;
    try { inside = mark.range.isPointInRange(caret.node, caret.offset); } catch { inside = false; }
    if (inside && pointInRects(mark.range.getClientRects(), x, y)) return mark;
  }
  return null;
}

/** A click opens a mark only with nothing selected: a selection belongs to
 *  Pin / Ask. */
export function selectionIsEmpty(sel: Pick<Selection, 'isCollapsed' | 'toString'> | null | undefined): boolean {
  if (!sel) return true;
  return sel.isCollapsed || sel.toString() === '';
}

/** At most one call per animation frame, with the newest argument. */
export function rafThrottle<A>(
  fn: (arg: A) => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
): { call: (arg: A) => void; cancel: () => void } {
  let pending: { arg: A } | null = null;
  let id: number | null = null;
  return {
    call(arg: A) {
      pending = { arg };
      if (id !== null) return;
      id = raf(() => {
        id = null;
        const p = pending;
        pending = null;
        if (p) fn(p.arg);
      });
    },
    cancel() {
      if (id !== null) caf(id);
      id = null;
      pending = null;
    },
  };
}

/**
 * Press arbitration between a question mark and a pin popover on the same
 * passage (N38, spec 5.4: the hit test prefers the question mark). The marks
 * listen in the capture phase on the timeline, the popover on the document in
 * the bubble phase, so the mark sees the press first and CLAIMS it; the popover
 * then leaves a claimed press alone instead of opening over the new page.
 * A WeakSet, not stopPropagation: other pointerup listeners (drag sensors,
 * selection bars) must still see the event.
 */
const claimedPresses = new WeakSet<Event>();

export function claimPress(e: Event): void {
  claimedPresses.add(e);
}

export function isPressClaimed(e: Event): boolean {
  return claimedPresses.has(e);
}
