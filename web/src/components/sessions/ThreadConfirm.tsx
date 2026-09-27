/**
 * The small confirm layer anchored on a button or a row (Remove with
 * follow-ups, Done with open follow-ups). Menu rules from web/src/AGENTS.md:
 * portalled to <body>, placed by useMenuPlacement, pointerdown stops at the
 * portal, and a marker attribute lets every outside-click closer exempt it.
 *
 * Esc is caught on window in the CAPTURE phase while open, so it closes this
 * layer and nothing else (not the stack, the drawer or fullscreen), wherever
 * focus is. Default focus is the cancel button.
 */
import { useEffect, useId, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
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
  const dismissRef = useRef(onDismiss ?? onCancel);
  dismissRef.current = onDismiss ?? onCancel;

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
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing) return;
      e.preventDefault();
      e.stopPropagation();
      dismissRef.current();
    };
    const onDown = (e: PointerEvent) => {
      if (boxRef.current?.contains(e.target as Node)) return;
      if (anchorEl?.contains(e.target as Node)) return;
      dismissRef.current();
    };
    window.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    return () => {
      window.removeEventListener('keydown', onKey, true);
      document.removeEventListener('pointerdown', onDown, true);
      if (prev && document.contains(prev)) prev.focus({ preventScroll: true });
    };
  }, [anchorEl]);

  const style = place
    ? { top: place.top, right: place.right, maxHeight: place.maxHeight }
    : { top: -9999, right: -9999, visibility: 'hidden' as const };

  return createPortal(
    <div
      ref={boxRef}
      className="thread-confirm"
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
        <button ref={cancelRef} type="button" className="thread-confirm-btn" data-default="true" onClick={onCancel}>{cancelLabel}</button>
        <button
          type="button"
          className={danger ? 'thread-confirm-btn thread-confirm-btn--danger' : neutral ? 'thread-confirm-btn' : 'thread-confirm-btn thread-confirm-btn--primary'}
          onClick={onConfirm}
        >
          {confirmLabel}
        </button>
      </div>
    </div>,
    document.body,
  );
}
