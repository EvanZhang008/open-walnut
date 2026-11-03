/**
 * The Talk to CEO box (utils/content-actions.ts `openCeoComposer`): the person writes what they
 * want to tell the CEO, the item rides along as attached context, and Send sends both. Nothing is
 * sent before Send (2026-11-03, the user: "I definitely have something to say ... at least give me
 * an input box"). One box for every surface (the Mail reader, an Inbox letter, a plugin's buttons or
 * menu), rendered once by ContentActionsHost. It opens below the point it was asked from, or in the
 * middle of the window when there is none.
 *
 * The words are Walnut's AnswerBox (the composer's look, the mic inside, pictures pasted, dropped or
 * attached as in the chat), and the pictures go to the CEO with the words. The words are kept in the
 * draft store per piece of content, so a box closed by mistake (or a reload) opens again with them;
 * its pictures are kept while the page lives. Enter makes a new line, Cmd/Ctrl+Enter or Send sends
 * (as the Org thread's Follow up, the other box with its own Send row).
 */
import { useEffect, useRef, useState } from 'react';
import { useMenuPlacement } from '@/hooks/useMenuPlacement';
import { useDraft } from '@/hooks/useDraft';
import { useSendAfterDictation, dictationWaitProps } from '@/hooks/useSendAfterDictation';
import { AnswerBox } from '@/components/common/AnswerBox';
import type { BoxMicHandle } from '@/components/common/BoxMic';
import { useImageAttachments } from '@/components/common/image-attachments';
import type { ImageAttachment } from '@/api/chat';
import { draftHash, draftKey } from '@/utils/drafts';
import { CEO_NOTE_MAX, sendToCeo, type CeoComposerRequest } from '@/utils/content-actions';
import '@/styles/content-actions.css';

// One kept note per piece of content: two mails with one subject are two items.
const keyOf = ({ item }: CeoComposerRequest) => draftKey('ceo-note', draftHash([item.source, item.title, item.open, item.url, item.from, item.at].join('\n')));
/** The pictures of a box closed without a send, by its draft key, while the page lives. */
const keptPictures = new Map<string, ImageAttachment[]>();

export function CeoComposer({ req, onClose }: { req: CeoComposerRequest; onClose(sent: boolean): void }) {
  const key = keyOf(req);
  const draft = useDraft(key);
  const note = draft.text;
  const pictures = useImageAttachments();
  const mic = useRef<BoxMicHandle | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const noTrigger = useRef<HTMLElement>(null);

  // Pictures of an earlier open of this item come back; the current ones are kept for the next.
  const { set: setPictures, images } = pictures;
  useEffect(() => {
    const kept = keptPictures.get(key);
    if (kept) setPictures(kept);
  }, [key, setPictures]);
  useEffect(() => {
    if (images.length > 0) keptPictures.set(key, images);
    else keptPictures.delete(key);
  }, [key, images]);
  const placement = useMenuPlacement(!!req.anchor, noTrigger, boxRef, {
    anchorPoint: req.anchor, align: 'left', edgeOverflow: 'clamp', gap: 4, minHeight: 200,
  });

  // Focus once it is placed (a box still hidden for measuring cannot take focus), and again after
  // a send that failed (the caret goes back where it was).
  const shown = !req.anchor || placement !== null;
  useEffect(() => {
    if (sending || !shown) return;
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    if (!error) el.setSelectionRange(el.value.length, el.value.length);
  }, [sending, error, shown]);

  // Outside a click or Escape closes it (what was typed is kept); a send in flight finishes first.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const target = e.target as Node;
      // The button it came from closes it itself (a press there toggles it).
      if (sending || boxRef.current?.contains(target) || req.owner?.contains(target)) return;
      onClose(false);
    };
    // Escape that ends an IME composition is the input method's, not a close.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !sending && !e.isComposing && e.keyCode !== 229) { e.stopPropagation(); onClose(false); }
    };
    document.addEventListener('pointerdown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
  }, [onClose, sending, req.owner]);

  const words = note.trim();
  const send = () => {
    if (!words || sending) return;
    setSending(true);
    setError(null);
    const sentKey = draft.key;
    const sentPictures = pictures.images;
    sendToCeo(req.item, words, sentPictures).then(
      () => { draft.clear(sentKey, note); keptPictures.delete(key); pictures.clear(); onClose(true); },
      (err: unknown) => { setSending(false); setError(err instanceof Error && err.message ? err.message : 'Not sent'); },
    );
  };
  // Cmd/Ctrl+Enter and Send wait for a live dictation's words, then send.
  const gate = useSendAfterDictation([mic], send, key);

  const { item } = req;
  const from = [item.from, item.where].filter(Boolean).join(' · ');
  return (
    <div
      ref={boxRef}
      className={`ceo-composer${req.anchor ? '' : ' ceo-composer-centered'}`}
      role="dialog"
      aria-label="Talk to CEO"
      data-testid="ceo-composer"
      // A portal under the page: keep a drag or a row's own click handler from taking this press.
      onPointerDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={req.anchor
        ? placement
          ? { top: placement.top, right: placement.right, maxHeight: placement.maxHeight }
          : { visibility: 'hidden', top: 0, left: 0 }
        : undefined}
    >
      <div className="ceo-composer-head">
        <span>Talk to CEO</span>
        <button type="button" className="ceo-composer-close" aria-label="Close" disabled={sending} onClick={() => onClose(false)}>×</button>
      </div>
      <AnswerBox
        boxRef={inputRef}
        micRef={mic}
        className="ceo-composer-answer"
        testId="ceo-composer-input"
        draftKey={draft.key}
        pictures={pictures}
        minRows={3}
        maxRows={10}
        maxLength={CEO_NOTE_MAX}
        placeholder="What do you want to tell the CEO about this?"
        value={note}
        readOnly={sending}
        onChange={draft.setText}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) { e.preventDefault(); gate.send(); }
        }}
      />
      <div className="ceo-composer-attached" data-testid="ceo-composer-attached" title="Sent with your message as context">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M10.5 4.5 5.8 9.2a1.6 1.6 0 0 0 2.3 2.3l5-5a3 3 0 0 0-4.3-4.3l-5 5a4.4 4.4 0 0 0 6.2 6.2l4-4"/></svg>
        <span className="ceo-composer-source">{item.source}</span>
        <span className="ceo-composer-title">{item.title}</span>
        {from && <span className="ceo-composer-from">{from}</span>}
      </div>
      {error && <div className="ceo-composer-error" role="alert">{error}</div>}
      <div className="ceo-composer-foot">
        <span className="ceo-composer-hint">⌘↵ to send</span>
        <button type="button" className="content-action-btn" disabled={sending} onClick={() => onClose(false)}>Cancel</button>
        <button type="button" className="content-action-btn ceo-composer-send" data-testid="ceo-composer-send" disabled={(!words && !gate.micBusy && !gate.waiting) || sending} onClick={gate.send} {...dictationWaitProps(gate)}>
          {sending ? 'Sending…' : 'Send'}
        </button>
      </div>
    </div>
  );
}
