/**
 * Keyboard focus marks that WebKit (the Mac app) needs: it never matches
 * `:focus-visible` on a programmatic `el.focus()`, so a ring that must show
 * after a keyboard action (the drawer cursor row, the toggle after an Esc
 * close) is driven by a data attribute instead.
 */

const MODIFIER_KEYS = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Fn']);

/** A bare modifier press is not navigation (Cmd alone must not arm the ring). */
export function isModifierOnly(key: string): boolean {
  return MODIFIER_KEYS.has(key);
}

/** Show the keyboard ring on `el` until it loses focus. */
export function markKeyboardFocus(el: HTMLElement): void {
  el.dataset.kbFocus = 'true';
  const clear = () => {
    delete el.dataset.kbFocus;
    el.removeEventListener('blur', clear);
    el.removeEventListener('pointerdown', clear);
  };
  el.addEventListener('blur', clear);
  el.addEventListener('pointerdown', clear);
}
