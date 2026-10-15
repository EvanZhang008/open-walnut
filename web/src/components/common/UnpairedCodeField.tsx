/**
 * The sign-in code form (spec 3.3): one field, its error line, one button.
 *
 * - Every keystroke and paste goes through formatSignInCode, so `abcd efgh`
 *   and a pasted `#pair=` link both show `ABCD-EFGH`. No maxLength: it would
 *   cut a pasted link before the formatter sees the code.
 * - autoComplete off, not one-time-code: iOS would offer the newest text
 *   message code above the keyboard, and one tap would spend a rate-limit try
 *   (counted per IP, which every tunnel client shares).
 * - Never submits on its own: two quick taps would count one wrong code twice.
 * - 300 ms after focus the form scrolls to the middle of what the keyboard
 *   leaves, so field, error line and button all stay above it.
 */
import { useEffect, useLayoutEffect, useRef, type FormEvent } from 'react';
import { formatSignInCode, isSubmittableSignInCode } from './sign-in-code';
import { SIGN_IN_BAD_CHARS } from './sign-in-copy';

export interface UnpairedCodeFieldProps {
  /** The display value (`ABCD-EFGH`); the owner keeps it. */
  value: string;
  onValueChange: (display: string) => void;
  /** The last refusal; cleared by the owner on any edit. */
  error: string | null;
  busy: boolean;
  /** The server refused this exact code (not a network failure): Sign in waits for an edit. */
  refused?: boolean;
  label: string;
  placeholder: string;
  submitLabel: string;
  busyLabel: string;
  onSubmit: (display: string) => void;
}

const ERROR_ID = 'unpaired-code-error-line';
const FOCUS_SCROLL_MS = 300;

export function UnpairedCodeField({
  value, onValueChange, error, busy, refused = false, label, placeholder, submitLabel, busyLabel, onSubmit,
}: UnpairedCodeFieldProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const scrollTimer = useRef<number | null>(null);
  const code = formatSignInCode(value);
  const shownError = error ?? (code.badChars ? SIGN_IN_BAD_CHARS : null);
  // A refused code stays refused until it is edited (N23): sending it again
  // would only spend another of the server's per-address attempts.
  const canSubmit = isSubmittableSignInCode(code) && !busy && !refused;

  // Caret to the end after every format: the code is short, nobody edits
  // its middle, and a reformat (a dash appearing) would otherwise strand it.
  useLayoutEffect(() => {
    const el = inputRef.current;
    if (!el || document.activeElement !== el) return;
    const end = el.value.length;
    if (el.selectionStart !== end || el.selectionEnd !== end) el.setSelectionRange(end, end);
  }, [value]);

  useEffect(() => () => {
    if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current);
  }, []);

  const onFocus = () => {
    // A focus from a label or a script lands the caret at the start; the code
    // is edited from its end. A tap then puts the caret where it landed.
    // WebKit restores its saved selection after the focus event, so check again
    // once the focus call is over.
    const toEnd = () => {
      const el = inputRef.current;
      if (el && document.activeElement === el && el.selectionStart === 0 && el.selectionEnd === 0 && el.value) {
        el.setSelectionRange(el.value.length, el.value.length);
      }
    };
    toEnd();
    queueMicrotask(toEnd);
    if (scrollTimer.current !== null) window.clearTimeout(scrollTimer.current);
    scrollTimer.current = window.setTimeout(() => {
      scrollTimer.current = null;
      formRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, FOCUS_SCROLL_MS);
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    onSubmit(code.display);
  };

  return (
    <form
      ref={formRef}
      className="unpaired-notice-form"
      onSubmit={submit}
      data-testid="unpaired-code-form"
      noValidate
    >
      <input
        ref={inputRef}
        className="unpaired-notice-input"
        type="text"
        value={value}
        onChange={(e) => onValueChange(formatSignInCode(e.target.value).display)}
        onFocus={onFocus}
        aria-label={label}
        placeholder={placeholder}
        inputMode="text"
        autoCapitalize="characters"
        autoCorrect="off"
        autoComplete="off"
        spellCheck={false}
        enterKeyHint="go"
        disabled={busy}
        aria-invalid={shownError ? true : undefined}
        aria-describedby={shownError ? ERROR_ID : undefined}
        data-testid="unpaired-code-input"
      />
      {shownError && (
        <p className="unpaired-notice-error" id={ERROR_ID} role="alert" data-testid="unpaired-code-error">
          {shownError}
        </p>
      )}
      <button
        type="submit"
        className="unpaired-notice-submit"
        disabled={!canSubmit}
        aria-busy={busy || undefined}
        data-testid="unpaired-code-submit"
      >
        {busy && <span className="unpaired-notice-spinner" aria-hidden="true" />}
        <span>{busy ? busyLabel : submitLabel}</span>
      </button>
    </form>
  );
}
