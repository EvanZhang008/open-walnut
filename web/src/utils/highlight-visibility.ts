/**
 * WebKit (Safari, the Mac app's window) paints a Highlight whose words sit under
 * `visibility: hidden` onto the next words it does render: measured 2026-11-03 in
 * WebKit 26, a question mark on a heading of a Home chat painted its green fill
 * and underline on the title of whatever page was open, because Home stays
 * mounted under `.main-page-wrapper-hidden` (visibility: hidden, height 0) off its
 * route. The user saw page and plugin titles "highlighted and underlined".
 * Chromium paints nothing there. `display: none` and `content-visibility: auto`
 * do not paint across.
 *
 * So the registry patch (highlight-repaint.ts) registers only the ranges whose
 * words are not hidden that way, keeps the painter's own Highlight as what
 * `get` answers, and re-checks every name when something that hides a painted
 * surface turns (refreshHighlightVisibility). tests/web/highlight-visibility-guard.test.ts
 * lists every `visibility: hidden` in the app and whether it can hide painted words.
 */

interface RangeLike { startContainer: Node; endContainer: Node }
interface HighlightLike {
  forEach(cb: (r: RangeLike) => void): void;
  size: number;
  priority?: number;
  type?: string;
}
type CheckVisibility = (opts?: { visibilityProperty?: boolean }) => boolean;

function elementOf(node: Node | null | undefined): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? node as Element : node.parentElement;
}

/** Words under `visibility: hidden` (laid out, not drawn): the case WebKit paints
 *  across. Hidden by `display: none` or not checkable reads as shown: nothing
 *  paints there, and a mark must never go missing on an engine without the API. */
export function hiddenByVisibility(el: Element | null, seen?: Map<Element, boolean>): boolean {
  if (!el || !el.isConnected) return false;
  const known = seen?.get(el);
  if (known !== undefined) return known;
  const check = (el as Element & { checkVisibility?: CheckVisibility }).checkVisibility;
  const hidden = typeof check === 'function'
    && check.call(el)
    && !check.call(el, { visibilityProperty: true });
  seen?.set(el, hidden);
  return hidden;
}

function isHighlight(value: unknown): value is HighlightLike {
  const h = value as Partial<HighlightLike> | null;
  return !!h && typeof h === 'object' && typeof h.forEach === 'function' && typeof h.size === 'number';
}

/**
 * The Highlight to register for `value`: itself when every range's words are
 * drawn, else a copy (same priority and type) without the hidden ones. Anything
 * that is not a Highlight is returned as it is.
 */
export function visibleHighlight<T>(value: T): T {
  if (!isHighlight(value) || value.size === 0) return value;
  const seen = new Map<Element, boolean>();
  const kept: RangeLike[] = [];
  let dropped = false;
  value.forEach((r) => {
    if (hiddenByVisibility(elementOf(r.startContainer), seen) || hiddenByVisibility(elementOf(r.endContainer), seen)) dropped = true;
    else kept.push(r);
  });
  if (!dropped) return value;
  const Ctor = (value as { constructor: new (...r: RangeLike[]) => HighlightLike }).constructor;
  const copy = new Ctor(...kept);
  if (typeof value.priority === 'number') copy.priority = value.priority;
  if (value.type) copy.type = value.type;
  return copy as unknown as T;
}

/** Same ranges, same order (a refresh that changes nothing re-registers nothing). */
export function sameRanges(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!isHighlight(a) || !isHighlight(b) || a.size !== b.size) return false;
  const left: RangeLike[] = [];
  a.forEach((r) => left.push(r));
  let i = 0;
  let same = true;
  b.forEach((r) => { if (r !== left[i++]) same = false; });
  return same;
}

type Refresher = () => void;
const REFRESH = Symbol.for('walnut.highlightVisibilityRefresh');
// Weakly, so a closed preview frame's registry (and every range it held) goes with it.
const targets = new Set<WeakRef<object>>();

/** highlight-repaint.ts: one refresher per patched registry. */
export function registerVisibilityRefresher(target: object, refresh: Refresher): void {
  (target as { [REFRESH]?: Refresher })[REFRESH] = refresh;
  targets.add(new WeakRef(target));
}

/**
 * Re-check every registered highlight against what is hidden now. Call it right
 * after a surface that holds painted words is hidden or shown again by
 * `visibility` (Home leaving its route, a board peek over the chat).
 */
export function refreshHighlightVisibility(): void {
  for (const ref of [...targets]) {
    const target = ref.deref() as { [REFRESH]?: Refresher } | undefined;
    if (!target) { targets.delete(ref); continue; }
    target[REFRESH]?.();
  }
}
