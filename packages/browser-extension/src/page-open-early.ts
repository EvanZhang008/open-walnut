/**
 * Runs in every page's own world before its scripts (a manifest content script, Chrome): a click
 * and a submit capture listener on the window, first of all its listeners, that hand the event to
 * Walnut's hook when one is set. The hook is set only in an agent's own tab, by the step's patch
 * (agent-popups-page.ts), so there:
 *   - a page's own listener that stops a click or a submit early never lets a link or a form past;
 *   - a frame not wrapped yet hands its clicks and submits to its same-site parent's hook.
 * Nothing else is touched: in the person's own pages no hook is ever set, and no function of the
 * page is replaced (a wrapped window.open on every page reads as changed to a site's bot check,
 * from another frame's Function.prototype.toString: review 2026-11-20).
 */
const EVENTS = Symbol.for('walnut.page-events')
const w = window as unknown as Window & Record<symbol, unknown>
/** This window's hook, else a same-site parent's. */
const hookOf = (s: symbol): ((e: Event) => void) | undefined => {
  let x: Window = w
  for (let i = 0; i < 32; i++) {
    try { const h = (x as unknown as Record<symbol, unknown>)[s]; if (typeof h === 'function') return h as (e: Event) => void } catch { return undefined }
    if (x.parent === x) return undefined
    x = x.parent
  }
  return undefined
}
for (const type of ['click', 'auxclick', 'submit']) w.addEventListener(type, (e) => { hookOf(EVENTS)?.(e) }, true)
