/**
 * A deferred "focus the first field" that never takes the caret back from a field the person already
 * went to.
 *
 * A form that focuses its first field a tick after it mounts races whoever is quicker: on a busy page
 * the timer runs late, the person (or a password manager) is already in the second field, and the
 * caret jumps back to the first one mid-word. In the Mail add-account dialog that put the app password
 * at the end of the address (`alice@example.invalidok`, a disabled Add button), and the address box is
 * kept in the draft store, which a password never is (2026-11-01).
 *
 * Only a TYPING field inside the target's nearest form or dialog counts: focus left behind on a field
 * outside it is still taken, which is what a modal is for.
 */

const NOT_TYPING_INPUTS = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'image']);

/** A control that takes typed text. */
export function isTypingField(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') return !NOT_TYPING_INPUTS.has(((el as HTMLInputElement).type || 'text').toLowerCase());
  return (el as HTMLElement).isContentEditable === true;
}

/**
 * Focus `target`, unless another typing field inside its nearest form or dialog already has focus.
 * Returns whether it focused.
 */
export function focusUnlessTyping(target: HTMLElement | null | undefined): boolean {
  if (!target || !target.isConnected) return false;
  const active = target.ownerDocument.activeElement;
  if (active && active !== target && isTypingField(active)) {
    const scope = target.closest('[role="dialog"], form');
    if (scope?.contains(active)) return false;
  }
  target.focus();
  return true;
}
