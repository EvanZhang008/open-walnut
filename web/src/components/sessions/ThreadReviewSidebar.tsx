/**
 * The fullscreen review sidebar: one card per asked passage of the visible
 * conversation, beside its line like a comment in a document's review pane
 * (utils/review-sidebar.ts has the rules). Each card shows the newest question
 * as the chat's blue bubble, the answer's start or where it stands (colored by
 * the passage's mark state); the picked card opens up: a box to ask the next
 * follow-up right there, Enlarge (the question's full card, over this one) and
 * Quote in chat (2026-10-27, the user: "where is the ask question and enlarge
 * instead of open which jump to another place").
 *
 * Cards sit in a zero-height layer at the top of the scroll content, so they
 * scroll with the text. Their tops are written straight to the DOM after each
 * render and on a card's resize: one read of the heights, one write each.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type RefObject } from 'react';
import { typedUserText } from '@open-walnut/history-injected-banner';
import type { SessionHistoryMessage } from '@/types/session';
import type { ThreadMarkState } from '@/utils/thread-mark-state';
import { hasWords, questionBodyOf } from '@/utils/thread-card';
import { displayTitleOf, type ThreadMetaIndex } from '@/utils/thread-meta';
import type { ThreadTree } from '@/utils/thread-tree';
import { plainExcerpt, REVIEW_GAP, stackReviewCards } from '@/utils/review-sidebar';
import { stripQuestionTag } from '@/utils/question-tag';
import { ICON_EXPAND } from '@/components/common/Icons';
import { BoxMic, type BoxMicHandle } from '@/components/common/BoxMic';
import { useDraft } from '@/hooks/useDraft';
import { cardFollowUpPlaceholder } from './ThreadCommentCard';
import '@/styles/thread-review.css';

export interface ReviewEntry {
  key: string;
  number?: number;
  title: string;
  state: ThreadMarkState;
  question: string;
  answer: string;
  rounds: number;
}

const STATE_WORDS: Record<ThreadMarkState, string> = {
  waiting: 'Waiting',
  answering: 'Answering…',
  unread: 'New answer',
  failed: 'No answer',
  read: 'Answered',
  resolved: 'Archived',
};

interface TurnAt { at: number; user: SessionHistoryMessage; reply?: SessionHistoryMessage }

/** Every user row's turn by its id, in one pass: the row and its final reply
 *  (the card's rule, cardTurnsOf). Built once per messages change. */
export function reviewTurnIndex(messages: readonly SessionHistoryMessage[]): ReadonlyMap<string, TurnAt> {
  const out = new Map<string, TurnAt>();
  let open: TurnAt | undefined;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    if (m.role === 'user') {
      const id = m.sourceUuid ?? m.msgId ?? m.walnutMessageId;
      open = id ? { at: i, user: m } : undefined;
      if (id && open) out.set(id, open);
      continue;
    }
    if (open && m.role === 'assistant' && hasWords(m.text)) open.reply = m;
  }
  return out;
}

/** One entry per question with a measured passage, in the anchors' order,
 *  from the persisted rows (live words are laid over by withLiveAnswers). */
export function buildReviewEntries(a: {
  keys: readonly string[];
  tree: ThreadTree;
  metaIndex: ThreadMetaIndex;
  numbers: ReadonlyMap<string, number>;
  turns: ReadonlyMap<string, TurnAt>;
  markStates: ReadonlyMap<string, ThreadMarkState>;
}): ReviewEntry[] {
  const out: ReviewEntry[] = [];
  for (const key of a.keys) {
    const node = a.tree.byKey.get(key);
    if (!node) continue;
    let last: TurnAt | undefined;
    let rounds = 0;
    for (const id of node.turnIds) {
      const t = a.turns.get(id);
      if (!t) continue;
      rounds += 1;
      if (!last || t.at > last.at) last = t;
    }
    const number = a.numbers.get(key);
    out.push({
      key,
      ...(number !== undefined ? { number } : {}),
      title: displayTitleOf(node, a.metaIndex).title,
      state: a.markStates.get(key) ?? 'read',
      question: last ? plainExcerpt(questionBodyOf(typedUserText(last.user.text ?? '')), 240) : '',
      answer: answerExcerpt(last?.reply?.text ?? ''),
      rounds,
    });
  }
  return out;
}

/** The answer's start as the card shows it: the `[Qn]` reply tag gone, as in
 *  the question card's own conversation. */
export function answerExcerpt(text: string): string {
  // A streaming answer can hold only the start of its tag (`[Q`, `[Q1`).
  if (/^\s*(?:\*\*|__)?\[(?:Q\s?\d{0,5})?$/.test(text)) return '';
  return plainExcerpt(stripQuestionTag(text), 320);
}

/** The answers streaming now replace their entry's answer: only those entries
 *  change, nothing rescans the messages. */
export function withLiveAnswers(entries: ReviewEntry[], live: ReadonlyMap<string, string>): ReviewEntry[] {
  if (live.size === 0) return entries;
  return entries.map((e) => {
    const text = live.get(e.key);
    return text === undefined ? e : { ...e, answer: answerExcerpt(text) };
  });
}

/** A question just sent (not in history yet) is its card's newest question;
 *  its answer is still to come. */
export function withSentQuestions(entries: ReviewEntry[], sent: ReadonlyMap<string, string>): ReviewEntry[] {
  if (sent.size === 0) return entries;
  return entries.map((e) => {
    const text = sent.get(e.key);
    if (text === undefined) return e;
    const question = plainExcerpt(questionBodyOf(typedUserText(text)), 240);
    return question && question !== e.question ? { ...e, question, answer: '' } : e;
  });
}

export interface ThreadReviewSidebarProps {
  layerRef: RefObject<HTMLDivElement | null>;
  entries: readonly ReviewEntry[];
  anchors: ReadonlyMap<string, number>;
  selected: string | null;
  /** The card itself: go to its passage (scroll + flash) and select it. */
  onActivate: (key: string) => void;
  /** The question's full card, opened over this one. */
  onEnlarge: (key: string) => void;
  onQuote: (key: string) => void;
  /** The question whose full card is open over its review card (this one hides). */
  enlarged: string | null;
  canAsk: boolean;
  sendToQuestion: (key: string, text: string) => Promise<boolean>;
  draftKeyOf: (key: string) => string;
  /** Each shown card's element by its key (the pane reads it: an enlarged card lies over it). */
  cardsRef: RefObject<Map<string, HTMLDivElement>>;
  /** The card whose box takes focus as it shows (back from its enlarged card). */
  focusKey: string | null;
}

/** The picked card's follow-up box: the same draft as the question's full card
 *  (one question, one set of unsent words), Enter sends, Shift+Enter a new line. */
const ReviewCardComposer = memo(function ReviewCardComposer(p: {
  threadKey: string; title: string; draftKey: string; canAsk: boolean; focusOnShow: boolean;
  send: (key: string, text: string) => Promise<boolean>;
}) {
  const draft = useDraft(p.draftKey);
  const { text, setText } = draft;
  const [sending, setSending] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement | null>(null);
  const mic = useRef<BoxMicHandle | null>(null);
  // Back from the enlarged card: the reader carries on typing here.
  useEffect(() => { if (p.focusOnShow) boxRef.current?.focus({ preventScroll: true }); }, [p.focusOnShow]);
  // Grows with its text, up to four lines (20px each, 6px of padding).
  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, 4 * 20 + 6)}px`;
  }, [text]);
  const send = async () => {
    const t = text.trim();
    if (!t || sending || !p.canAsk) return;
    setSending(true);
    const sentKey = draft.key;
    try {
      if (await p.send(p.threadKey, t)) { mic.current?.clear(); draft.clear(sentKey, t); }
    } finally {
      setSending(false);
      boxRef.current?.focus({ preventScroll: true });
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Esc leaves the box, one layer at a time: never the fullscreen under it.
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); boxRef.current?.blur(); return; }
    // keyCode 229: WebKit's Enter that picks an IME candidate reports isComposing false.
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing && e.keyCode !== 229) { e.preventDefault(); void send(); }
  };
  const placeholder = p.canAsk ? cardFollowUpPlaceholder(p.title) : 'This engine cannot take questions';
  return (
    <div className="thread-card-composer thread-review-composer">
      <textarea
        ref={boxRef}
        className="thread-card-input"
        data-draft-key={draft.key ?? undefined}
        rows={1}
        value={text}
        placeholder={placeholder}
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
  );
});

function answerLine(e: ReviewEntry): string {
  if (e.state === 'waiting') return 'Waiting for an answer…';
  if (e.state === 'failed' && !e.answer) return 'No answer came back.';
  return e.answer || (e.state === 'answering' ? 'Answering…' : 'No answer text.');
}

export const ThreadReviewSidebar = memo(function ThreadReviewSidebar(p: ThreadReviewSidebarProps) {
  const cards = p.cardsRef;
  const pRef = useRef(p);
  pRef.current = p;

  // eslint-disable-next-line react-hooks/exhaustive-deps -- the map is the pane's, stable
  const place = useCallback(() => {
    const cur = pRef.current;
    const items = [];
    for (const e of cur.entries) {
      const el = cards.current.get(e.key);
      const anchor = cur.anchors.get(e.key);
      if (el && anchor !== undefined) items.push({ key: e.key, anchor, height: el.offsetHeight });
    }
    const tops = stackReviewCards(items, REVIEW_GAP, cur.selected);
    for (const [key, top] of tops) {
      const el = cards.current.get(key);
      if (el && el.style.top !== `${top}px`) el.style.top = `${top}px`;
    }
  }, []);
  useLayoutEffect(place);
  // A card grows (an answer streaming in, fonts loading): place again, once a frame.
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); });
    for (const el of cards.current.values()) ro.observe(el);
    return () => { ro.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [p.entries, place]);

  const refFor = useCallback((key: string) => (el: HTMLDivElement | null) => {
    if (el) cards.current.set(key, el); else cards.current.delete(key);
  }, []);
  const onCardClick = (key: string) => (e: MouseEvent) => {
    // A control or the box: not a trip to the passage.
    if ((e.target as Element).closest('button, textarea, .thread-review-composer')) return;
    p.onActivate(key);
  };

  return (
    <div ref={p.layerRef} className="thread-review-layer" data-testid="thread-review">
      {p.entries.filter((e) => p.anchors.has(e.key)).map((e) => (
        <div
          key={e.key}
          ref={refFor(e.key)}
          className="thread-review-card"
          data-thread-key={e.key}
          data-state={e.state}
          data-selected={p.selected === e.key ? 'true' : undefined}
          data-enlarged={p.enlarged === e.key ? 'true' : undefined}
          role="group"
          aria-label={`Question ${e.number ?? ''}: ${e.title}`.replace(/\s+/g, ' ')}
          onClick={onCardClick(e.key)}
        >
          {/* The card's one activatable control (a click anywhere on the card
              does the same for the mouse): go to the passage, pick the card. */}
          <button
            type="button"
            className="thread-review-head"
            aria-pressed={p.selected === e.key}
            aria-label={`Go to question ${e.number ?? ''}: ${e.title}, ${STATE_WORDS[e.state]}`.replace(/\s+/g, ' ')}
            onClick={(ev) => { ev.stopPropagation(); p.onActivate(e.key); }}
          >
            {e.number !== undefined && <span className="thread-map-num" aria-hidden="true">{e.number}</span>}
            <span className="thread-review-title" title={e.title}>{e.title}</span>
            <span className="thread-review-state">{STATE_WORDS[e.state]}</span>
          </button>
          {e.question && <div className="session-msg session-msg-user thread-review-q"><span className="thread-review-q-text">{e.question}</span></div>}
          <div className="thread-review-a">{answerLine(e)}</div>
          <div className="thread-review-actions">
            {e.rounds > 1 && <span className="thread-review-rounds">{e.rounds} rounds</span>}
            <button
              type="button" className="thread-review-btn thread-review-enlarge" onClick={() => p.onEnlarge(e.key)}
              title="The whole conversation, here" aria-label={`Enlarge question ${e.number ?? ''}`.trim()}
            >
              {ICON_EXPAND}<span>Enlarge</span>
            </button>
            <button type="button" className="thread-review-btn" onClick={() => p.onQuote(e.key)} title="Write your next chat message to this question">Quote in chat</button>
          </div>
          {p.selected === e.key && p.enlarged !== e.key && (
            <ReviewCardComposer
              threadKey={e.key} title={e.title} draftKey={p.draftKeyOf(e.key)} canAsk={p.canAsk}
              focusOnShow={p.focusKey === e.key} send={p.sendToQuestion}
            />
          )}
        </div>
      ))}
    </div>
  );
});
