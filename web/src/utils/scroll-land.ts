/**
 * Land on a deep-linked row (Open Settings from a host row, N3-2): scroll its
 * nearest scroll container so the row's top sits in the upper part of the
 * pane, keep it there while the page above it is still laying out (sections
 * load after the route change and push the row down), then move focus to it.
 * Any user scroll input stops the correction at once.
 *
 * The hold is a fixed window, not "until the page looks still": on a busy
 * machine a section above can arrive seconds after an apparently quiet pane,
 * and a quiet-detector stopped before it (the row ended below the fold).
 */

/** Where the row's top lands, as a fraction of the container's height. */
export const LAND_FRACTION = 0.2;
/** How long the landing keeps correcting for late layout (user input ends it sooner). */
export const LAND_SETTLE_MS = 8_000;

/** The scroll offset that puts a row whose top is `rowTop` (container-relative) at `fraction` of `viewH`. */
export function landingScrollTop(current: number, rowTop: number, viewH: number, maxScroll: number, fraction = LAND_FRACTION): number {
  const want = current + rowTop - Math.round(viewH * fraction);
  return Math.max(0, Math.min(maxScroll, Math.round(want)));
}

/** The nearest ancestor that scrolls vertically (else the document's scroller). */
export function scrollParentOf(el: HTMLElement): HTMLElement {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const oy = getComputedStyle(p).overflowY;
    if ((oy === 'auto' || oy === 'scroll' || oy === 'overlay') && p.scrollHeight > p.clientHeight + 1) return p;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/** Scroll `el` into the upper part of its pane, hold it there through late layout, focus it. Returns a cancel. */
export function landOnRow(el: HTMLElement, opts: { focus?: boolean; settleMs?: number } = {}): () => void {
  const { focus = true, settleMs = LAND_SETTLE_MS } = opts;
  let done = false;
  let raf = 0;
  const started = performance.now();
  let lastTop = Number.NaN;
  let lastSc: HTMLElement | null = null;
  let lastH = 0;
  const place = () => {
    // Cheap frame: the row has not moved and its pane has not grown (a clamped scroll may fit now).
    const at = el.getBoundingClientRect().top;
    if (at === lastTop && lastSc && lastSc.scrollHeight === lastH) return;
    const sc = scrollParentOf(el);
    const isDoc = sc === document.scrollingElement || sc === document.documentElement;
    const top = isDoc ? 0 : sc.getBoundingClientRect().top;
    const viewH = isDoc ? window.innerHeight : sc.clientHeight;
    const rowTop = el.getBoundingClientRect().top - top;
    const next = landingScrollTop(sc.scrollTop, rowTop, viewH, sc.scrollHeight - sc.clientHeight);
    if (Math.abs(next - sc.scrollTop) > 1) sc.scrollTop = next;
    lastTop = el.getBoundingClientRect().top;
    lastSc = sc;
    lastH = sc.scrollHeight;
  };
  const stop = () => {
    if (done) return;
    done = true;
    cancelAnimationFrame(raf);
    for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.removeEventListener(t, stop, true);
  };
  for (const t of ['wheel', 'touchstart', 'keydown', 'pointerdown'] as const) window.addEventListener(t, stop, { capture: true, passive: true });
  const tick = () => {
    if (done || !el.isConnected) { stop(); return; }
    place();
    if (performance.now() - started >= settleMs) { stop(); return; }
    raf = requestAnimationFrame(tick);
  };
  place();
  if (focus) {
    if (!el.hasAttribute('tabindex')) el.setAttribute('tabindex', '-1');
    el.focus({ preventScroll: true });
  }
  raf = requestAnimationFrame(tick);
  return stop;
}
