/**
 * How much room a scrollbar takes, measured once, published as `--wn-scrollbar-h`.
 *
 * Code blocks reserve their horizontal scrollbar track up front (`overflow-x:
 * scroll` on `.markdown-body pre`) because a track that appears LATE grows the
 * block's box after its ancestors were sized, and WebKit then paints the block
 * over the paragraph below it (2026-09-15, Mac app, narrow session column).
 *
 * Reserving is engine-adaptive on its own: an engine with overlay scrollbars
 * reserves nothing. The BOTTOM PADDING is what needs the number, so the block's
 * bottom edge reads the same everywhere:
 *
 *     padding-bottom: max(0px, calc(<design> - var(--wn-scrollbar-h)))
 *
 * The four values this returns in practice, all different, which is why it is
 * measured rather than assumed: 6px in the Mac app and Safari (globals.css styles
 * `::-webkit-scrollbar`, which turns macOS overlay scrollbars into classic ones),
 * 0px in Chrome on macOS and on iOS (overlay), ~15px on Windows/Linux, ~14px in
 * Firefox (which ignores the `::-webkit-scrollbar` rules entirely).
 *
 * Measured once at startup: the value only changes if the user flips the system
 * "Show scroll bars" setting, which does not happen mid-session, and a resize
 * listener for it would cost a layout read per resize frame.
 */

/** CSS custom property other rules read. Kept in one place so grep finds both ends. */
export const SCROLLBAR_H_VAR = '--wn-scrollbar-h';

/**
 * Height a horizontal scrollbar occupies inside a `overflow-x: scroll` box, in px.
 *
 * The probe is a plain off-screen div: `::-webkit-scrollbar` styling in
 * globals.css is global, so a div and a `<pre>` reserve the same track. It is
 * removed before returning, and reading `clientHeight`/`offsetHeight` forces
 * exactly one layout.
 */
export function measureScrollbarHeight(doc: Document = document): number {
  const probe = doc.createElement('div');
  probe.setAttribute('aria-hidden', 'true');
  probe.style.cssText = 'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;'
    + 'overflow-x:scroll;overflow-y:hidden;visibility:hidden;pointer-events:none';
  const inner = doc.createElement('div');
  inner.style.cssText = 'width:400px;height:1px';
  probe.appendChild(inner);
  (doc.body ?? doc.documentElement).appendChild(probe);
  const h = probe.offsetHeight - probe.clientHeight;
  probe.remove();
  // A negative or absurd number means the probe never laid out (detached document
  // in a test, for instance); 0 is the safe answer — it only means "no
  // compensation", never a broken layout.
  return h > 0 && h < 40 ? h : 0;
}

/** Measure and publish on `<html>`. Safe to call more than once. */
export function publishScrollbarMetrics(doc: Document = document): number {
  const h = measureScrollbarHeight(doc);
  doc.documentElement.style.setProperty(SCROLLBAR_H_VAR, `${h}px`);
  return h;
}
