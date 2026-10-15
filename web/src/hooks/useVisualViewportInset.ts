/**
 * The on-screen keyboard as a CSS variable (spec 4.4). iOS Safari does not
 * shrink the layout viewport when the keyboard opens; it shrinks (and may
 * scroll) the visual viewport. The part of the layout viewport the keyboard
 * covers is written to `--wn-keyboard-inset` on <html>, and
 * `data-wn-keyboard="open" | "closed"` marks it, so full-screen layers can sit
 * on `bottom: var(--wn-keyboard-inset)`. Resize and scroll are merged into one
 * write per animation frame.
 *
 * Also: Safari pans the whole page up to reveal a focused field. With a fixed
 * top bar that pushes the bar off screen, so a focus on the phone pulls the
 * page back to the top.
 */
import { useEffect } from 'react';

/** Pure: how much of the layout viewport the keyboard covers, never negative. */
export function keyboardInset(innerHeight: number, vvHeight: number, vvOffsetTop: number): number {
  const v = Math.round(innerHeight - vvHeight - vvOffsetTop);
  return Number.isFinite(v) && v > 0 ? v : 0;
}

/** Below this many pixels a "keyboard" is a toolbar or rounding: closed. */
const KEYBOARD_OPEN_MIN_PX = 80;

function isTextEntry(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement) return true;
  if (el instanceof HTMLInputElement) {
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'file', 'color', 'image'].includes(el.type);
  }
  return false;
}

/** AppShell mounts this; it subscribes only while `enabled` (phone layout). */
export function useVisualViewportInset(enabled = true): void {
  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return undefined;
    const root = document.documentElement;
    const vv = window.visualViewport;
    let frame = 0;
    const write = () => {
      frame = 0;
      const inset = vv ? keyboardInset(window.innerHeight, vv.height, vv.offsetTop) : 0;
      root.style.setProperty('--wn-keyboard-inset', `${inset}px`);
      root.dataset.wnKeyboard = inset >= KEYBOARD_OPEN_MIN_PX ? 'open' : 'closed';
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(write); };
    write();
    vv?.addEventListener('resize', schedule);
    vv?.addEventListener('scroll', schedule);
    const onFocusIn = (ev: FocusEvent) => {
      if (!isTextEntry(ev.target)) return;
      // Safari pans after focus; check now and once its pan has happened.
      const pullBack = () => { if (window.scrollY > 0) window.scrollTo(0, 0); };
      pullBack();
      requestAnimationFrame(pullBack);
      setTimeout(pullBack, 250);
    };
    // A pan while a field holds focus (the keyboard animating in) is pulled back too.
    const onScroll = () => {
      if (window.scrollY > 0 && isTextEntry(document.activeElement)) window.scrollTo(0, 0);
    };
    document.addEventListener('focusin', onFocusIn);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      vv?.removeEventListener('resize', schedule);
      vv?.removeEventListener('scroll', schedule);
      document.removeEventListener('focusin', onFocusIn);
      window.removeEventListener('scroll', onScroll);
      root.style.removeProperty('--wn-keyboard-inset');
      delete root.dataset.wnKeyboard;
    };
  }, [enabled]);
}
