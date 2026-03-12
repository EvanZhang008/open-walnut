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
 * Escape calls `e.stopPropagation()` so nested modals close one at a time.
 */
export function useModalOverlay(onClose: () => void) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
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
