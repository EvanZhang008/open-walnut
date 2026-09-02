import { useEffect, useCallback } from 'react';

/**
 * Ref-counted body scroll lock — multiple overlapping modals
 * won't accidentally restore scrollability when one closes.
 * Exported so non-modal consumers (e.g. useFullscreen) can participate
 * in the same ref-count instead of directly writing body.style.overflow.
 */
let scrollLockCount = 0;

export function lockScroll() {
  scrollLockCount++;
  if (scrollLockCount === 1) {
    document.body.style.overflow = 'hidden';
  }
}

export function unlockScroll() {
  scrollLockCount = Math.max(0, scrollLockCount - 1);
  if (scrollLockCount === 0) {
    document.body.style.overflow = '';
  }
}

/**
 * Shared modal overlay behavior: Escape-to-close + ref-counted body scroll lock.
 *
 * An overlay MUST stop propagation on Escape. That is what makes nested modals
 * close one at a time, and it is the only thing that keeps the outer Escape
 * handlers from acting on the same keypress — most of them (context menus,
 * useFullscreen, inline editors) check nothing at all, so `preventDefault()` is
 * not a substitute for stopping.
 *
 * preventDefault comes FIRST. The beep guard folds its beep suppression into
 * `stopPropagation` (utils/escape-beep-guard.ts, because a stopped event never
 * reaches the guard's own listener), so stopping first would record the GUARD as
 * the owner of the key and `escapeWasConsumedByOthers` would report that nobody
 * consumed this Escape.
 */
export function useModalOverlay(onClose: () => void) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    }
  }, [onClose]);

  useEffect(() => {
    document.addEventListener('keydown', handleKeyDown);
    lockScroll();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      unlockScroll();
    };
  }, [handleKeyDown]);
}
