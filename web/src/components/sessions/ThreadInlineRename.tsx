/**
 * One-line inline editor for a question's title (and, with `max` 280, its
 * takeaway): never `window.prompt` (C24). The text is selected on mount; Enter
 * or blur saves, Esc cancels. Saving an empty title hands '' to the caller,
 * which clears the user title so the AI / fallback title returns.
 *
 * Keys stop here: Esc must cancel the edit only (not pop the page or close the
 * drawer), and arrows / printable keys must not drive the tree under it.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { MicInput } from '@/components/common/BoxMic';

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
  // The words typed or dictated (the composer's mic sits in the box).
  const [text, setText] = useState(initial);
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
    // Enter is the box's send gate (onEnter): a title still being dictated is in before it saves.
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };

  return (
    <MicInput data-no-draft="rename"
      ref={ref}
      type="text"
      className={className ? `thread-inline-rename ${className}` : 'thread-inline-rename'}
      fieldClassName="mic-field-compact mic-field-grow"
      value={text}
      setText={setText}
      onEnter={save}
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
