/**
 * Focus and form helpers for EngineSettingsPopover, kept apart so the popover
 * file stays readable. Each one records a browser fact the popover relies on.
 */

/** Tab stops only: a control taken out of the sequence with tabindex=-1 (the unchecked scope option) is not one. */
const FOCUSABLE = 'button:not([disabled]), input:not([disabled]), select:not([disabled]), a[href], summary, [tabindex]';
const NOT_A_STOP = '[tabindex="-1"]';

export function isTextEntry(el: Element | null): el is HTMLInputElement {
  return el instanceof HTMLInputElement && (el.type === 'text' || el.type === 'number');
}

/**
 * The dialog's tab stops, in DOM order. checkVisibility, not offsetParent:
 * Chromium keeps the content of a closed <details> laid out (content-visibility),
 * so offsetParent is non-null there.
 */
export function visibleFocusable(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => !el.matches(NOT_A_STOP) && el.closest('fieldset:disabled') === null
      && (typeof el.checkVisibility === 'function' ? el.checkVisibility() : el.offsetParent !== null));
}

/** Focus is inside the dialog (the root itself counts); <body> is "nowhere". */
export function focusInside(root: HTMLElement | null): boolean {
  const active = document.activeElement;
  return !!root && !!active && active !== document.body && root.contains(active);
}

/** The committed value of the row a text or number input belongs to, as the input would show it. */
export function committedValueOf(input: HTMLInputElement, lookup: (key: string) => unknown): string | undefined {
  const key = input.closest<HTMLElement>('.engine-settings-popover-row')?.dataset.key;
  if (!key) return undefined;
  const value = lookup(key);
  return value === null || value === undefined ? '' : String(value);
}

export const QUIET_FOCUS_CLASS = 'engine-setting-quiet-focus';

/**
 * Focus moved by the program after a MOUSE action should not paint a ring
 *Chromium and WebKit draw:focus-visible on any programmatic focus of
 * a text input or select. The class hides the ring on this one control until
 * the keyboard is used (a keyboard user then sees the ring where focus is) or
 * the control loses focus.
 */
export function quietFocus(control: HTMLElement): void {
  control.classList.add(QUIET_FOCUS_CLASS);
  const done = () => {
    control.classList.remove(QUIET_FOCUS_CLASS);
    control.removeEventListener('blur', done);
    control.removeEventListener('keydown', done);
  };
  control.addEventListener('blur', done);
  control.addEventListener('keydown', done);
}
