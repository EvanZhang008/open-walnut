/**
 * The box a person answers in, in their own words: an ask's "Other…", a letter's reply or note, a
 * correction's why (2026-10-31, the user, on the Org rail's answer box, translated: "add the voice box ...
 * don't use the native one ... use our Walnut input bar"). One look everywhere, the composer's: a rounded bar that grows
 * with the text up to its cap and then scrolls, no native resize grip, and the composer's mic inside
 * (BoxMic, the same dictation). Enter sends when the box has a send; Shift+Enter breaks the line.
 * tests/web/answer-box-guard.test.ts fails on a free-text answer box that is not this one.
 *
 * Words for an AI take pictures too, as the chat does (2026-11-03, the user: "the follow up in org
 * thread or anywhere ... should be able to copy pictures"): pass `pictures` (useImageAttachments) and
 * the box takes a pasted or dropped picture and has an attach button; the owner sends
 * `pictures.images` with the words. tests/web/answer-box-pictures-guard.test.ts fails on a box that
 * reaches an AI without it.
 */
import { useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';
import type { ImageAttachments } from '@/components/common/image-attachments';
import { AttachPictureButton, PictureStrip, usePictureInput } from '@/components/common/PictureStrip';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import '@/styles/answer-box.css';

export interface AnswerBoxProps {
  value: string;
  onChange: (text: string) => void;
  placeholder?: string;
  /** Enter (and the send button, when `sendLabel` is set) hands the trimmed words here. */
  onSubmit?: (text: string) => void;
  /** A send button at the bar's end, with these words. */
  sendLabel?: string;
  /** The send button's own state (an answer on its way); the box stays editable. */
  sending?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  /** Lines shown while empty (default 1). */
  minRows?: number;
  /** Lines it grows to before it scrolls (default 6). */
  maxRows?: number;
  ariaLabel?: string;
  testId?: string;
  sendTestId?: string;
  /** The draft the words are kept under, for the page's draft tools. */
  draftKey?: string | null;
  className?: string;
  /** A class on the textarea itself (a page's tests and zoom rules find the box by it). */
  inputClassName?: string;
  boxRef?: RefObject<HTMLTextAreaElement | null>;
  /** Cleared by the owner when the words are sent, so a late dictation never lands twice. */
  micRef?: RefObject<BoxMicHandle | null>;
  /** More controls at the bar's end, before the send. */
  children?: ReactNode;
  onKeyDown?: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void;
  onBlur?: () => void;
  id?: string;
  maxLength?: number;
  /** Shown, not editable (an answer on its way or settled); the mic is off too. */
  readOnly?: boolean;
  /** The pictures going with the words (useImageAttachments): paste, drop and attach take them. */
  pictures?: ImageAttachments;
}

const LINE_PX = 18;

export function AnswerBox({
  value, onChange, placeholder, onSubmit, sendLabel, sending, disabled, autoFocus, minRows = 1, maxRows = 6,
  ariaLabel, testId, sendTestId, draftKey, className, inputClassName, boxRef, micRef, children, onKeyDown, onBlur, id, maxLength, readOnly,
  pictures,
}: AnswerBoxProps) {
  const own = useRef<HTMLTextAreaElement>(null);
  const box = boxRef ?? own;
  const ownMic = useRef<BoxMicHandle | null>(null);
  const mic = micRef ?? ownMic;
  // Grow with the text up to maxRows, then scroll (WebKit before field-sizing needs this).
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, maxRows * LINE_PX + 8)}px`;
  }, [value, maxRows, box]);
  const takesPictures = !!pictures && !readOnly && !disabled;
  const hasPictures = !!pictures && pictures.images.length > 0;
  const pictureInput = usePictureInput(pictures, takesPictures);
  const submitNow = () => {
    const t = value.trim();
    if ((!t && !hasPictures) || disabled || sending || !onSubmit) return;
    onSubmit(t);
    mic.current?.clear();
  };
  // Enter and the send button wait for a live dictation's words, then send.
  const gate = useSendAfterDictation([mic], submitNow);
  const submit = gate.send;
  return (
    <div
      className={`answer-box${className ? ` ${className}` : ''}${disabled ? ' is-disabled' : ''}${hasPictures ? ' has-pictures' : ''}${pictureInput.dragOver ? ' is-drag-over' : ''}`}
      data-testid={testId ? `${testId}-box` : 'answer-box'}
      data-takes-pictures={pictures ? '' : undefined}
      {...pictureInput.dropProps}
    >
      {pictures && <PictureStrip pictures={pictures} className="answer-box-pictures" testId={testId ? `${testId}-pictures` : 'answer-box-pictures'} readOnly={readOnly} />}
      <textarea
        ref={box}
        id={id}
        maxLength={maxLength}
        readOnly={readOnly}
        className={`answer-box-input${inputClassName ? ` ${inputClassName}` : ''}`}
        data-testid={testId}
        data-draft-key={draftKey ?? undefined}
        rows={minRows}
        value={value}
        placeholder={placeholder}
        // An `id` means a <label htmlFor> names it; else the placeholder does.
        aria-label={ariaLabel ?? (id ? undefined : placeholder)}
        autoFocus={autoFocus}
        disabled={disabled}
        style={{ maxHeight: maxRows * LINE_PX + 8 }}
        onChange={(e) => onChange(e.target.value)}
        onPaste={pictureInput.onPaste}
        onBlur={onBlur}
        onKeyDown={(e) => {
          onKeyDown?.(e);
          if (e.defaultPrevented) return;
          if (onSubmit && e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); }
        }}
      />
      <span className="answer-box-tools">
        {pictures && !readOnly && (
          <AttachPictureButton pictures={pictures} className="answer-box-attach" testId={testId ? `${testId}-attach` : 'answer-box-attach'} disabled={disabled || sending} />
        )}
        <BoxMic boxRef={box} text={value} setText={onChange} handleRef={mic} disabled={disabled || sending || readOnly} />
        {children}
        {onSubmit && sendLabel && (
          <button type="button" className="btn btn-sm btn-primary answer-box-send" data-testid={sendTestId} disabled={disabled || sending || (!value.trim() && !hasPictures && !gate.micBusy && !gate.waiting)} onClick={submit} {...dictationWaitProps(gate)}>
            {sendLabel}
          </button>
        )}
      </span>
    </div>
  );
}
