import { useCallback, useLayoutEffect, useRef, useState, type MouseEvent, type SyntheticEvent } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';

/**
 * A note's picture, zoomed. It wears the Lightbox's look (`.lightbox-*`) and is a
 * modal like it (useModalOverlay: scroll lock, closed with the other modals), and
 * it also guards the note under it: a note is an editor holding the picture as its
 * selection, so a key that reached it would replace or delete the picture.
 */
interface NoteZoomProps {
  src: string;
  alt?: string;
  /** A line under the picture (its name), so a zoom says what it shows. */
  caption?: string;
  onClose: () => void;
}

/** Most a picture is grown: past this a photo only gets softer. */
const MAX_UPSCALE = 1.5;
/** An icon-sized picture is still grown to this many pixels on its long side. */
const MIN_ZOOMED_SIDE = 320;

export function NoteZoom({ src, alt, caption, onClose }: NoteZoomProps) {
  // A note already shows its pictures at their own size, so a zoom grows one
  // smaller than the screen toward filling it. It opens on the whole picture;
  // a tall one fits by its height there, no larger than in the note (round 7
  // review), so a click on it fills the width instead and the zoom scrolls.
  const [size, setSize] = useState<{ fit?: number; fill?: number }>({});
  const [filled, setFilled] = useState(false);
  const onLoad = useCallback((e: SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    if (!img.naturalWidth || !img.naturalHeight) return;
    const longSide = Math.max(img.naturalWidth, img.naturalHeight);
    const grow = Math.max(MAX_UPSCALE, MIN_ZOOMED_SIDE / longSide);
    const byWidth = Math.min((window.innerWidth * 0.9) / img.naturalWidth, grow);
    const whole = Math.min(byWidth, (window.innerHeight * 0.9) / img.naturalHeight);
    const fill = Math.floor(img.naturalWidth * byWidth);
    setSize({
      fit: whole > 1 ? Math.floor(img.naturalWidth * whole) : undefined,
      // Worth a second view only when it is clearly larger.
      fill: fill > img.naturalWidth * whole * 1.15 ? fill : undefined,
    });
  }, []);
  const toggleFill = useCallback((e: MouseEvent) => {
    e.stopPropagation();
    if (size.fill) setFilled((f) => !f);
  }, [size.fill]);
  const imgStyle = filled && size.fill
    ? { width: `${size.fill}px`, maxWidth: 'none', maxHeight: 'none' }
    : size.fit ? { width: `${size.fit}px` } : undefined;
  // Focus moves in (onto the close button) and stays there, so a key typed while
  // it is open never reaches the note. 2026-11-05 review: a typed letter replaced
  // the selected picture under the zoom.
  const closeRef = useRef<HTMLButtonElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  // Closing hands focus back to the note's caret: from then on the focus trap
  // lets it go, or the zoom would take it back as it unmounts.
  const closingRef = useRef(false);
  const close = useCallback(() => { closingRef.current = true; onClose(); }, [onClose]);
  useModalOverlay(close);
  const inside = (t: EventTarget | null) => t instanceof Node && !!overlayRef.current?.contains(t);
  // Window capture phase, ahead of every page or popup listener: a notes popup's
  // own Escape closed the popup under an open zoom (2026-11-05 review).
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      if (e.isComposing || e.keyCode === 229) return;
      e.preventDefault(); e.stopPropagation(); close(); return;
    }
    if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); closeRef.current?.focus(); return; }
    // Any other key aimed outside (focus pulled back by the note) is stopped.
    if (!inside(e.target)) { e.preventDefault(); e.stopPropagation(); closeRef.current?.focus(); }
  }, [close]);
  // Focus that leaves the zoom comes back to it. ProseMirror re-syncs the note's
  // selection a moment after a click, which in WebKit focuses the note again.
  const handleFocusIn = useCallback((e: FocusEvent) => {
    if (!closingRef.current && !inside(e.target)) closeRef.current?.focus({ preventScroll: true });
  }, []);
  // WebKit types into the editable that still holds the page's selection even
  // with focus on the close button. No edit happens anywhere while it is up.
  const handleBeforeInput = useCallback((e: Event) => {
    if (!closingRef.current) { e.preventDefault(); e.stopPropagation(); }
  }, []);

  // Layout effects: focus and the keyboard are held from the first paint, before
  // any key typed the moment the zoom shows (WebKit, 2026-11-05).
  useLayoutEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
  }, []);
  useLayoutEffect(() => {
    window.addEventListener('keydown', handleKeyDown, true);
    document.addEventListener('focusin', handleFocusIn, true);
    document.addEventListener('beforeinput', handleBeforeInput, true);
    return () => {
      window.removeEventListener('keydown', handleKeyDown, true);
      document.removeEventListener('focusin', handleFocusIn, true);
      document.removeEventListener('beforeinput', handleBeforeInput, true);
    };
  }, [handleKeyDown, handleFocusIn, handleBeforeInput]);

  const picture = (
    <img
      className={`lightbox-image${size.fill ? (filled ? ' lightbox-image--filled' : ' lightbox-image--fillable') : ''}`}
      src={src}
      alt={alt || 'Image preview'}
      title={size.fill ? (filled ? 'Show the whole picture' : 'Fill the width') : undefined}
      style={imgStyle}
      onLoad={onLoad}
      onClick={toggleFill}
    />
  );

  return createPortal(
    <div ref={overlayRef} className={filled ? 'lightbox-overlay lightbox-overlay--scroll' : 'lightbox-overlay'} role="dialog" aria-modal="true" aria-label="Image preview" onClick={close}>
      <button ref={closeRef} className="lightbox-close" onClick={close} aria-label="Close image preview">&times;</button>
      {filled ? <div className="lightbox-scroll">{picture}</div> : picture}
      {caption && <div className="lightbox-caption" onClick={(e) => e.stopPropagation()}>{caption}</div>}
    </div>,
    document.body,
  );
}
