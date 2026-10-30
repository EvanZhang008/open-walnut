/**
 * The fullscreen review sidebar: one card per asked passage of the visible
 * conversation, beside its line like a comment in a document's review pane
 * (utils/review-sidebar.ts has the rules). A card is one compact row until it
 * is opened: its number, title and where its answer stands (colored by the
 * passage's mark state), with the answer's start as its tooltip. A click (or
 * Enter, or a click on its passage) opens the question's full card over it:
 * every round in full, scrollable, with its own box and a full-screen button
 * (2026-10-29, the user: "没点之前，不需要扩展这么大", and the whole thread
 * readable once opened, like a comment in a code review).
 *
 * Cards sit in a zero-height layer at the top of the scroll content, so they
 * scroll with the text. Their tops are written straight to the DOM after each
 * render and on a card's resize: one read of the heights, one write each.
 */
import { memo, useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import { typedUserText } from '@open-walnut/history-injected-banner';
import type { SessionHistoryMessage } from '@/types/session';
import type { ThreadMarkState } from '@/utils/thread-mark-state';
import { hasWords, questionBodyOf } from '@/utils/thread-card';
import { displayTitleOf, type ThreadMetaIndex } from '@/utils/thread-meta';
import type { ThreadTree } from '@/utils/thread-tree';
import { plainExcerpt, REVIEW_GAP, stackReviewCards } from '@/utils/review-sidebar';
import { stripQuestionTag } from '@/utils/question-tag';
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
  /** The card itself: open the question's full card over it. */
  onOpen: (key: string) => void;
  /** The question whose full card is open over its review card (this one hides). */
  enlarged: string | null;
  /** Each shown card's element by its key (the pane reads it: an open card lies over it). */
  cardsRef: RefObject<Map<string, HTMLDivElement>>;
}

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
  // A card's size changes (fonts loading, a title named): place again, once a frame.
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
        >
          {/* The whole row is the card's one control: open the question. */}
          <button
            type="button"
            className="thread-review-head"
            aria-haspopup="dialog"
            aria-expanded={p.enlarged === e.key}
            aria-label={`Open question ${e.number ?? ''}: ${e.title}, ${STATE_WORDS[e.state]}`.replace(/\s+/g, ' ')}
            title={answerLine(e)}
            onClick={() => p.onOpen(e.key)}
          >
            {e.number !== undefined && <span className="thread-map-num" aria-hidden="true">{e.number}</span>}
            <span className="thread-review-title">{e.title}</span>
            {e.rounds > 1 && <span className="thread-review-rounds" aria-hidden="true">{e.rounds}</span>}
            <span className="thread-review-state">{STATE_WORDS[e.state]}</span>
          </button>
        </div>
      ))}
    </div>
  );
});
