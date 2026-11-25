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

/** The element facts the key rule reads, so it runs without a DOM in the unit tests. */
export interface KeyNode { matches(selector: string): boolean }
export interface KeyRoot<T extends KeyNode> { contains(node: T | null): boolean }

/**
 * The control a key pressed in the dialog is for. A save disables its row's controls (a native
 * <fieldset disabled>) and the browser drops the focus to <body> under the user: Chromium at once,
 * WebKit a frame later. In WebKit an arrow key on a closed select is a pick, so it saves at once, and
 * the Escape that followed it landed on <body> and closed the whole dialog (2026-11-25). While the
 * focus has gone nowhere else and that control is still disabled, the key is still the control's:
 * `takenBySave` is the last control in a row that had the focus.
 */
export function keyTargetOf<T extends KeyNode>(root: KeyRoot<T>, active: T | null, takenBySave: T | null): T | null {
  if (active && root.contains(active)) return active;
  if (takenBySave && root.contains(takenBySave) && takenBySave.matches(':disabled')) return takenBySave;
  return active;
}

/** Where the focus is when a row's save finishes. */
export type FocusAtSaveEnd = 'page' | 'dialog' | 'control' | 'elsewhere';

/**
 * Whether a finished save puts the focus on its row's control. Only when the save itself took the
 * focus away: it is on the page (<body>: the save disabled the control under it) or on the dialog
 * itself (WebKit does not focus a button on click, so after a mouse toggle the root still holds it).
 * Never when he put it somewhere himself: a control in the dialog, the dialog after an Escape out
 * of a select, or anything outside the dialog (2026-11-25: the outside click that closes the dialog
 * put the caret in the composer, the save answered before the close, and the focus went back into
 * the closing dialog and fell to the page).
 */
export function refocusAfterSave(at: FocusAtSaveEnd, steppedOut: boolean): boolean {
  if (at === 'page') return true;
  if (at === 'dialog') return !steppedOut;
  return false;
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
