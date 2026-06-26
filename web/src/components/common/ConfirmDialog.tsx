import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useModalOverlay } from '@/hooks/useModalOverlay';

interface ConfirmDialogProps {
  title: string;
  message?: ReactNode;
  confirmLabel: string;
  /** Omitted for alert-style dialogs (single OK button). */
  cancelLabel?: string;
  danger?: boolean;
  /** When defined, renders a single-line text input (prompt mode). The submitted
   *  value is passed to onConfirm; an empty/whitespace value is rejected (no-op)
   *  unless promptAllowEmpty is set. */
  promptDefaultValue?: string;
  promptPlaceholder?: string;
  /** Allow submitting an empty value (prompt mode) — e.g. "clear" semantics. */
  promptAllowEmpty?: boolean;
  /** onConfirm receives the input value in prompt mode, undefined otherwise. */
  onConfirm: (value?: string) => void;
  onCancel: () => void;
}

/**
 * The app's own confirm/alert/prompt dialog — replaces browser-native
 * `confirm`/`alert`/`prompt` (rendered by useConfirm's ConfirmProvider). Portal to
 * body, Esc-to-cancel + scroll-lock via useModalOverlay, Enter confirms. Reuses the
 * modal-overlay styling conventions (.app-modal-*). In prompt mode it renders a text
 * input (auto-focused + selected) and submits its value.
 */
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger,
  promptDefaultValue,
  promptPlaceholder,
  promptAllowEmpty,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  useModalOverlay(onCancel);
  const confirmRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const isPrompt = promptDefaultValue !== undefined;
  const [value, setValue] = useState(promptDefaultValue ?? '');

  // Prompt: focus + select the input so the user can type/replace immediately.
  // Otherwise focus the confirm button so Enter works and the default is obvious.
  useEffect(() => {
    const t = setTimeout(() => {
      if (isPrompt) inputRef.current?.select();
      else confirmRef.current?.focus();
    }, 10);
    return () => clearTimeout(t);
  }, [isPrompt]);

  // Submit the prompt value (rejecting empty/whitespace unless allowed); plain confirm otherwise.
  const submit = () => {
    if (isPrompt) {
      const trimmed = value.trim();
      if (!trimmed && !promptAllowEmpty) return; // empty rejected — keep the dialog open
      onConfirm(trimmed);
    } else {
      onConfirm();
    }
  };

  return createPortal(
    <div
      className="app-modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={onCancel}
    >
      <div className="app-modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="app-modal-title">{title}</div>
        {message != null && message !== '' && (
          <div className="app-modal-message">{message}</div>
        )}
        {isPrompt && (
          <input
            ref={inputRef}
            className="app-modal-input"
            value={value}
            placeholder={promptPlaceholder}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); submit(); }
              else if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
            }}
          />
        )}
        <div className="app-modal-actions">
          {cancelLabel && (
            <button className="app-modal-btn" onClick={onCancel}>
              {cancelLabel}
            </button>
          )}
          <button
            ref={confirmRef}
            className={`app-modal-btn primary${danger ? ' danger' : ''}`}
            onClick={submit}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
