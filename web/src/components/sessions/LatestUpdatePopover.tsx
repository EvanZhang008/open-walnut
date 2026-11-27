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
import { useCallback, useEffect, useRef, type CSSProperties, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import { fullTime, timeAgo } from '@/utils/time';
import { AgentText } from '@/components/common/AgentText';
import '@/styles/header-fit.css';
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
  /** The session the texts are about: a path in them opens on its host. */
  sessionId?: string;
}) {
  const { overview, recap, at, anchorRef, composerRef, onClose, sessionId } = props;
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

  // Escape gives focus back to the "+" button. A press outside closes it and its
  // click goes through, as with the engine settings from the same "+": the
  // anchor is not exempt, so pressing "+" closes this and the click opens the menu.
  useOverlayLayer({
    open: true,
    refs: [rootRef],
    passOutsideClick: true,
    onClose: (reason) => {
      const anchor = anchorRef.current;
      close(reason);
      if (reason === 'escape') anchor?.focus({ preventScroll: true });
    },
  });

  const ago = at ? timeAgo(at) : '';
  return createPortal(
    <div
      ref={rootRef}
      className="latest-update-popover wn-overlay"
      role="dialog"
      aria-label="Latest update"
      tabIndex={-1}
      data-testid="latest-update-popover"
      onPointerDown={(e) => e.stopPropagation()}
      style={{
        top: placement?.top,
        right: placement?.right,
        visibility: placement ? undefined : 'hidden',
        ['--menu-max-height' as string]: placement ? `${placement.maxHeight}px` : undefined,
      } as CSSProperties}
    >
      <header className="latest-update-header" data-fit-header="">
        <h2 className="latest-update-title" data-fit-title="">Latest update</h2>
        {ago && <span className="latest-update-ago" data-fit-sub="" title={fullTime(at)}>{ago}</span>}
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
            <AgentText compact inline sessionId={sessionId} className="latest-update-text" text={overview} />
          </p>
        )}
        {recap && (
          <p className="latest-update-row" data-testid="session-recap-latest">
            <span className="latest-update-label">Latest</span>
            <AgentText compact inline sessionId={sessionId} className="latest-update-text" text={recap} />
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
