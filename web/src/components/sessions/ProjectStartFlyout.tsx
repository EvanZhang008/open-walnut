/**
 * The one flyout shell of the draft's project-first row (the Work in popover, its host list, a
 * value chip's "+ Add"): portalled to <body>, placed by useMenuPlacement against its trigger
 * (upward first, like the folder picker beside it), closed by an outside press, by Escape
 * (consumed: the page's own Escape would also clear the focused task; only the newest open one
 * closes) and when the trigger goes.
 * The portal stops pointerdown so a sortable ancestor never starts a drag (web/src/AGENTS.md).
 */
import { useEffect, useRef, type ReactNode, type RefObject } from 'react';
import { createPortal } from 'react-dom';
import { menuPlacementStyle, useMenuPlacement } from '@/hooks/useMenuPlacement';
import '@/styles/project-start.css';

export const PROJECT_START_FLYOUT_CLASS = 'project-start-flyout';

/** The open flyouts, oldest first: Escape closes only the newest (a nested host list, not its popover). */
const openStack: object[] = [];

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
    const me = {};
    openStack.push(me);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Element | null;
      if (anchorRef.current?.contains(t)) return;
      // Any of these flyouts (a nested "+ Add" inside the row, say) is not an outside press.
      if (t?.closest?.(`.${PROJECT_START_FLYOUT_CLASS}`)) return;
      closeRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      // Every open flyout listens on window capture; only the topmost answers.
      if (e.key !== 'Escape' || openStack[openStack.length - 1] !== me) return;
      e.stopPropagation();
      closeRef.current();
      anchorRef.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      openStack.splice(openStack.indexOf(me), 1);
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
