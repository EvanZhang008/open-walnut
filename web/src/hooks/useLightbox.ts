import { useState, useCallback } from 'react';

/**
 * Hook for managing lightbox state.
 * Returns the current src (null when closed), an open function, and a close function.
 *
 * Usage with event delegation on markdown containers:
 *   onClick={(e) => {
 *     const img = (e.target as HTMLElement).closest('img[data-lightbox-src]');
 *     if (img) openLightbox(img.getAttribute('data-lightbox-src')!);
 *   }}
 */
export function useLightbox() {
  const [src, setSrc] = useState<string | null>(null);

  const open = useCallback((imgSrc: string) => setSrc(imgSrc), []);
  const close = useCallback(() => setSrc(null), []);

  return { lightboxSrc: src, openLightbox: open, closeLightbox: close };
}
