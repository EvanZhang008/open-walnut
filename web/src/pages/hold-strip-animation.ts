/**
 * Hold the session strip's auto-animate for two frames (a column swapped in place of one that
 * closes, MainPage `openSessionInPlaceOf`), then turn it back on.
 *
 * auto-animate's disable() cancels every animation in flight, and an element it is fading out
 * leaves the document only when that fade finishes: a cancelled fade never does. A column still
 * closing when the hold began (two columns completed a moment apart) stayed drawn over the strip
 * for good, see-through and with a live composer. React let go of those elements already, so
 * they are removed here; the library marks them with `__aa_del` while they fade.
 */
export const FADING_OUT_MARK = '__aa_del';

export function holdStripAnimation(setEnabled: (on: boolean) => void, container: HTMLElement | null): void {
  setEnabled(false);
  if (container) {
    for (const child of [...container.children]) if (FADING_OUT_MARK in child) child.remove();
  }
  requestAnimationFrame(() => requestAnimationFrame(() => setEnabled(true)));
}

/**
 * A closing column fades where it stood (auto-animate puts the element React let go back in the
 * strip for the fade), but an element taken out of the document and put back has lost its
 * scroll offsets: the fading column showed the top of its transcript ("Initial Prompt", "Load
 * earlier turns") over its neighbour. Read them before the close, put them back once the fade
 * has begun.
 */
export function keepScrollWhileFading(columnId: string): void {
  const column = columnElement(columnId);
  if (!column) return;
  const offsets: Array<[HTMLElement, number, number]> = [];
  for (const el of column.querySelectorAll<HTMLElement>('*')) {
    if (el.scrollTop > 0 || el.scrollLeft > 0) offsets.push([el, el.scrollTop, el.scrollLeft]);
  }
  if (offsets.length === 0) return;
  // The close commits a frame or two later (a scheduled render): put them back on each of the
  // next few frames, so the one where the fade starts is among them.
  let frames = 4;
  const restore = () => {
    if (column.isConnected) for (const [el, top, left] of offsets) { el.scrollTop = top; el.scrollLeft = left; }
    if (--frames > 0) requestAnimationFrame(restore);
  };
  requestAnimationFrame(restore);
}

/** A completion's column fades in its place this long before it leaves (`.is-closing`,
 *  styles/keyboard-shortcuts.css). */
export const COLUMN_FADE_MS = 160;

export function columnElement(columnId: string): HTMLElement | null {
  if (typeof document === 'undefined') return null;
  return document.querySelector<HTMLElement>(`.main-page-session-column[data-column-id="${CSS.escape(columnId)}"]`);
}

export function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
}

/** The ring's tick is read before the column goes (also the window in which a refused
 *  completion rolls back, so a quick refusal never costs the person a column). */
export const CLOSE_TICK_MS = 400;
