/**
 * One-line inline editor for a question's title (and, with `max` 280, its
 * takeaway): never `window.prompt` (C24). The text is selected on mount; Enter
 * or blur saves, Esc cancels. Saving an empty title hands '' to the caller,
 * which clears the user title so the AI / fallback title returns.
 *
 * Keys stop here: Esc must cancel the edit only (not pop the page or close the
 * drawer), and arrows / printable keys must not drive the tree under it.
 */
import { useEffect, useRef, type KeyboardEvent } from 'react';

export interface ThreadInlineRenameProps {
  initial: string;
  max: number;
  ariaLabel: string;
  className?: string;
  placeholder?: string;
  onSave: (text: string) => void;
  onCancel: () => void;
}

export function ThreadInlineRename({ initial, max, ariaLabel, className, placeholder, onSave, onCancel }: ThreadInlineRenameProps) {
  const ref = useRef<HTMLInputElement | null>(null);
  // Enter saves AND blurs; the blur must not save a second time.
  const settled = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus({ preventScroll: true });
    el.select();
  }, []);

  const save = () => {
    if (settled.current) return;
    settled.current = true;
    const text = (ref.current?.value ?? '').trim().slice(0, max);
    if (text === initial.trim()) onCancel();
    else onSave(text);
  };
  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    e.stopPropagation();
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') { e.preventDefault(); save(); }
    else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  return (
    <input
      ref={ref}
      type="text"
      className={className ? `thread-inline-rename ${className}` : 'thread-inline-rename'}
      defaultValue={initial}
      maxLength={max}
      aria-label={ariaLabel}
      placeholder={placeholder}
      spellCheck={false}
      onKeyDown={onKeyDown}
      onBlur={save}
      onClick={(e) => e.stopPropagation()}
      onDoubleClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
    />
  );
}
