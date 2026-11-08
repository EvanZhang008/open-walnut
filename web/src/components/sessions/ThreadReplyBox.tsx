/**
 * A question's reply box: type (or dictate, or paste a picture) and send a
 * follow-up into that question, the open card's composer in a box of its own.
 * Every Ask here card that shows a question's conversation has one: the review
 * column's cards beside the conversation (ThreadReviewSidebar) as much as the
 * open card (ThreadCommentCard) (2026-11-08, the user: the side comments are
 * Ask here and "should have an input box"; a review card showed the answer and
 * no way to reply). Its words are the question's composer draft (`draftKey`),
 * so the open card over it and this box hold the same unsent words.
 */
import { memo, useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';
import { useImageAttachments } from '@/components/common/image-attachments';
import { AttachPictureButton, PictureStrip, usePictureInput } from '@/components/common/PictureStrip';
import type { ImageAttachment } from '@/api/chat';
import { useDraft } from '@/hooks/useDraft';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import '@/styles/thread-card.css';

export interface ThreadReplyBoxProps {
  /** The question's composer draft key (null: the words live in the box alone). */
  draftKey: string | null;
  canAsk: boolean;
  placeholder: string;
  onSend: (text: string, images?: ImageAttachment[]) => Promise<boolean> | boolean;
  /** The box took the keyboard (the owner picks its card). */
  onFocus?: () => void;
  /** Esc in the box (default: the box lets the keyboard go). */
  onEscape?: () => void;
  /** After a send went through (the owner scrolls the conversation to its end). */
  onSent?: () => void;
}

export const ThreadReplyBox = memo(function ThreadReplyBox(p: ThreadReplyBoxProps) {
  const draft = useDraft(p.draftKey);
  const { text, setText } = draft;
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const mic = useRef<BoxMicHandle | null>(null);
  const pictures = useImageAttachments();
  const pictureInput = usePictureInput(pictures, p.canAsk);

  // Up to five lines, then it scrolls.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 5 * 20 + 12)}px`;
  }, [text]);
  // A recording still running belongs to the question the box was for.
  useEffect(() => () => { mic.current?.clear(); }, [p.draftKey]);

  const send = useCallback(async () => {
    const t = text.trim();
    const images = pictures.images;
    if ((!t && images.length === 0) || sending || !p.canAsk) return;
    setSending(true);
    const sentKey = draft.key;
    try {
      const ok = await p.onSend(t, images.length ? images : undefined);
      if (ok) {
        // A transcription landing after the send would repeat what was just sent.
        mic.current?.clear();
        pictures.clear();
        draft.clear(sentKey, t);
        p.onSent?.();
      }
    } finally {
      setSending(false);
      // Once the box is enabled again (focus on a disabled box goes nowhere).
      refocus.current = true;
    }
  }, [text, sending, p, draft, pictures]);
  // Send (button or Enter) while the mic is recording waits for its last words.
  const gate = useSendAfterDictation([mic], () => { void send(); });
  // The keyboard back in the box after a send: done once the box is enabled
  // again (2026-11-08: focused while still disabled, it fell to the page, and
  // Esc no longer closed the card).
  const refocus = useRef(false);
  useEffect(() => {
    if (sending || !refocus.current) return;
    refocus.current = false;
    boxRef.current?.focus({ preventScroll: true });
  }, [sending]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc leaves the box (its words stay): one Esc, one layer, never also the
    // full screen around it.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (p.onEscape) p.onEscape();
      else boxRef.current?.blur();
      return;
    }
    // keyCode 229: WebKit's Enter that picks an IME candidate reports isComposing false.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) {
      e.preventDefault();
      gate.send();
    }
  };

  const label = p.canAsk ? p.placeholder : 'This engine cannot take questions';
  return (
    <>
      <PictureStrip pictures={pictures} className="thread-card-pictures" testId="thread-card-pictures" />
      <div className={`thread-card-composer${pictureInput.dragOver ? ' is-drag-over' : ''}`} data-testid="thread-reply-box" {...pictureInput.dropProps}>
        <textarea
          ref={boxRef}
          className="thread-card-input"
          data-draft-key={draft.key ?? undefined}
          rows={1}
          value={text}
          placeholder={label}
          disabled={!p.canAsk || sending}
          aria-label={p.placeholder}
          onChange={(e) => setText(e.target.value)}
          onPaste={pictureInput.onPaste}
          onKeyDown={onKeyDown}
          onFocus={p.onFocus}
          // Written at once as the keyboard leaves (a press on the card's head
          // opens the card, which reads the draft as it mounts): never left on
          // the debounce for the card to miss (macOS WebKit, 2026-11-08).
          onBlur={draft.flush}
        />
        <AttachPictureButton pictures={pictures} className="thread-card-attach" testId="thread-card-attach" disabled={!p.canAsk || sending} />
        <BoxMic className="thread-card-mic" boxRef={boxRef} text={text} setText={setText} handleRef={mic} disabled={!p.canAsk || sending} />
        <button
          type="button"
          className="thread-card-send"
          aria-label="Send"
          disabled={(!text.trim() && pictures.images.length === 0 && !gate.micBusy && !gate.waiting) || sending || !p.canAsk}
          onClick={gate.send}
          {...dictationWaitProps(gate, 'Send (Enter)')}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </>
  );
});
