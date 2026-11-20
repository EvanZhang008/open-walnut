/**
 * The one flyout shell of the draft's project-first row (the project picker, the host list, a
 * value chip's "+ Add"): portalled to <body>, placed by useMenuPlacement against its trigger
 * (upward first, like the folder picker beside it), closed by an outside press, by Escape
 * (consumed: the page's own Escape would also clear the focused task) and when the trigger goes.
 * The portal stops pointerdown so a sortable ancestor never starts a drag (web/src/AGENTS.md).
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
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
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (anchorRef.current?.contains(t)) return;
      // Any of these flyouts (a nested "+ Add" inside the row, say) is not an outside press.
      if (t?.closest?.(`.${PROJECT_START_FLYOUT_CLASS}`)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      closeRef.current();
      anchorRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open, anchorRef]);
  if (!open) return null;
  return createPortal(
    <div
      ref={boxRef}
      role="dialog"
      aria-label={label}
      className={`${PROJECT_START_FLYOUT_CLASS}${className ? ` ${className}` : ''}`}
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
