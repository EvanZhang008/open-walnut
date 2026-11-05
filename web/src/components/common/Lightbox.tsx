import { useCallback, useLayoutEffect, useRef, useState, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';

interface LightboxProps {
  src: string;
  alt?: string;
  onClose: () => void;
  /**
   * Grow a picture smaller than the screen toward filling it (up to 1.5x its
   * own size, past which a photo turns soft). A note already shows its pictures at their
   * own size, so a zoom that kept that size showed nothing new.
   */
  fill?: boolean;
  /** A line under the picture (its name), so a zoom says what it shows. */
  caption?: string;
}

/** Most a picture is grown: past this a photo only gets softer. */
const MAX_UPSCALE = 1.5;
/** An icon-sized picture is still grown to this many pixels on its long side. */
const MIN_ZOOMED_SIDE = 320;

export function Lightbox({ src, alt, onClose, fill = false, caption }: LightboxProps) {
  const [width, setWidth] = useState<number | undefined>(undefined);
  const onLoad = useCallback((e: SyntheticEvent<HTMLImageElement>) => {
    if (!fill) return;
    const img = e.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const longSide = Math.max(img.naturalWidth, img.naturalHeight);
    const scale = Math.min(
      (window.innerWidth * 0.9) / img.naturalWidth,
      (window.innerHeight * 0.9) / img.naturalHeight,
      Math.max(MAX_UPSCALE, MIN_ZOOMED_SIDE / longSide),
    );
    if (scale > 1) setWidth(Math.floor(img.naturalWidth * scale));
  }, [fill]);
  // A modal: focus moves in (onto the close button) and stays there, so a key
  // typed while it is open never reaches the page behind it. 2026-11-05 review:
  // in a note, a typed letter replaced the selected picture under the zoom.
  const closeRef = useRef<HTMLButtonElement>(null);
  // Escape closes this layer only: the listener runs in the window's capture
  // phase, ahead of every page or popup listener, and stops the key there. A
  // notes popup's own Escape closed the popup under an open zoom (2026-11-05 review).
  const overlayRef = useRef<HTMLDivElement>(null);
  // Closing hands focus back to the page (the note's caret): from then on the
  // focus trap below lets it go, or the zoom would take it back as it unmounts
  // and leave focus on nothing.
  const closingRef = useRef(false);
  const close = useCallback(() => { closingRef.current = true; onClose(); }, [onClose]);
  const inside = (t: EventTarget | null) => t instanceof Node && !!overlayRef.current?.contains(t);
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeRef.current?.focus(); return; }
    // Any other key aimed outside (focus pulled back by the page under it) is
    // stopped: the page never takes a key while the zoom is up.
    if (!inside(e.target)) { e.preventDefault(); e.stopPropagation(); closeRef.current?.focus(); }
  }, [close]);
  // Focus that leaves the zoom comes back to it. ProseMirror re-syncs the note's
  // selection a moment after a click, which in WebKit focuses the note again.
  const handleFocusIn = useCallback((e: FocusEvent) => {
    if (!closingRef.current && !inside(e.target)) closeRef.current?.focus({ preventScroll: true });
  }, []);
  // WebKit types into the editable that still holds the page's selection even
  // with focus on the close button (2026-11-05: a typed letter replaced the
  // selected picture under the zoom). No edit happens anywhere while it is up.
  const handleBeforeInput = useCallback((e: Event) => {
    if (!closingRef.current) { e.preventDefault(); e.stopPropagation(); }
  }, []);

  // Before the first paint: a key typed the moment the zoom shows must already
  // land here (WebKit painted it with the note still focused, 2026-11-05).
  useLayoutEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);

  // Layout effect: the keyboard is held from the first paint, before any key
  // typed the moment the zoom shows (WebKit, 2026-11-05).
  useLayoutEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('beforeinput', handleBeforeInput, true);
    // Prevent body scroll while lightbox is open
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('beforeinput', handleBeforeInput, true);
      document.body.style.overflow = prev;
    };
  }, [handleKeyDown, handleFocusIn, handleBeforeInput]);

  return createPortal(
    <div ref={overlayRef} className="lightbox-overlay" role="dialog" aria-modal="true" aria-label="Image preview" onClick={close}>
      <button ref={closeRef} className="lightbox-close" onClick={close} aria-label="Close image preview">&times;</button>
      <img
        className="lightbox-image"
        src={src}
        alt={alt || 'Image preview'}
        style={width ? { width: `${width}px` } : undefined}
        onLoad={onLoad}
        onClick={(e) => e.stopPropagation()}
      />
      {caption && <div className="lightbox-caption" onClick={(e) => e.stopPropagation()}>{caption}</div>}
    </div>,
    document.body,
  );
}
