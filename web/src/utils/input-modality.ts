/**
 * Which kind of input moved focus last: `touch` (a finger or a mouse press) or
 * `keyboard`. The phone stylesheet hides focus rings while it is `touch`
 * (nitpick N24): the drawer moves focus on open and back to Menu on close for
 * accessibility, and WebKit draws that programmatic focus as a keyboard ring,
 * which a native app never shows to a finger. Written to
 * `<html data-wn-input>`, read only by CSS.
 */
export type InputModality = 'touch' | 'keyboard';

/** The modality an event implies, or null when it says nothing (a modifier alone). */
export function modalityOf(e: { type: string; key?: string }): InputModality | null {
  if (e.type === 'pointerdown' || e.type === 'touchstart' || e.type === 'mousedown') return 'touch';
  if (e.type === 'keydown') {
    // Tab, arrows and Enter move or use focus; a lone modifier does not.
    if (!e.key || ['Shift', 'Control', 'Alt', 'Meta', 'CapsLock'].includes(e.key)) return null;
    return 'keyboard';
  }
  return null;
}

let installed = false;

export function installInputModality(doc: Document = document): void {
  if (installed || typeof doc === 'undefined') return;
  installed = true;
  const set = (e: Event) => {
    const m = modalityOf(e as KeyboardEvent);
    if (m && doc.documentElement.dataset.wnInput !== m) doc.documentElement.dataset.wnInput = m;
  };
  for (const t of ['pointerdown', 'touchstart', 'mousedown', 'keydown']) {
    doc.addEventListener(t, set, { capture: true, passive: true });
  }
}
