/**
 * The small confirm layer anchored on a button or a row (Remove with
 * follow-ups, Done with open follow-ups). Menu rules from web/src/AGENTS.md:
 * portalled to <body>, placed by useMenuPlacement, pointerdown stops at the
 * portal, and a marker attribute lets every outside-click closer exempt it.
 *
 * Esc and an outside press go through the one overlay layer (useOverlayLayer),
 * so Esc closes this layer and nothing else (not the stack, the drawer or
 * fullscreen), wherever focus is. A light confirm: the press outside also does
 * what it pressed. Default focus is the cancel button, and it goes back where
 * it was when the confirm closes.
 */
import { useEffect, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useOverlayLayer } from '@/hooks/useOverlayLayer';
import '@/styles/thread-stack.css';

/** Every thread overlay (confirm, toast) carries this attribute. */
export const THREAD_OVERLAY_ATTR = 'data-thread-overlay';
export const THREAD_OVERLAY_SELECTOR = `[${THREAD_OVERLAY_ATTR}]`;

export interface ThreadConfirmProps {
  anchorEl: HTMLElement | null;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  /** Both buttons neutral: the default (cancel) choice is the safe one, so the
   *  bulk action must not draw the eye (N21, the follow-ups confirm). */
  neutral?: boolean;
  onConfirm: () => void;
  /** The cancel BUTTON (for Done: `Only this one`). */
  onCancel: () => void;
  /** Esc or a click outside; defaults to onCancel. */
  onDismiss?: () => void;
}

export function ThreadConfirm({ anchorEl, title, body, confirmLabel, cancelLabel, danger, neutral, onConfirm, onCancel, onDismiss }: ThreadConfirmProps) {
  const triggerRef = useMemo(() => ({ current: anchorEl }), [anchorEl]);
  const boxRef = useRef<HTMLDivElement | null>(null);
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const place = useMenuPlacement(true, triggerRef, boxRef, { align: 'right', minHeight: 80, onAnchorLost: onDismiss ?? onCancel });
  const titleId = useId();
  const bodyId = useId();
  useOverlayLayer({ open: true, refs: [boxRef, triggerRef], onClose: onDismiss ?? onCancel, passOutsideClick: true });

  // Default focus waits for placement: until `place` lands the box is
  // visibility:hidden, and focusing a hidden button is a no-op in every engine.
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!place || focusedRef.current) return;
    focusedRef.current = true;
    cancelRef.current?.focus({ preventScroll: true });
  }, [place]);

  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    return () => { if (prev && document.contains(prev)) prev.focus({ preventScroll: true }); };
  }, [anchorEl]);

  const style = place
    ? { top: place.top, right: place.right, maxHeight: place.maxHeight }
    : { top: -9999, right: -9999, visibility: 'hidden' as const };

  return createPortal(
    <div
      ref={boxRef}
      className="thread-confirm wn-overlay"
      role="alertdialog"
      aria-modal="false"
      aria-labelledby={titleId}
      aria-describedby={body ? bodyId : undefined}
      {...{ [THREAD_OVERLAY_ATTR]: 'confirm' }}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div id={titleId} className="thread-confirm-title">{title}</div>
      {body && <div id={bodyId} className="thread-confirm-body">{body}</div>}
      <div className="thread-confirm-actions">
        {/* The default button keeps a ring while it holds focus, however the
            confirm was opened: WebKit never counts a programmatic focus as
            :focus-visible, and Enter must do what the eye predicts (N46). */}
        {/* The button family (buttons.css): a quiet key, and the action as the main key (red when it
            removes); neutral leaves both quiet. */}
        <button ref={cancelRef} type="button" className="btn btn-sm" data-default="true" onClick={onCancel}>{cancelLabel}</button>
        <button
          type="button"
          className={danger ? 'btn btn-sm btn-primary btn-danger' : neutral ? 'btn btn-sm' : 'btn btn-sm btn-primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}
