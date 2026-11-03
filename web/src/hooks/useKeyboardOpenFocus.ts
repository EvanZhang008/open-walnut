import { useCallback, useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE = 'button:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';

/**
 * A flyout portalled to the end of <body> is out of the Tab order of the button that
 * opened it, so a keyboard user could only Escape it. Opened from the keyboard (a click
 * with `detail` 0), its first control takes the focus; a pointer open leaves focus alone.
 * Call the returned function from the opener's click handler with the event.
 */
export function useKeyboardOpenFocus(open: boolean, menuRef: RefObject<HTMLElement | null>): (e: { detail: number }) => void {
  const fromKeyboard = useRef(false);
  useEffect(() => {
    if (!open || !fromKeyboard.current) return;
    const frame = requestAnimationFrame(() => {
      menuRef.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [open, menuRef]);
  return useCallback((e: { detail: number }) => { fromKeyboard.current = e.detail === 0; }, []);
}
