import { useLayoutEffect, useRef, type RefObject } from 'react';

/**
 * Track an overlay element's height into a CSS custom property on a host
 * element, the mechanism behind the G4 liquid-glass header: the glass header
 * is absolutely positioned OVER the scroll area, and the scroll container pads
 * its top by `var(--x-h)` so content starts clear of the glass while still
 * scrolling UNDER it.
 *
 * Returns a ref to attach to the measured overlay element. Every resize
 * (chip-row wrap, title growth) writes `${varName}: <offsetHeight>px` onto the
 * host element.
 *
 * The session panel measures two: its header (`--sp-header-h`) and its composer
 * (`--sp-composer-h`, session-scroll-glass.css: with the chat_glass_edges
 * experiment on, the transcript runs on under the composer's glass and pads its
 * end by this height). A caller that already holds a ref to the measured element
 * passes it as `existing`, so one element keeps one ref object; `enabled: false`
 * measures nothing and leaves the property unset.
 */
export function useHeightVar(
  hostRef: RefObject<HTMLElement | null>,
  varName: string,
  existing?: RefObject<HTMLElement | null>,
  enabled = true,
) {
  const ownRef = useRef<HTMLElement | null>(null);
  const targetRef = existing ?? ownRef;

  // Layout effect: the first measurement lands before the first paint. As a
  // plain effect, a new panel painted one frame with the CSS fallback padding
  // and then moved every row by the difference (~10px), which read as the first
  // message jumping as the column opened.
  useLayoutEffect(() => {
    const el = targetRef.current;
    const host = hostRef.current;
    if (!el || !host || !enabled) return;

    const apply = () => {
      // An element with NO BOX measures 0: a session column the mobile layout
      // hides, a panel inside a display:none tab, anything mounted before its
      // container is shown. Writing that 0 is worse than writing nothing — the
      // scroller then pads by ~0 and the overlay covers the rows under it, with
      // no scroll position that can bring them out. Drop the property instead,
      // so the CSS fallback (a real header's height) is what applies until the
      // box is back, and re-measure then.
      if (el.offsetHeight === 0 && el.getClientRects().length === 0) {
        host.style.removeProperty(varName);
        return;
      }
      const next = `${el.offsetHeight}px`;
      if (host.style.getPropertyValue(varName) === next) return;
      host.style.setProperty(varName, next);
    };

    apply();
    // A resize is written on the next frame, never inside the observer's callback: the property
    // pads the transcript beside the measured element, and a box outside what this observer
    // watches changing inside its callback is what WebKit reports as 'ResizeObserver loop
    // completed with undelivered notifications' (2026-11-23: 43 in a day in the Mac app, each as
    // a message was sent and the glass composer shrank; as useTitleRowTight.ts).
    let frame = 0;
    const ro = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { frame = 0; apply(); });
    });
    ro.observe(el);
    // The HOST as well, not only the measured overlay: a panel revealed by its
    // container (mobile → desktop, a tab switch) is a resize of the host, and
    // relying on the overlay's own resize to notice the reveal is how a panel
    // ends up serving a measurement taken while it had no box.
    if (host !== el) ro.observe(host);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(frame);
      host.style.removeProperty(varName);
    };
    // hostRef and targetRef are stable ref objects; varName is constant per call site.
  }, [hostRef, varName, targetRef, enabled]);

  return targetRef as RefObject<HTMLDivElement | null>;
}

/* A parent-hosted twin lived here for the home page's own `.chat-composer-overlay`,
   which P1 of "remove the main agent" deleted. Removed with it rather than kept
   unused: a second copy of this measurement is a second place to remember the
   no-box guard. */
