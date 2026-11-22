/**
 * The one flyout shell of the draft's project-first row (the Work in popover, its host list, a
 * value chip's "+ Add"): portalled to <body>, placed by useMenuPlacement against its trigger
 * (upward first, like the folder picker beside it), closed through the overlay layer by an
 * outside press and by Escape (consumed: the page's own Escape would also clear the focused task;
 * only the newest open layer closes, so a nested host list closes before its popover) and when
 * the trigger goes.
 * The portal stops pointerdown so a sortable ancestor never starts a drag (web/src/AGENTS.md).
 */
import { useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import '@/styles/project-start.css';

export const PROJECT_START_FLYOUT_CLASS = 'project-start-flyout';

export function ProjectStartFlyout({ open, anchorRef, onClose, className, testId, label, children, minHeight = 160 }: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  className?: string;
  testId?: string;
  /** The dialog's accessible name. */
  label: string;
  children: ReactNode;
  minHeight?: number;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, boxRef, { minHeight, preferSide: 'up', align: 'left', onAnchorLost: onClose });
  useOverlayLayer({
    passOutsideClick: true,
    open,
    refs: [boxRef, anchorRef],
    // Any of these flyouts (a nested "+ Add" inside the row, say) is not an outside press.
    exemptSelectors: [`.${PROJECT_START_FLYOUT_CLASS}`],
    onClose: (reason) => {
      onClose();
      if (reason === 'escape') anchorRef.current?.focus({ preventScroll: true });
    },
  });
  if (!open) return null;
  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label={label}
      className={`${PROJECT_START_FLYOUT_CLASS} wn-overlay${className ? ` ${className}` : ''}`}
      data-testid={testId}
      style={menuPlacementStyle(placement)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
