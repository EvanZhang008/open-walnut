/**
 * "Latest update" from the composer's "+" menu: the session's two short recap
 * paragraphs (Overall, Latest) that the turn-complete self-report writes.
 *
 * They used to sit above the composer as a grey card (SessionRecapTip). The user
 * found it took precious room on every session (2026-10-26: "it is not very
 * useful and it takes a lot of space"), so the text now opens on demand here.
 * Placed like the trigger picker: portalled, `useMenuPlacement` against the "+"
 * button, an outside pointerdown or Escape closes it, and the body scrolls
 * inside the placement's height cap.
 */
import { useCallback, useEffect, useRef, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { timeAgo } from '@/utils/time';
import '@/styles/session-recap.css';

export type LatestUpdateCloseReason = 'escape' | 'close' | 'outside' | 'anchor-lost';

export function LatestUpdatePopover(props: {
  overview: string;
  recap: string;
  /** The newer of the two texts' stamps, for the "updated" line. */
  at: string | undefined;
  anchorRef: RefObject<HTMLElement | null>;
  composerRef?: RefObject<HTMLElement | null>;
  onClose: (reason: LatestUpdateCloseReason) => void;
}) {
  const { overview, recap, at, anchorRef, composerRef, onClose } = props;
  const rootRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback((reason: LatestUpdateCloseReason) => onCloseRef.current(reason), []);

  const placement = useMenuPlacement(true, anchorRef, rootRef, {
    preferSide: 'up', align: 'start', edgeOverflow: 'clamp', verticalAnchorRef: composerRef, margin: 12, minHeight: 160,
    onAnchorLost: () => close('anchor-lost'),
  });
  const placed = placement !== null;
  useEffect(() => {
    if (placed) rootRef.current?.focus({ preventScroll: true });
  }, [placed]);

  useEffect(() => {
    const onPointerDown = (e: PointerEvent) => {
      const root = rootRef.current;
      if (!root || root.contains(e.target as Node)) return;
      close('outside');
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  }, [close]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    const anchor = anchorRef.current;
    close('escape');
    anchor?.focus({ preventScroll: true });
  };

  const ago = at ? timeAgo(at) : '';
  return createPortal(
    <div
      ref={rootRef}
      className="latest-update-popover"
      role="dialog"
      aria-label="Latest update"
      tabIndex={-1}
      data-testid="latest-update-popover"
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={onKeyDown}
      style={{
        top: placement?.top,
        right: placement?.right,
        visibility: placement ? undefined : 'hidden',
        ['--menu-max-height' as string]: placement ? `${placement.maxHeight}px` : undefined,
      } as CSSProperties}
    >
      <header className="latest-update-header">
        <h2 className="latest-update-title">Latest update</h2>
        {ago && <span className="latest-update-ago" title={at}>{ago}</span>}
        <button
          type="button"
          className="latest-update-close"
          aria-label="Close"
          onClick={() => { const a = anchorRef.current; close('close'); a?.focus({ preventScroll: true }); }}
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
            <path d="M4 4l8 8M12 4l-8 8" />
          </svg>
        </button>
      </header>
      <div className="latest-update-body">
        {overview && (
          <p className="latest-update-row" data-testid="session-recap-overview">
            <span className="latest-update-label">Overall</span>
            <span className="latest-update-text">{overview}</span>
          </p>
        )}
        {recap && (
          <p className="latest-update-row" data-testid="session-recap-latest">
            <span className="latest-update-label">Latest</span>
            <span className="latest-update-text">{recap}</span>
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
