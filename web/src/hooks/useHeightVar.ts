import { useEffect, useRef, type RefObject } from 'react';

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
 * Only the header is measured. The composer used to be a second overlay tracked
 * the same way (with a pin-to-bottom across the padding change); it is in normal
 * flow now, so the scroller ends where the composer starts and nothing has to be
 * measured for it (globals.css, "Session panel: composer").
 */
export function useHeightVar(
  hostRef: RefObject<HTMLElement | null>,
  varName: string,
) {
  const targetRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const el = targetRef.current;
    const host = hostRef.current;
    if (!el || !host) return;

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
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    // The HOST as well, not only the measured overlay: a panel revealed by its
    // container (mobile → desktop, a tab switch) is a resize of the host, and
    // relying on the overlay's own resize to notice the reveal is how a panel
    // ends up serving a measurement taken while it had no box.
    if (host !== el) ro.observe(host);
    return () => {
      ro.disconnect();
      host.style.removeProperty(varName);
    };
    // hostRef is a stable ref object; varName is constant per call site.
  }, [hostRef, varName]);

  return targetRef as RefObject<HTMLDivElement | null>;
}

/* A parent-hosted twin lived here for the home page's own `.chat-composer-overlay`,
   which P1 of "remove the main agent" deleted. Removed with it rather than kept
   unused: a second copy of this measurement is a second place to remember the
   no-box guard. */
