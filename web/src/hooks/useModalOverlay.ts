import { useEffect, useCallback, useRef } from 'react';

/**
 * Ref-counted body scroll lock — multiple overlapping modals
 * won't accidentally restore scrollability when one closes.
 * Exported so non-modal consumers (e.g. useFullscreen) can participate
 * in the same ref-count instead of directly writing body.style.overflow.
 */
let scrollLockCount = 0;
let activeModalCount = 0;
const openModalClosers = new Set<{ current: () => void }>();

export function hasActiveModalOverlay(): boolean {
  return activeModalCount > 0;
}

/**
 * Close every open modal, newest first: the console is about to show another page
 * (a link opened in a plugin's App, plugins/LinkCaptureHost.tsx), and a modal left
 * open would sit on top of it, as a slot's `onNavigate` closes its own (PluginSlots).
 */
export function closeModalOverlays(): void {
  for (const closer of [...openModalClosers].reverse()) {
    try { closer.current(); } catch { /* one modal's close must not keep the rest open */ }
  }
}

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

  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    openModalClosers.add(closeRef);
    return () => { openModalClosers.delete(closeRef); };
  }, []);

  useEffect(() => {
    activeModalCount++;
    document.addEventListener('keydown', handleKeyDown);
    lockScroll();
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      activeModalCount--;
      unlockScroll();
    };
  }, [handleKeyDown]);
}
