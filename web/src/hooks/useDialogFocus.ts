/**
 * A modal panel's keyboard contract (the notification panel, N5): on open,
 * focus moves into the panel (the panel itself, so the next Tab reaches its
 * first control: the header, then the attention card, then the rail); Tab
 * and Shift+Tab stay inside while it is open; on close, focus goes back to
 * whatever had it before (the bell). Another layer that owns focus (a reader
 * portal) is left alone: the trap acts only while focus is in the panel or lost.
 */
import { useEffect, useRef } from 'react';

const FOCUSABLE = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** The panel's Tab stops in DOM order, visible ones only. */
export function tabStops(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE))
    .filter((el) => el.getClientRects().length > 0 && !el.closest('[inert], [aria-hidden="true"]'));
}

/** Where a Tab from `current` goes to stay inside (null: the browser's own next stop is inside already). */
export function wrapTarget(stops: readonly HTMLElement[], current: Element | null, back: boolean): HTMLElement | null {
  if (!stops.length) return null;
  const i = stops.indexOf(current as HTMLElement);
  if (i < 0) return back ? stops[stops.length - 1] : stops[0];
  if (back && i === 0) return stops[stops.length - 1];
  if (!back && i === stops.length - 1) return stops[0];
  return null;
}

/**
 * Where a Tab from `current` goes: the next (or previous) stop, wrapping at
 * the ends. The trap moves focus on EVERY Tab, not only at the ends: WebKit
 * (the Mac app) skips buttons in its own Tab order unless they carry an
 * explicit tabindex, so leaving the middle to the browser jumped over the
 * rail (C25) without adding tabIndex to every button.
 */
export function nextTabStop(stops: readonly HTMLElement[], current: Element | null, back: boolean): HTMLElement | null {
  if (!stops.length) return null;
  const i = stops.indexOf(current as HTMLElement);
  if (i < 0) {
    // Focus on something that is not a stop (the panel itself): the first stop after it in DOM order.
    const after = current ? stops.find((s) => current.compareDocumentPosition(s) & Node.DOCUMENT_POSITION_FOLLOWING) : undefined;
    if (!back) return after ?? stops[0];
    const idx = after ? stops.indexOf(after) : stops.length;
    return stops[(idx - 1 + stops.length) % stops.length];
  }
  return stops[(i + (back ? -1 : 1) + stops.length) % stops.length];
}

/**
 * The dialog contract on `panel` while it is in the DOM: role=dialog +
 * aria-modal + its label, focus moved in on open, every Tab kept inside, focus
 * back to what had it (the bell) when it goes. Applied from the attention
 * card's mount inside the notification panel (the panel's own file stays as it
 * was, C42), the same closest() pattern as the mount's click guard.
 */
export function useDialogFocus(panel: HTMLElement | null, label: string): void {
  const returnTo = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!panel) return;
    const attrs: Array<[string, string]> = [['role', 'dialog'], ['aria-modal', 'true'], ['aria-label', label], ['tabindex', '-1']];
    const before = attrs.map(([k]) => [k, panel.getAttribute(k)] as const);
    for (const [k, v] of attrs) panel.setAttribute(k, v);
    returnTo.current = document.activeElement instanceof HTMLElement && !panel.contains(document.activeElement) ? document.activeElement : null;
    // Focus in, and again over the next frames if it did not stick: the bell re-renders as the
    // card changes owner and a cold page can drop focus to <body> after the first try.
    const pullIn = (): void => {
      const a = document.activeElement;
      if (!panel.isConnected || panel.contains(a)) return;
      if (!a || a === document.body || a === returnTo.current || !a.isConnected) panel.focus({ preventScroll: true });
    };
    pullIn();
    const timers = [50, 150, 400].map((ms) => setTimeout(pullIn, ms));
    // Focus lost from inside (a focused control removed): back to the panel, as a modal does.
    const onFocusOut = (e: FocusEvent): void => {
      if (e.relatedTarget) return;
      setTimeout(() => { if (!document.activeElement || document.activeElement === document.body) pullIn(); }, 0);
    };
    panel.addEventListener('focusout', onFocusOut);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.metaKey) return;
      const active = document.activeElement;
      const inside = !!active && panel.contains(active);
      // Focus in another layer (a reader over the panel): not ours to move.
      if (!inside && active && active !== document.body) return;
      const target = nextTabStop(tabStops(panel), inside ? active : null, e.shiftKey);
      if (target) { e.preventDefault(); target.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      for (const t of timers) clearTimeout(t);
      panel.removeEventListener('focusout', onFocusOut);
      document.removeEventListener('keydown', onKey, true);
      for (const [k, v] of before) { if (v === null) panel.removeAttribute(k); else panel.setAttribute(k, v); }
      const back = returnTo.current;
      returnTo.current = null;
      // Back to the bell, unless the close moved focus somewhere on purpose (a navigation).
      if (back && back.isConnected && (!document.activeElement || document.activeElement === document.body || panel.contains(document.activeElement))) {
        back.focus({ preventScroll: true });
      }
    };
  }, [panel, label]);
}
