/**
 * The one flyout shell of the draft's Project + Where row (the Where, Host and Project menus, a
 * package's "+ Add"): portalled to <body>, placed by useMenuPlacement against its trigger
 * (downward under the field by default, inside the draft when `boundsRef` names it), closed
 * through the overlay layer by an outside press and by Escape (consumed: the page's own Escape
 * would also clear the focused task; only the newest open layer closes, so a nested host list
 * closes before its menu) and when the trigger goes.
 * The portal stops pointerdown so a sortable ancestor never starts a drag (web/src/AGENTS.md).
 */
import { useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import '@/styles/project-start.css';

export const PROJECT_START_FLYOUT_CLASS = 'project-start-flyout';

export function ProjectStartFlyout({
  open, anchorRef, onClose, className, testId, label, children, minHeight = 160, side = 'down', boundsRef, style, returnFocusRef,
}: {
  open: boolean;
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  className?: string;
  testId?: string;
  /** The dialog's accessible name. */
  label: string;
  children: ReactNode;
  minHeight?: number;
  side?: 'up' | 'down';
  /** The box the flyout stays inside (the draft panel). */
  boundsRef?: RefObject<HTMLElement | null>;
  /** A fixed size (the Where picker's 820 x 488): merged under the placement. */
  style?: CSSProperties;
  /** Where Escape gives the focus back when it is not the anchor (the Where picker sits on the line under its field). */
  returnFocusRef?: RefObject<HTMLElement | null>;
}) {
  const boxRef = useRef<HTMLDivElement>(null);
  const placement = useMenuPlacement(open, anchorRef, boxRef, {
    minHeight, preferSide: side, align: 'start', gap: 6, edgeOverflow: 'clamp', onAnchorLost: onClose, ...(boundsRef ? { boundsRef } : {}),
  });
  useOverlayLayer({
    passOutsideClick: true,
    open,
    // The field Escape returns to is inside too: a press on it is not an outside press.
    refs: returnFocusRef ? [boxRef, anchorRef, returnFocusRef] : [boxRef, anchorRef],
    // Any of these flyouts (a nested "+ Add" inside the row, say) is not an outside press.
    exemptSelectors: [`.${PROJECT_START_FLYOUT_CLASS}`],
    onClose: (reason) => {
      onClose();
      // The anchor may be a field (a div) holding its own button: Escape gives the focus to that button.
      if (reason === 'escape') focusableIn((returnFocusRef ?? anchorRef).current)?.focus({ preventScroll: true });
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
      style={{ ...style, ...menuPlacementStyle(placement) }}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}

/** The element itself when it takes the focus, else its first button (a field's own open key). */
function focusableIn(el: HTMLElement | null): HTMLElement | null {
  if (!el) return null;
  if (el.matches('button, input, textarea, select, a[href], [tabindex]')) return el;
  return el.querySelector<HTMLElement>('button, [tabindex]');
}
