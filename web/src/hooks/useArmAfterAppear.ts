/**
 * Buttons never move under a thumb (spec 4.2 "arm-after-appear", C31, C60).
 *
 * Parallel tool calls queue two prompts: answering the first collapses its
 * card, the second card's Allow slides into the spot just tapped, and a quick
 * double tap approves a command nobody read. So a prompt's buttons ignore
 * taps for `ms` after the card appears AND after it moves (its position in
 * the timeline's content, not on screen: scrolling to a card does not re-arm
 * it). While unarmed the card reads as such (opacity 0.6) and its buttons are
 * disabled; the capture guard also swallows a tap that lands in the frame
 * before React has drawn the disabled state.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';

export const ARM_AFTER_APPEAR_MS = 500;

/** The element's top inside its scroll box (scroll-invariant). */
export function contentTop(el: HTMLElement): number {
  const box = el.closest<HTMLElement>('.session-history, .notification-panel-body, [data-arm-scroll-root]');
  const r = el.getBoundingClientRect();
  if (!box) return r.top + window.scrollY;
  return r.top - box.getBoundingClientRect().top + box.scrollTop;
}

export interface ArmState<T extends HTMLElement> {
  ref: (el: T | null) => void;
  /** false during the arm window: render the buttons disabled. */
  armed: boolean;
  /** Put on the card root as onClickCapture. */
  guard: (e: MouseEvent) => void;
}

export function useArmAfterAppear<T extends HTMLElement = HTMLElement>(ms = ARM_AFTER_APPEAR_MS, enabled = true): ArmState<T> {
  const [el, setEl] = useState<T | null>(null);
  const until = useRef(0);
  const [armed, setArmed] = useState(!enabled);
  const ref = useCallback((node: T | null) => setEl(node), []);

  useLayoutEffect(() => {
    if (!enabled) { until.current = 0; setArmed(true); return undefined; }
    if (!el) return undefined;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let lastTop = contentTop(el);
    const arm = () => {
      until.current = performance.now() + ms;
      setArmed(false);
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; setArmed(true); }, ms);
    };
    const check = () => {
      if (!el.isConnected) return;
      const t = contentTop(el);
      if (Math.abs(t - lastTop) > 1) { lastTop = t; arm(); }
    };
    arm();
    // A sibling collapsing above resizes the parent in the same frame (the
    // observer runs after layout, before paint); the poll is the backstop.
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(check) : null;
    if (ro) {
      ro.observe(el);
      if (el.parentElement) ro.observe(el.parentElement);
      const box = el.closest<HTMLElement>('.session-history');
      if (box?.firstElementChild instanceof HTMLElement) ro.observe(box.firstElementChild);
    }
    const poll = setInterval(check, 100);
    return () => {
      if (timer) clearTimeout(timer);
      clearInterval(poll);
      ro?.disconnect();
    };
  }, [el, ms, enabled]);

  const guard = useCallback((e: MouseEvent) => {
    if (performance.now() >= until.current) return;
    const target = e.target as HTMLElement | null;
    if (!target?.closest('button, [role="button"], input[type="checkbox"], input[type="radio"]')) return;
    // Reading controls (Show all) answer nothing, so they work at once.
    if (target.closest('[data-arm-exempt]')) return;
    e.preventDefault();
    e.stopPropagation();
  }, []);

  return { ref, armed, guard };
}

/**
 * A settled prompt holds its height for `ms` before it collapses to its result
 * line (spec 4.2), so nothing below it moves under the finger that answered
 * it. Reduced motion collapses at once (the arm rule still covers the card
 * that moves). Returns true while the card should still draw its pending face.
 */
export function useHoldSettled(settled: boolean, ms = 300, enabled = true): boolean {
  // Previous value in state, not a ref: the StrictMode double render must see
  // the same transition (React's "adjust state while rendering" pattern).
  const [prev, setPrev] = useState(settled);
  const [holdUntil, setHoldUntil] = useState(0);
  if (prev !== settled) {
    setPrev(settled);
    const reduced = typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setHoldUntil(settled && enabled && !reduced ? performance.now() + ms : 0);
  }
  useEffect(() => {
    if (!holdUntil) return undefined;
    const t = setTimeout(() => setHoldUntil(0), Math.max(0, holdUntil - performance.now()));
    return () => clearTimeout(t);
  }, [holdUntil]);
  return settled && holdUntil > 0;
}

/** Re-render once a deadline passes (small helper for "after 5 s" copy). */
export function useAfter(ms: number, active: boolean): boolean {
  const [passed, setPassed] = useState(false);
  useEffect(() => {
    setPassed(false);
    if (!active) return undefined;
    const t = setTimeout(() => setPassed(true), ms);
    return () => clearTimeout(t);
  }, [ms, active]);
  return passed && active;
}
