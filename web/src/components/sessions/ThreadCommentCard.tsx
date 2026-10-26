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
 *
 * Expand (the header's ⤢) makes the card bigger where it is, for a long answer:
 * the same top below its passage, wider and taller as far as the owner's
 * `style.grown` reaches. Esc or the button again brings it back to its size;
 * × still closes it. An answer that is more than prose (a table, a diagram, a
 * model-drawn HTML box) opens expanded by itself, also when it arrives while the
 * card is open; once the reader sizes the card themselves, that choice holds for
 * this question.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { CardGrown } from '@/utils/thread-card';
import type { ThreadViewStatus } from '@/utils/thread-meta';
import { ICON_COLLAPSE, ICON_EXPAND } from '@/components/common/Icons';
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';
import { ThreadStatusWord } from './ThreadStatusWord';
import { ThreadCloseIcon } from './ThreadIcons';
import '@/styles/thread-card.css';

/** The grow animation (`.thread-card.is-sizing` in thread-card.css). */
const GROW_MS = 160;

/** Content that does not read at the card's resting width. */
const WIDE_CONTENT = '.markdown-body table, .markdown-body svg, .markdown-body iframe, iframe.rich-island, .markdown-body [style]';
/** Smaller than this, an <svg> is an icon (a pill, a button), not a diagram. */
const DIAGRAM_MIN_PX = 96;

export function hasWideContent(body: HTMLElement): boolean {
  for (const el of body.querySelectorAll<HTMLElement | SVGElement>(WIDE_CONTENT)) {
    if (el.closest('a, button')) continue;
    if (el.tagName.toLowerCase() === 'svg') {
      const r = el.getBoundingClientRect();
      if (r.width < DIAGRAM_MIN_PX && r.height < DIAGRAM_MIN_PX) continue;
    }
    return true;
  }
  return false;
}

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
  /** What the box opens with for a draft (words kept from an earlier visit). */
  initialText?: string;
  /** Every change of the box's text (the owner keeps an unsent Ask's words). */
  onTextChange?: (text: string) => void;
  /** Where the card sits (content coordinates of its layer) and how tall it may
   *  grow; `grown`, how far it reaches expanded (no ⤢ without it). */
  style: { top: number; left: number; width: number; maxHeight: number; grown?: CardGrown };
}

/** The scroll boxes around `el`, nearest first: the ones a scrollIntoView can move. */
function scrollBoxesOf(el: Element): Element[] {
  const out: Element[] = [];
  for (let n = el.parentElement; n; n = n.parentElement) {
    const oy = getComputedStyle(n).overflowY;
    if ((oy === 'auto' || oy === 'scroll') && n.scrollHeight > n.clientHeight) out.push(n);
  }
  const root = document.scrollingElement;
  if (root && !out.includes(root)) out.push(root);
  return out;
}

/** Undo a grow's scroll on every box still where the grow left it; empties the list. */
function restoreGrowScroll(list: Array<{ el: Element; before: number; after: number }>): void {
  for (const b of list.splice(0)) if (Math.abs(b.el.scrollTop - b.after) < 1) b.el.scrollTop = b.before;
}

export const ThreadCommentCard = memo(function ThreadCommentCard(p: ThreadCommentCardProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  // The question is dictated the way the composer's message is: into this box.
  const mic = useRef<BoxMicHandle | null>(null);
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const initialRef = useRef(p.initialText);
  initialRef.current = p.initialText;
  const [expanded, setExpanded] = useState(false);
  const expandedRef = useRef(expanded);
  expandedRef.current = expanded;
  const autoGrowRef = useRef<(glide: boolean) => void>(() => {});
  /** The reader pressed ⤢ or Esc on this question: no more automatic sizing. */
  const userSized = useRef(false);

  // A new question (or a draft) opens with the composer ready; the body starts
  // at its newest turn, where the answer is.
  // Before the first paint, so a card whose answer holds a table opens expanded
  // instead of gliding there from small (autoGrow below).
  useLayoutEffect(() => {
    // A recording still running belongs to the question left: it must not land here.
    mic.current?.clear();
    // A grow's scroll record belongs to the question left.
    grewScroll.current = [];
    setText(p.draft ? initialRef.current ?? '' : '');
    setExpanded(false);
    userSized.current = false;
    const body = bodyRef.current;
    if (body) body.scrollTop = body.scrollHeight;
    if (p.draft || p.canAsk) boxRef.current?.focus({ preventScroll: true });
    autoGrowRef.current(false);
  }, [p.threadKey, p.draft, p.canAsk]);

  const onTextChange = p.onTextChange;
  useEffect(() => { onTextChange?.(text); }, [text, onTextChange]);

  const [sizing, setSizing] = useState(false);
  const toggleExpanded = useCallback(() => { userSized.current = true; setSizing(true); setExpanded((v) => !v); }, []);
  // The box keeps the keyboard across a size change; once the glide is over, a
  // card grown below the fold is scrolled whole into view. Shrinking it, or closing
  // it grown, gives the reader back the place that scroll moved them from, unless
  // they scrolled since (2026-10-25: a grown card closed with the passage 43px off).
  const firstRender = useRef(true);
  const grewScroll = useRef<Array<{ el: Element; before: number; after: number }>>([]);
  useEffect(() => {
    if (firstRender.current) { firstRender.current = false; return; }
    if (p.canAsk) boxRef.current?.focus({ preventScroll: true });
    if (!expanded) restoreGrowScroll(grewScroll.current);
    const t = window.setTimeout(() => {
      setSizing(false);
      const card = cardRef.current;
      if (!expanded || !card) return;
      const boxes = scrollBoxesOf(card);
      const before = boxes.map((el) => el.scrollTop);
      card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      grewScroll.current = boxes.map((el, i) => ({ el, before: before[i], after: el.scrollTop })).filter((b) => b.before !== b.after);
    }, GROW_MS + 40);
    return () => window.clearTimeout(t);
  }, [expanded, p.canAsk]);
  useEffect(() => () => restoreGrowScroll(grewScroll.current), []);

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
      if (ok) {
        // A transcription landing after the send would repeat what was just sent.
        mic.current?.clear();
        setText('');
        pinned.current = true;
      }
    } finally {
      setSending(false);
      boxRef.current?.focus({ preventScroll: true });
    }
  }, [text, sending, p]);

  const g = p.style.grown;
  // Worth a button only when expanding gains real room.
  const canGrow = !!g && (g.width > p.style.width + 24 || g.maxHeight > p.style.maxHeight + 24);
  const grown = expanded && canGrow && g ? g : null;

  // A table or a diagram in the answer opens the card expanded: on open before
  // the first paint (no glide from small), and later with the glide when one
  // streams in. Checked again on every change of the body's content.
  const autoGrow = useCallback((glide: boolean) => {
    const body = bodyRef.current;
    if (!body || userSized.current || !canGrow) return;
    if (!hasWideContent(body)) return;
    if (glide && !expandedRef.current) setSizing(true);
    setExpanded(true);
  }, [canGrow]);
  autoGrowRef.current = autoGrow;
  // The resting width can change under an open card (the panel resized): a
  // card that could not grow before may now.
  useLayoutEffect(() => { autoGrow(false); }, [autoGrow]);
  useEffect(() => {
    const body = bodyRef.current;
    if (!body || typeof MutationObserver === 'undefined') return;
    let raf = 0;
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => autoGrow(true));
    });
    mo.observe(body, { childList: true, subtree: true });
    return () => { cancelAnimationFrame(raf); mo.disconnect(); };
  }, [p.threadKey, p.draft, autoGrow]);

  const onEscape = () => { if (grown) { userSized.current = true; setExpanded(false); } else p.onClose(); };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEscape(); return; }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
  };
  const onCardKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onEscape(); }
  };

  const placeholder = p.draft ? CARD_ASK_PLACEHOLDER : cardFollowUpPlaceholder(p.title);
  const box = grown
    ? { left: grown.left, width: grown.width, maxHeight: grown.maxHeight }
    : { left: p.style.left, width: p.style.width, maxHeight: p.style.maxHeight };
  return (
    <div
      ref={cardRef}
      className={`thread-card${grown ? ' is-expanded' : ''}${sizing ? ' is-sizing' : ''}`}
      role="dialog"
      aria-label={p.draft ? 'New question' : `Question ${p.number ?? ''}: ${p.title}`.trim()}
      data-thread-key={p.threadKey}
      data-draft={p.draft ? 'true' : undefined}
      data-answering={p.answering ? 'true' : undefined}
      data-expanded={grown ? 'true' : undefined}
      style={{ top: p.style.top, left: box.left, width: box.width, ['--thread-card-maxh' as string]: `${box.maxHeight}px` }}
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
          {canGrow && (
            <button
              type="button"
              className="thread-card-expand"
              aria-label={grown ? 'Shrink back' : 'Expand'}
              aria-pressed={!!grown}
              title={grown ? 'Back to its size (Esc)' : 'Expand'}
              onClick={toggleExpanded}
            >
              {grown ? ICON_COLLAPSE : ICON_EXPAND}
            </button>
          )}
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
        <BoxMic className="thread-card-mic" boxRef={boxRef} text={text} setText={setText} handleRef={mic} disabled={!p.canAsk || sending} />
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
