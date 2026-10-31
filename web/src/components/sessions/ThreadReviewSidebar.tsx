/**
 * The fullscreen review sidebar: one card per asked passage of the visible
 * conversation, beside its line like a comment in a document's review pane
 * (utils/review-sidebar.ts has the rules). A card is its head row (number,
 * title, where its answer stands, colored by the passage's mark state) over the
 * question's whole conversation, drawn as the open card draws it
 * (ThreadCardConversation), capped in height with its own scroll (thread-review.css)
 * (2026-10-31, the user: it "must show everything normally ... maybe a maximum
 * height, but people can scroll"; the one-row card of 2026-10-29 showed nothing).
 * The head (or Enter, or a click on its passage) opens the question's full card
 * over it, with its composer and a full-screen button.
 *
 * A thin vertical bar on the column's edge folds the column away and brings it
 * back (ThreadReviewBar; the choice is one preference, useReviewSidebarCollapsed).
 *
 * Cards sit in a zero-height layer at the top of the scroll content, so they
 * scroll with the text. Their tops are written straight to the DOM after each
 * render and on a card's resize: one read of the heights, one write each.
 */
import { memo, useCallback, useLayoutEffect, useRef, type ReactNode, type RefObject } from 'react';
import { typedUserText } from '@open-walnut/history-injected-banner';
import type { SessionHistoryMessage } from '@/types/session';
import type { ThreadMarkState } from '@/utils/thread-mark-state';
import { hasWords, questionBodyOf } from '@/utils/thread-card';
import { displayTitleOf, type ThreadMetaIndex } from '@/utils/thread-meta';
import type { ThreadTree } from '@/utils/thread-tree';
import { plainExcerpt, REVIEW_BODY_MAX, REVIEW_BODY_MIN, REVIEW_GAP, stackReviewCards } from '@/utils/review-sidebar';
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
  /** The column is open (folded: the layer stays, measured, with no card). */
  open: boolean;
  entries: readonly ReviewEntry[];
  /** A question's conversation, the open card's own (ThreadCardConversation). */
  renderBody: (key: string) => ReactNode;
  /** Re-renders the cards when a conversation changes (the body callback is stable). */
  bodySig: string;
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
    const layer = cur.layerRef.current;
    if (!layer) return;
    // The cards end where the conversation ends (2026-10-31 review: a tall card
    // beside the last answer stretched the scroller, so "scroll to bottom"
    // stopped in blank space). The end is the last row in the flow, read from
    // the end (the layers, the sticky bar and the arrow take no room).
    const origin = layer.getBoundingClientRect().top;
    let limit = Number.POSITIVE_INFINITY;
    for (let el = layer.parentElement?.lastElementChild as HTMLElement | null; el; el = el.previousElementSibling as HTMLElement | null) {
      if (el.offsetHeight === 0) continue;
      const pos = getComputedStyle(el).position;
      if (pos !== 'static' && pos !== 'relative') continue;
      limit = el.getBoundingClientRect().bottom - origin;
      break;
    }
    const shown = cur.entries.filter((e) => cards.current.has(e.key) && cur.anchors.has(e.key));
    // Natural sizes (each conversation up to the CSS cap), read without taking
    // the cap off: that would scroll a card being read back to its top.
    const parts = shown.map((e) => {
      const el = cards.current.get(e.key)!;
      const body = el.querySelector<HTMLElement>('.thread-review-body');
      if (!body) return { key: e.key, anchor: cur.anchors.get(e.key)!, head: el.offsetHeight, bodyH: 0, body, extra: 0 };
      if (body.style.display === 'none') body.style.display = '';
      const cs = getComputedStyle(body);
      // Padding and border around the content: max-height caps the content box.
      const extra = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
        + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
      const cssCap = Math.min(REVIEW_BODY_MAX, window.innerHeight * 0.55);
      const bodyH = Math.min(body.scrollHeight - (parseFloat(cs.paddingTop) || 0) - (parseFloat(cs.paddingBottom) || 0), cssCap) + extra;
      return { key: e.key, anchor: cur.anchors.get(e.key)!, head: el.offsetHeight - body.offsetHeight, bodyH, body, extra };
    });
    const stackWith = (cap: number) => stackReviewCards(
      parts.map((x) => ({ key: x.key, anchor: x.anchor, height: x.head + (cap >= REVIEW_BODY_MIN ? Math.min(x.bodyH, cap) : 0) })),
      REVIEW_GAP, cur.selected,
    );
    const bottomOf = (tops: Map<string, number>, cap: number) => {
      let bottom = 0;
      for (const x of parts) bottom = Math.max(bottom, (tops.get(x.key) ?? 0) + x.head + (cap >= REVIEW_BODY_MIN ? Math.min(x.bodyH, cap) : 0));
      return bottom;
    };
    // Crowded (more conversation than room beside it): every card gets the same
    // cap, the largest that keeps the stack inside the conversation; below
    // REVIEW_BODY_MIN a card is its head alone (it opens on a click).
    const most = Math.max(0, ...parts.map((x) => x.bodyH));
    let cap = most;
    let tops = stackWith(cap);
    if (bottomOf(tops, cap) > limit) {
      let lo = 0;
      let hi = most;
      while (hi - lo > 4) {
        const mid = Math.floor((lo + hi) / 2);
        if (bottomOf(stackWith(mid), mid) <= limit) lo = mid; else hi = mid;
      }
      cap = lo;
      tops = stackWith(cap);
    }
    for (const x of parts) {
      if (!x.body) continue;
      const hide = cap < REVIEW_BODY_MIN;
      const max = !hide && x.bodyH > cap ? `${Math.max(0, cap - x.extra)}px` : '';
      if (x.body.style.maxHeight !== max) x.body.style.maxHeight = max;
      const display = hide ? 'none' : '';
      if (x.body.style.display !== display) x.body.style.display = display;
    }
    for (const [key, top] of tops) {
      const el = cards.current.get(key);
      if (el && el.style.top !== `${top}px`) el.style.top = `${top}px`;
    }
  }, []);
  useLayoutEffect(place);
  // A card's size changes (fonts loading, an answer growing): place again, once
  // a frame. Observed again only when the set of cards changes.
  const cardSet = p.open ? p.entries.filter((e) => p.anchors.has(e.key)).map((e) => e.key).join('\u0001') : '';
  useLayoutEffect(() => {
    if (typeof ResizeObserver === 'undefined') return;
    let raf = 0;
    const ro = new ResizeObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); });
    for (const el of cards.current.values()) ro.observe(el);
    // A row added or removed moves where the cards must end.
    const box = p.layerRef.current?.parentElement;
    const mo = new MutationObserver(() => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); });
    if (box) mo.observe(box, { childList: true });
    return () => { ro.disconnect(); mo.disconnect(); if (raf) cancelAnimationFrame(raf); };
  }, [cardSet, place, p.layerRef]);

  const refFor = useCallback((key: string) => (el: HTMLDivElement | null) => {
    if (el) cards.current.set(key, el); else cards.current.delete(key);
  }, []);

  return (
    <div ref={p.layerRef} className="thread-review-layer" data-testid="thread-review">
      {p.open && p.entries.filter((e) => p.anchors.has(e.key)).map((e) => (
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
          <div
            className="thread-card-body thread-review-body"
            data-testid="thread-review-body"
            role="region"
            aria-label={`Question ${e.number ?? ''}: ${e.title}, conversation`.replace(/\s+/g, ' ')}
            tabIndex={0}
          >
            {p.renderBody(e.key)}
          </div>
        </div>
      ))}
    </div>
  );
});

export interface ThreadReviewBarProps {
  collapsed: boolean;
  /** Cards on screen, shown on the folded bar. */
  count: number;
  onToggle: () => void;
}

/**
 * The vertical bar on the sidebar's edge: sticky in the scroller (top 0 of its
 * content box, so below the glass header), as tall as what is visible
 * (`--review-visible-h`, written by useReviewSidebar's resize observer). Open, a
 * thin line between the text and the cards; folded, a narrow strip at the right
 * holding the question count. Either way the whole bar is the one button.
 */
export const ThreadReviewBar = memo(function ThreadReviewBar(p: ThreadReviewBarProps) {
  const label = p.collapsed ? `Show questions (${p.count})` : 'Hide questions';
  return (
    <div className="thread-review-bar-slot" data-collapsed={p.collapsed ? 'true' : undefined}>
      <button
        type="button"
        className="thread-review-bar"
        data-testid="thread-review-bar"
        aria-label={label}
        aria-expanded={!p.collapsed}
        title={label}
        onClick={p.onToggle}
      >
        <span className="thread-review-bar-chevron" aria-hidden="true">{p.collapsed ? '‹' : '›'}</span>
        {p.collapsed && <span className="thread-review-bar-count" aria-hidden="true">{p.count}</span>}
      </button>
    </div>
  );
});
