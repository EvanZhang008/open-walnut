import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import '@/styles/link-hover-card.css';

/**
 * The card a link pill shows on hover or focus: what the link is, its whole URL or path, and
 * where a click takes it. A pill reads as its kind alone (`report`), so this is where the
 * target is named; the native `title` it replaces shows late, and in the Mac app's WebKit
 * often not at all (2026-10-23).
 *
 * Informational only: it never takes the pointer (`pointer-events: none`), so moving onto it
 * or past it never steals a click from the row or the pill.
 */

const SHOW_DELAY_MS = 250;
const GAP = 6;
const MARGIN = 8;

export interface LinkHoverInfo {
  kind: string;
  /** The URL or the absolute path. */
  target: string;
  /** Where a click takes it ("Opens in a new tab · github.com", "Opens in Files"). */
  opens: string;
}

export function useLinkHoverCard(info: LinkHoverInfo | undefined) {
  const anchorRef = useRef<HTMLElement | null>(null);
  const [open, setOpen] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clear = () => { if (timer.current) { clearTimeout(timer.current); timer.current = null; } };
  const show = useCallback(() => {
    clear();
    timer.current = setTimeout(() => setOpen(true), SHOW_DELAY_MS);
  }, []);
  const hide = useCallback(() => { clear(); setOpen(false); }, []);
  useEffect(() => clear, []);

  if (!info) return { anchorRef, handlers: {}, card: null };
  return {
    anchorRef,
    handlers: { onPointerEnter: show, onPointerLeave: hide, onFocus: show, onBlur: hide, onClickCapture: hide },
    card: open ? <LinkHoverCard info={info} anchor={anchorRef.current} onGone={hide} /> : null,
  };
}

function LinkHoverCard({ info, anchor, onGone }: { info: LinkHoverInfo; anchor: HTMLElement | null; onGone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({ visibility: 'hidden' });

  useLayoutEffect(() => {
    const card = ref.current;
    if (!anchor || !card || !anchor.isConnected) { onGone(); return; }
    const a = anchor.getBoundingClientRect();
    const w = card.offsetWidth;
    const h = card.offsetHeight;
    const below = a.bottom + GAP + h <= window.innerHeight - MARGIN || a.top - GAP - h < MARGIN;
    const left = Math.min(Math.max(MARGIN, a.left), Math.max(MARGIN, window.innerWidth - MARGIN - w));
    setStyle({ left, top: below ? a.bottom + GAP : a.top - GAP - h });
  }, [anchor, onGone]);

  // A scroll moves the pill out from under a fixed card: close rather than float off.
  useEffect(() => {
    window.addEventListener('scroll', onGone, true);
    return () => window.removeEventListener('scroll', onGone, true);
  }, [onGone]);

  return createPortal(
    <div ref={ref} className="link-hover-card" role="tooltip" style={style} data-testid="link-hover-card">
      <div className="link-hover-card-kind">{info.kind}</div>
      <div className="link-hover-card-target">{info.target}</div>
      <div className="link-hover-card-opens">{info.opens}</div>
    </div>,
    document.body,
  );
}
