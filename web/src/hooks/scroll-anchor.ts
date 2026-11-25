/**
 * The arithmetic of keeping a row in place, apart from the DOM so it can be pinned without a browser
 * (`useScrollAnchor` is the hook that measures and scrolls).
 */

/** Where the anchor row was, measured from the scroll box's top edge, and the box's scroll then. */
export interface AnchorMark {
  top: number;
  scrollTop: number;
}

/**
 * How far the anchor row moved IN THE CONTENT because something above it changed height, in px.
 * Positive means it was pushed down.
 *
 * A scroll since the mark is taken out first. A wheel or a key moves the box before its `scroll`
 * event is dispatched (that waits for the next frame), and a render in between would otherwise read
 * the person's own scroll as drift and scroll them back.
 */
export function anchorDrift(mark: AnchorMark, top: number, scrollTop: number): number {
  const expected = mark.top - (scrollTop - mark.scrollTop);
  return top - expected;
}

/**
 * The scroll position that puts the anchor row back where the mark saw it, or `scrollTop` itself
 * when nothing has to move.
 *
 * Normally the current position plus the drift: whatever the person scrolled since the mark stays
 * theirs. The exception is the browser's CLAMP. When the content got shorter while the box sat at
 * its end, the browser has already pulled the position up by the lost height, and that pull is part
 * of `scrollTop`. Adding the drift on top would count the same rows twice (a 28px row leaving above
 * the view at the end of the list threw every row 28px down). So at the end, after a pull, the
 * position is worked out from the mark's instead, and capped at the end.
 */
export function anchoredScrollTop(mark: AnchorMark, top: number, scrollTop: number, max: number, floor = 0): number {
  const drift = anchorDrift(mark, top, scrollTop);
  if (Math.abs(drift) < ANCHOR_SLOP_PX) return scrollTop;
  const clamped = scrollTop >= max - ANCHOR_SLOP_PX && scrollTop < mark.scrollTop;
  const target = clamped ? mark.scrollTop + drift : scrollTop + drift;
  return Math.max(floor, Math.min(max, target));
}

/**
 * Room at the top of a box, for the row being read when what stands above it got shorter than the
 * box can scroll up (2026-11-25, the Threads list: a card above left while he read near the top, and
 * no scroll could keep his card where it was). `raw` is the scroll that puts the row back, below 0
 * when no scroll can (anchoredScrollTop with no floor), with the room there is now (`slack`) counted
 * in. The room grows by what the scroll lacks, and shrinks first when something above grows again:
 * the scroll moves only once there is no room left. Pure.
 */
export function slackStep(slack: number, raw: number): { slack: number; scrollTop: number } {
  const next = Math.max(0, slack - raw);
  return { slack: next, scrollTop: raw + next - slack };
}

/** What a hold that began at the very top saw, so its end can go back there (releaseScrollTop). */
export interface ReadSession { fromTop: boolean; scrolled: boolean }

/**
 * Where the box goes when the person leaves the rows they read: back to the very top when they were
 * there as the hold began and did not scroll themselves, so what arrived above meanwhile shows (as it
 * would have, had they not been reading); else where it is, less the room kept at the top, which goes
 * with the hold, so nothing on screen moves. Pure.
 */
export function releaseScrollTop(session: ReadSession, slack: number, scrollTop: number): number {
  if (session.fromTop && !session.scrolled) return 0;
  return Math.max(0, scrollTop - slack);
}

/** What the person did that scrolls (a wheel, a key, a pointer or a touch): when last, and a pointer held down now. */
export interface ScrollInput { at: number; down: boolean }

/** The window events that step the ScrollInput (stepScrollInput). */
export const SCROLL_INPUT_EVENTS = ['wheel', 'keydown', 'pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'dragend', 'touchstart', 'touchmove'] as const;

/** Keys that move a text field's caret by lines or pages, which can scroll the box around it. */
const SCROLLING_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * The person's scroll input after one event at `now`. A wheel, a key, a press or a touch scrolls, so
 * its time is stamped; a pointer move scrolls nothing, and neither does a letter typed in a text field
 * (`inField`; 2026-11-25: a word typed in a card's Follow up box counted as his scroll, and WebKit's
 * pull at the end of the list stayed in, 376px). A press holds the pointer down until it goes up or
 * is cancelled, and also until a native drag ends, the pointer moves with no button pressed, or a
 * wheel or a key comes: a press with no release (a ctrl-click's context menu, a native drag on macOS)
 * left it down, and the engine's pull was never taken out again until his next click (2026-11-25, a
 * review). Pure; an event that changes nothing returns `input` itself.
 */
export function stepScrollInput(input: ScrollInput, e: { type: string; buttons?: number; key?: string; inField?: boolean }, now: number): ScrollInput {
  const up = input.down ? { ...input, down: false } : input;
  switch (e.type) {
    case 'pointerdown': return { at: now, down: true };
    case 'pointerup': case 'pointercancel': case 'dragend': return up;
    case 'pointermove': return e.buttons ? input : up;
    case 'keydown': return e.inField && !SCROLLING_KEYS.has(e.key ?? '') ? up : { at: now, down: false };
    case 'wheel': return { at: now, down: false };
    default: return { ...input, at: now };
  }
}

/**
 * How far the engine pulled the box up during one commit (px, 0 for none): the mark sat at the end of
 * the range (`atEnd`, taken at `at`), the box is higher now than as the commit's render began
 * (`before`), and no input that scrolls came since the mark. WebKit pulls a box at its end up by the
 * height of a row moved in the DOM above the view (out, then in again: a reorder, a row going to
 * another group) and never gives it back; the hook would read that as the person's own scroll
 * (2026-11-25, the Threads list: leaving it let its order follow again, and every card on screen
 * moved 386px). A scroll the page made before the render is in `before`, so it is never undone. Pure.
 */
export function enginePull(mark: { atEnd?: boolean; at?: number }, before: number | null, scrollTop: number, input: ScrollInput): number {
  if (!mark.atEnd || before === null || input.down || input.at > (mark.at ?? 0)) return 0;
  const pull = before - scrollTop;
  return pull > ANCHOR_SLOP_PX ? pull : 0;
}

/**
 * Where the row being read stands for the next correction: the first of `places` still there (`ok`)
 * and measured when the row was picked (`top`). The hook passes the row itself (there and in its
 * order), then the row drawn right before it, then the one right after it: a row that left its place
 * (a card he answers goes to another group and is drawn again there) leaves its neighbour to hold
 * the place he read, where holding nothing moved every card he saw by its new height (2026-11-25, a
 * review: 186px). The row before it first: nothing above the pointer moves, and what was below closes
 * up under its line (holding the row after a tall card pushed the rows above it down, with room at
 * the top). Null when none is: a row is picked afresh. Pure.
 */
export function heldPlace<T>(places: ReadonlyArray<{ el: T | null; top?: number; ok: boolean }>): { el: T; top: number } | null {
  for (const p of places) if (p.el && p.ok && p.top !== undefined) return { el: p.el, top: p.top };
  return null;
}

/**
 * Whether `el` is the box itself or holds rows: a container, never the row being read. Its own top
 * does not move when rows come and go inside it, so holding it would hold nothing (2026-11-25, the
 * Threads list: the list itself held, a new card above pushed every card on screen). Pure.
 */
export function holdsRows(box: Pick<Element, 'querySelector'>, rows: string, el: Pick<Element, 'querySelector'>): boolean {
  return el === box || el.querySelector(rows) !== null;
}

/** Under half a pixel is subpixel layout, not a move: correcting it would fight rounding forever. */
export const ANCHOR_SLOP_PX = 0.5;

/**
 * A scroll box another keeper holds for a moment carries this attribute (a fold toggle, which
 * `useFoldAnchor` keeps in place by its clicked row), and `useScrollAnchor` leaves the box to it:
 * two keepers correcting one move undo each other, and the fold's keeper lets go of any scroll it
 * did not make. The keeper dispatches `SCROLL_RELEASED_EVENT` on the box when it lets go.
 */
export const SCROLL_HELD_ATTR = 'data-scroll-held';
export const SCROLL_RELEASED_EVENT = 'walnut-scroll-released';
/**
 * Dispatched on the box by an owner whose `reading` row changed with no scroll and no commit (the
 * pointer went to another row, the focus came in): `useScrollAnchor` picks its row again now, so the
 * next change above is measured against the row being read.
 */
export const SCROLL_REPICK_EVENT = 'walnut-scroll-repick';
