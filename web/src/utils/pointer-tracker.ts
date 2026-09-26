/**
 * The last place the pointer was, for the one question WebKit cannot answer:
 * is a card that just mounted UNDER a pointer that has not moved? WebKit sends
 * no pointerenter to an element mounted beneath a static pointer (the user
 * closes the panel with a click and the card remounts right there), and
 * `:hover` can lag the same way. A document capture listener (installed
 * lazily, once) remembers the last pointermove / pointerdown, and
 * `elementFromPoint` answers from there.
 */

export interface LastPointer { x: number; y: number; at: number }

let last: LastPointer | null = null;
let installed = false;

function record(e: PointerEvent): void {
  last = { x: e.clientX, y: e.clientY, at: Date.now() };
}

/** Install the listeners (idempotent; a no-op without a document). */
export function installPointerTracker(): void {
  if (installed || typeof document === 'undefined' || typeof document.addEventListener !== 'function') return;
  installed = true;
  const opts: AddEventListenerOptions = { capture: true, passive: true };
  document.addEventListener('pointermove', record, opts);
  document.addEventListener('pointerdown', record, opts);
}

/** The last recorded pointer position (null before the first move). */
export function getLastPointer(): LastPointer | null {
  installPointerTracker();
  return last;
}

/** Is the pointer over this element? `:hover` first, then the last position (the WebKit fallback). */
export function isPointerOver(el: Element | null | undefined): boolean {
  if (!el) return false;
  installPointerTracker();
  try { if (el.matches(':hover')) return true; } catch { /* selector unsupported */ }
  if (!last || typeof document.elementFromPoint !== 'function') return false;
  const hit = document.elementFromPoint(last.x, last.y);
  return !!hit && (hit === el || el.contains(hit));
}

/** Test hook. */
export function __resetPointerTrackerForTests(): void {
  if (installed && typeof document !== 'undefined') {
    document.removeEventListener('pointermove', record, true);
    document.removeEventListener('pointerdown', record, true);
  }
  installed = false;
  last = null;
}
