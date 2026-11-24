/**
 * The one search field: a magnifier, the words, then its keys (the hit count, the clear key, the
 * mic), all drawn by styles/input-box.css ("Fields", `wn-field`) as the message box
 * is: one corner, fill, edge and focus, 34 px tall (28 px with `small`, beside `.btn-sm`).
 *
 * 2026-11-21 UI audit: the Home, Display menu, Mail, Apps, Memory and Settings searches each drew
 * their own (an underlined bar, a flat bar, a tall white box, a darker bar, a round clear key).
 * A new search uses this; standard.md "Inputs".
 *
 * It is a MicInput, so typing, voice input, Enter and blur waiting for dictated words all work as
 * there. Esc and the keys a page binds stay the owner's (`onKeyDown`); the clear key shows while
 * there are words and runs `onClear`, then puts the caret back in the field.
 *
 * A search still running turns the magnifier into the busy ring, in the same slot: the words keep the
 * width they have when it ends (2026-11-24: in a 25% Home panel a ring beside the keys left the
 * typed words 50 px while the search ran, 74 px once it ended).
 */
import { useRef, type PointerEvent, type ReactNode, type Ref } from 'react';
import { MicInput, type MicInputProps } from '@/components/common/BoxMic';
import { ICON_CLOSE, ICON_SEARCH } from '@/components/common/Icons';

export interface SearchFieldProps extends Omit<MicInputProps, 'before' | 'after' | 'compact'> {
  /** A search still running: the ring in the leading icon's slot, never a key of its own. */
  busy?: boolean;
  /** The ring's own class, a hook for tests (`todo-search-spinner`). */
  busyClassName?: string;
  /** Hits, shown at the right while there are words. Leave it out where another row already shows them. */
  count?: number | null;
  countTitle?: string;
  /** The clear key (shown while there are words). Without it the field has none. */
  onClear?: () => void;
  /** Show the clear key also with no words: a search still applied after its words were deleted (Mail). */
  showClear?: boolean;
  clearLabel?: string;
  /** The clear key's own class, a hook for tests and callers (`todo-search-clear`). */
  clearClassName?: string;
  clearTestId?: string;
  /** 28 px tall, for a row of small buttons (a toolbar, Settings). */
  small?: boolean;
  /** The leading glyph; the magnifier by default. */
  icon?: ReactNode;
}

export function SearchField({ busy, busyClassName, count, countTitle, onClear, showClear, clearLabel = 'Clear search', clearClassName, clearTestId, small, icon = ICON_SEARCH, fieldClassName, ref, value, ...input }: SearchFieldProps) {
  const box = useRef<HTMLInputElement | null>(null);
  const setRefs = (el: HTMLInputElement | null) => {
    box.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) (ref as { current: HTMLInputElement | null }).current = el;
  };
  const cls = ['wn-field', small ? 'is-sm' : '', fieldClassName].filter(Boolean).join(' ');
  const focusBox = (e: PointerEvent) => { e.preventDefault(); box.current?.focus(); };
  return (
    <MicInput
      {...input}
      ref={setRefs as Ref<HTMLInputElement>}
      value={value}
      fieldClassName={cls}
      before={<span className="wn-field-icon" aria-hidden="true" onPointerDown={focusBox}>
        {busy ? <span className={busyClassName ? `wn-field-busy ${busyClassName}` : 'wn-field-busy'} /> : icon}
      </span>}
      after={<>
        {value && count != null && <span className="wn-field-count" title={countTitle}>{count}</span>}
        {(value || showClear) && onClear && (
          <button
            type="button"
            className={clearClassName ? `wn-field-key ${clearClassName}` : 'wn-field-key'}
            aria-label={clearLabel}
            title={clearLabel}
            data-testid={clearTestId}
            onClick={() => { onClear(); box.current?.focus({ preventScroll: true }); }}
          >
            {ICON_CLOSE}
          </button>
        )}
      </>}
    />
  );
}
