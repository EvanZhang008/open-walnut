/**
 * The comment card (Conversation Mode): one question beside the passage it is
 * about, the way a comment sits beside a line in a document. It shows the
 * question's turns (each question and the answer's prose, tools left to the
 * timeline), the answer still arriving, and a composer that asks the next
 * follow-up into the same question. A pending question (an Ask just made) is
 * the card in its draft state: the composer alone, focused.
 *
 * Placement is the owner's (SessionChatHistory measures the passage); this file
 * is the card's shape and behaviour. Esc closes it; the number, title and
 * status word are the same ones the sidebar and the turn label show.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { ThreadViewStatus } from '@/utils/thread-meta';
import { ThreadStatusWord } from './ThreadStatusWord';
import { ThreadCloseIcon } from './ThreadIcons';
import '@/styles/thread-card.css';

export const CARD_ASK_PLACEHOLDER = 'Ask about this passage…';
export const cardFollowUpPlaceholder = (title: string): string => {
  const t = title.trim();
  const short = t.length > 36 ? `${t.slice(0, 35).trimEnd()}…` : t;
  return short ? `Reply in “${short}”…` : 'Follow up…';
};

export interface ThreadCommentCardProps {
  /** The question (or the pending page) the card shows. */
  threadKey: string;
  /** No question yet: an Ask waiting for its first message. */
  draft: boolean;
  number: number | undefined;
  title: string;
  naming?: boolean;
  status: ThreadViewStatus | undefined;
  unread: boolean;
  /** The question's turns, rendered by the owner (the same row renderer the timeline uses). */
  children?: ReactNode;
  /** The answer is still arriving into this question. */
  answering: boolean;
  canAsk: boolean;
  /** The header's menu (the owner supplies the page menu). */
  menu?: ReactNode;
  onSend: (text: string) => Promise<boolean> | boolean;
  onClose: () => void;
  /** Where the card sits (content coordinates of its layer) and how tall it may grow. */
  style: { top: number; left: number; width: number; maxHeight: number };
}

export const ThreadCommentCard = memo(function ThreadCommentCard(p: ThreadCommentCardProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // A new question (or a draft) opens with the composer ready; the body starts
  // at its newest turn, where the answer is.
  useEffect(() => {
    setText('');
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
    if (p.draft || p.canAsk) boxRef.current?.focus({ preventScroll: true });
  }, [p.threadKey, p.draft, p.canAsk]);

  // Placed below a passage near the bottom of the box, the card would hang
  // under the fold: the smallest scroll that shows it whole (none when it is).
  useLayoutEffect(() => {
    cardRef.current?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [p.threadKey]);

  // The answer grows: follow it while the reader has not scrolled up.
  const pinned = useRef(true);
  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (body && pinned.current) body.scrollTop = body.scrollHeight;
  });
  const onBodyScroll = useCallback(() => {
    const body = bodyRef.current;
    if (!body) return;
    pinned.current = body.scrollHeight - body.scrollTop - body.clientHeight < 24;
  }, []);

  // The textarea grows with its text, up to five lines.
  const grow = useCallback(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 5 * 20 + 12)}px`;
  }, []);
  useEffect(() => { grow(); }, [text, grow]);

  const send = useCallback(async () => {
    const t = text.trim();
    if (!t || sending || !p.canAsk) return;
    setSending(true);
    try {
      const ok = await p.onSend(t);
      if (ok) { setText(''); pinned.current = true; }
    } finally {
      setSending(false);
      boxRef.current?.focus({ preventScroll: true });
    }
  }, [text, sending, p]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onClose(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const onCardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); p.onClose(); }
  };

  const placeholder = p.draft ? CARD_ASK_PLACEHOLDER : cardFollowUpPlaceholder(p.title);
  return (
    <div
      ref={cardRef}
      className="thread-card"
      role="dialog"
      aria-label={p.draft ? 'New question' : `Question ${p.number ?? ''}: ${p.title}`.trim()}
      data-thread-key={p.threadKey}
      data-draft={p.draft ? 'true' : undefined}
      data-answering={p.answering ? 'true' : undefined}
      style={{ top: p.style.top, left: p.style.left, width: p.style.width, ['--thread-card-maxh' as string]: `${p.style.maxHeight}px` }}
      onKeyDown={onCardKeyDown}
    >
      <div className="thread-card-head">
        {p.draft ? (
          <span className="thread-map-num thread-map-num--new" aria-hidden="true">
            <svg viewBox="0 0 10 10" width="8" height="8" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M5 1.5v7M1.5 5h7" /></svg>
          </span>
        ) : (
          p.number !== undefined && <span className="thread-map-num" aria-hidden="true">{p.number}</span>
        )}
        <span className="thread-card-title" title={p.title}>{p.draft ? 'New question' : p.title}</span>
        {p.naming && <span className="thread-naming">Naming…</span>}
        {!p.draft && <ThreadStatusWord status={p.status} unread={p.unread} className="thread-card-status" />}
        <span className="thread-card-head-actions">
          {p.menu}
          <button type="button" className="thread-card-close" aria-label="Close" title="Close (Esc)" onClick={p.onClose}>
            <ThreadCloseIcon size={12} />
          </button>
        </span>
      </div>
      {!p.draft && (
        <div ref={bodyRef} className="thread-card-body" onScroll={onBodyScroll}>
          {p.children}
          {p.answering && (
            <div className="thread-card-answering" role="status">
              <span className="session-streaming-dot" />
              Answering…
            </div>
          )}
        </div>
      )}
      <div className="thread-card-composer">
        <textarea
          ref={boxRef}
          className="thread-card-input"
          rows={1}
          value={text}
          placeholder={p.canAsk ? placeholder : 'This engine cannot take questions'}
          disabled={!p.canAsk || sending}
          aria-label={placeholder}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          className="thread-card-send"
          aria-label="Send"
          title="Send (Enter)"
          disabled={!text.trim() || sending || !p.canAsk}
          onClick={() => { void send(); }}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" /></svg>
        </button>
      </div>
    </div>
  );
});
