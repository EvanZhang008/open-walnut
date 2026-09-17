import { useEffect, useRef, type RefObject } from 'react';

/**
 * Track an overlay element's height into a CSS custom property on a host
 * element — the mechanism behind the G4 liquid-glass overlays: the glass
 * header/composer are absolutely positioned OVER the scroll area, and the
 * scroll container pads itself by `var(--x-h)` so content starts clear of the
 * glass while still scrolling UNDER it.
 *
 * Returns a ref to attach to the measured overlay element. Every resize
 * (textarea autogrow, image previews, queue indicator, chips row wrap) writes
 * `${varName}: <offsetHeight>px` onto the host element.
 *
 * `pinScrollSelector` (optional): a scroll container inside the host to keep
 * pinned to the bottom across the padding change — growing the composer grows
 * the scroller's padding-bottom, which would otherwise leave the last lines
 * hidden behind the glass until the next auto-scroll tick.
 */
export function useHeightVar(
  hostRef: RefObject<HTMLElement | null>,
  varName: string,
  pinScrollSelector?: string,
) {
  const targetRef = useRef<HTMLElement | null>(null);
  const pinRef = useRef(pinScrollSelector);
  pinRef.current = pinScrollSelector;

  useEffect(() => {
    const el = targetRef.current;
    const host = hostRef.current;
    if (!el || !host) return;

    const apply = () => {
      // An element with NO BOX measures 0: a session column the mobile layout
      // hides, a panel inside a display:none tab, anything mounted before its
      // container is shown. Writing that 0 is worse than writing nothing — the
      // scroller then pads by ~0 and the overlay covers the newest rows, with
      // no scroll position that can bring them out. Drop the property instead,
      // so the CSS fallback (a real composer's height) is what applies until
      // the box is back, and re-measure then.
      if (el.offsetHeight === 0 && el.getClientRects().length === 0) {
        host.style.removeProperty(varName);
        return;
      }
      const next = `${el.offsetHeight}px`;
      // The pin below compensates for a PADDING CHANGE. The host is observed too
      // (see below), so most callbacks now arrive with the same height — those
      // must not move a reader who is quietly sitting near the bottom.
      if (host.style.getPropertyValue(varName) === next) return;
      const sel = pinRef.current;
      const scroller = sel ? host.querySelector<HTMLElement>(sel) : null;
      // Capture "was at bottom" BEFORE the padding var changes layout.
      const nearBottom = scroller
        ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160
        : false;
      host.style.setProperty(varName, next);
      // Reading scrollHeight after the property write reflects the new padding.
      if (scroller && nearBottom) scroller.scrollTop = scroller.scrollHeight;
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
