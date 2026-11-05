/**
 * A control that moves between two parents is a new element each time: a settings pane's header
 * actions move into the sticky bar once the pane scrolls (SettingsSection PaneHeader portals
 * them), so a press that scrolls the pane (Remote Hosts' "need a look" bringing a host into view,
 * a scroll that closes Add host's menu) unmounts the control that held the focus, and the focus
 * fell to the page (2026-11-04 review). The control, mounted again under its new parent, takes
 * the focus back when it still sits on the page.
 *
 * `holds()`: the control counts as holding the focus while this is true too (a menu it opened,
 * portalled to body, has the focus instead of its button).
 *
 * A focus a press landed there (focus-landed.ts: its ring, which a mouse press would not draw)
 * moves with its ring: the button that took it back after a scroll showed none, so the focus was
 * there and nobody could see it (Chromium, Add host after a closed link: the landing scrolled the
 * pane to its top and the button moved out of the sticky bar).
 */
import { useLayoutEffect, useRef, type RefObject } from 'react';
import { focusLanded } from './focus-landed';

/** The control that held the focus as it went (`el`), keyed by the control's key. */
const held = new Map<string, { at: number; landed: boolean; el: HTMLElement }>();
/** A remount happens in the same commit; anything later is not a move. */
const MOVE_MS = 1000;

export function useFocusAcrossRemount(key: string, ref: RefObject<HTMLElement | null>, holds?: () => boolean): void {
  const holdsRef = useRef(holds);
  holdsRef.current = holds;
  // The element as of the last commit. Read on every commit, not only at mount: a control that
  // renders nothing at first (a count of none, before the rows have reported) gets its element
  // later, and its move must still be kept (review).
  const elRef = useRef<HTMLElement | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    // Its own claim, from effects run again on the same element (React's StrictMode does that on
    // every mount in development): no move, so no claim (2026-11-05, Chromium: a claim kept that
    // way gave the next move of the header the focus Add host had).
    if (el && held.get(key)?.el === el) held.delete(key);
    if (el === elRef.current) return;
    elRef.current = el;
    if (!el) return;
    const was = held.get(key);
    held.delete(key);
    if (was === undefined || Date.now() - was.at >= MOVE_MS) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const target = el.matches('button, a[href], input, [tabindex]') ? el : el.querySelector<HTMLElement>('button, a[href], input, [tabindex]');
    if (was.landed) focusLanded(target);
    else target?.focus({ preventScroll: true });
  });
  useLayoutEffect(() => () => {
    const el = elRef.current;
    const a = document.activeElement;
    if (el && ((a && el.contains(a)) || holdsRef.current?.())) {
      held.set(key, { at: Date.now(), landed: !!a && el.contains(a) && a.hasAttribute('data-landed'), el });
    }
  }, [key]);
}
