/**
 * A confirmation as a bottom sheet (spec 4.2, 4.7): "Complete this task?",
 * "Sign out this phone?". It is a phone layer (back closes it, as Cancel does),
 * buttons are at least 44 px tall and the sheet keeps clear of the home
 * indicator. While `busy` both buttons are disabled; `error` shows one line in
 * the sheet and keeps it open. The owner closes it by flipping `open` false.
 */
import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { usePhoneOverlay } from '@/hooks/usePhoneOverlayHistory';

export interface PhoneConfirmSheetProps {
  open: boolean;
  /** Layer id suffix: the sheet registers as `sheet:<name>`. */
  name: string;
  title: string;
  body: string;
  confirmLabel: string;
  cancelLabel?: string;
  destructive?: boolean;
  busy?: boolean;
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  testId?: string;
}

export function PhoneConfirmSheet({
  open, name, title, body, confirmLabel, cancelLabel = 'Cancel', destructive, busy, error,
  onConfirm, onCancel, testId,
}: PhoneConfirmSheetProps) {
  const { close } = usePhoneOverlay({
    id: `sheet:${name}`,
    kind: 'sheet',
    open,
    bar: null,
    onClose: () => onCancel(),
  });
  const cancelRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return undefined;
    const frame = requestAnimationFrame(() => cancelRef.current?.focus());
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || busy) return;
      ev.preventDefault();
      ev.stopPropagation();
      close();
    };
    document.addEventListener('keydown', onKey, true);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [open, busy, close]);

  if (!open) return null;
  const id = `phone-confirm-${name}`;
  return createPortal(
    <div
      className="phone-confirm-sheet-root"
      data-testid={testId}
      onPointerDown={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        className="phone-confirm-sheet-backdrop"
        aria-label={cancelLabel}
        tabIndex={-1}
        onClick={() => { if (!busy) close(); }}
      />
      <div
        className="phone-confirm-sheet"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-body`}
      >
        <h2 id={`${id}-title`} className="phone-confirm-sheet-title">{title}</h2>
        <p id={`${id}-body`} className="phone-confirm-sheet-body">{body}</p>
        {error ? <p className="phone-confirm-sheet-error" role="alert">{error}</p> : null}
        <div className="phone-confirm-sheet-actions">
          <button
            ref={cancelRef}
            type="button"
            className="phone-confirm-sheet-btn"
            disabled={busy}
            onClick={() => close()}
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`phone-confirm-sheet-btn phone-confirm-sheet-btn-primary${destructive ? ' is-destructive' : ''}`}
            disabled={busy}
            aria-busy={busy || undefined}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
