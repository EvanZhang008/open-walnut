/**
 * A press keeps the control it began on (SettingsButton, ToggleSwitch).
 *
 * The browser clicks an element only when both the press and the release land on it. Settings
 * rows change height on their own: a receipt's few seconds run out ("Checked just now: same
 * result"), a reading arrives. When that happens between the press and the release, the control
 * moves out from under a pointer that never moved, the release lands on whatever took its place,
 * and nothing happens (2026-11-05, Remote Hosts in WebKit: Revoke sent nothing; the row above lost
 * its receipt line in that moment and everything below moved up a line).
 *
 * So a press that began on the control and was released where it began (the pointer moved at
 * most SLOP_PX) is that control's click, wherever the control went meanwhile. A pointer that moved
 * away still cancels, as it always has; a release on the control itself gets the browser's own
 * click; keys and screen readers never come here.
 */

/** How far the pointer may move between press and release and still be a press. */
export const SLOP_PX = 6;
/** A press held longer is no click of ours (and a release the page never saw ends here too). */
export const PRESS_MAX_MS = 15_000;

/** The decision, pure: whether a release that did not land on the control is its click. */
export function releaseIsPress(press: { x: number; y: number }, release: { x: number; y: number; onControl: boolean }): boolean {
  if (release.onControl) return false;
  return Math.abs(release.x - press.x) <= SLOP_PX && Math.abs(release.y - press.y) <= SLOP_PX;
}

/** Controls whose press is being kept (one watch per press, however many handlers asked). */
const keeping = new WeakSet<HTMLElement>();

/** Call from the control's pointerdown. */
export function keepPress(el: HTMLElement, e: { button: number; isPrimary: boolean; clientX: number; clientY: number; pointerId: number }): void {
  if (e.button !== 0 || !e.isPrimary) return;
  if (keeping.has(el)) return;
  keeping.add(el);
  const press = { x: e.clientX, y: e.clientY };
  const id = e.pointerId;
  const end = () => {
    keeping.delete(el);
    window.clearTimeout(timer);
    document.removeEventListener('pointerup', up, true);
    document.removeEventListener('pointercancel', cancel, true);
    document.removeEventListener('pointerdown', end, true);
    window.removeEventListener('blur', end);
  };
  const cancel = (c: PointerEvent) => { if (c.pointerId === id) end(); };
  const up = (u: PointerEvent) => {
    if (u.pointerId !== id) return;
    end();
    const onControl = u.target instanceof Node && el.contains(u.target);
    if (!releaseIsPress(press, { x: u.clientX, y: u.clientY, onControl })) return;
    // After the browser's own click (it goes to what both landed on, never this control).
    window.setTimeout(() => {
      if (!el.isConnected || (el as HTMLButtonElement).disabled) return;
      el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, detail: 1, view: window, clientX: u.clientX, clientY: u.clientY }));
    }, 0);
  };
  // The press ends with its release, a cancel, the next press (its release went elsewhere: outside
  // the window), the window losing focus, or PRESS_MAX_MS: a release much later is no click.
  const timer = window.setTimeout(end, PRESS_MAX_MS);
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', cancel, true);
  document.addEventListener('pointerdown', end, true);
  window.addEventListener('blur', end);
}
