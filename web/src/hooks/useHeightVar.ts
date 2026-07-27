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
      const sel = pinRef.current;
      const scroller = sel ? host.querySelector<HTMLElement>(sel) : null;
      // Capture "was at bottom" BEFORE the padding var changes layout.
      const nearBottom = scroller
        ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160
        : false;
      host.style.setProperty(varName, `${el.offsetHeight}px`);
      // Reading scrollHeight after the property write reflects the new padding.
      if (scroller && nearBottom) scroller.scrollTop = scroller.scrollHeight;
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty(varName);
    };
    // hostRef is a stable ref object; varName is constant per call site.
  }, [hostRef, varName]);

  return targetRef as RefObject<HTMLDivElement | null>;
}

/**
 * Same as useHeightVar but the host is the overlay's PARENT element — for
 * call sites that don't hold a ref to the container (e.g. the chat composer
 * overlay writing --chat-composer-h onto .chat-page).
 */
export function useOverlayHeightVar(varName: string, pinScrollSelector?: string) {
  const targetRef = useRef<HTMLDivElement | null>(null);
  const pinRef = useRef(pinScrollSelector);
  pinRef.current = pinScrollSelector;

  useEffect(() => {
    const el = targetRef.current;
    const host = el?.parentElement;
    if (!el || !host) return;

    const apply = () => {
      const sel = pinRef.current;
      const scroller = sel ? host.querySelector<HTMLElement>(sel) : null;
      const nearBottom = scroller
        ? scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160
        : false;
      host.style.setProperty(varName, `${el.offsetHeight}px`);
      if (scroller && nearBottom) scroller.scrollTop = scroller.scrollHeight;
    };

    apply();
    const ro = new ResizeObserver(apply);
    ro.observe(el);
    return () => {
      ro.disconnect();
      host.style.removeProperty(varName);
    };
  }, [varName]);

  return targetRef;
}
