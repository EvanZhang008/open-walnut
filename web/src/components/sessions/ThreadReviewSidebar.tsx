/**
 * The fullscreen review sidebar: one card per asked passage of the visible
 * conversation, beside its line like a comment in a document's review pane
 * (utils/review-sidebar.ts has the rules). A card is its head row (number,
 * title, where its answer stands, colored by the passage's mark state) over the
 * question's whole conversation, drawn as the open card draws it
 * (ThreadCardConversation), capped in height with its own scroll (thread-review.css)
 * (2026-10-31, the user: it "must show everything normally ... maybe a maximum
 * height, but people can scroll"; the one-row card of 2026-10-29 showed nothing).
 * Under it, the question's reply box (ThreadReplyBox): a follow-up is typed,
 * dictated and sent right there (2026-11-08, the user: the side comments are Ask
 * here and must have an input box). The head (or Enter, or a click on its
 * passage) opens the question's full card over it, with a full-screen button.
 *
 * A thin vertical bar on the column's edge folds the column away and brings it
 * back (ThreadReviewBar; the choice is one preference, useReviewSidebarCollapsed).
 *
 * Cards sit in a zero-height layer at the top of the scroll content, so they
 * scroll with the text. Their tops are written straight to the DOM after each
 * render and on a card's resize: one read of the heights, one write each.
 */
import {
  memo, useCallback, useEffect, useId, useLayoutEffect, useRef,
  type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode, type RefObject,
} from 'react';
import { typedUserText } from '@open-walnut/history-injected-banner';
import type { SessionHistoryMessage } from '@/types/session';
import type { ThreadMarkState } from '@/utils/thread-mark-state';
import { hasWords, questionBodyOf } from '@/utils/thread-card';
import { displayTitleOf, type ThreadMetaIndex } from '@/utils/thread-meta';
import { isTurnHead, type ThreadTree } from '@/utils/thread-tree';
import { liftReviewCard, askedLine, clampReviewWidth, plainExcerpt, REVIEW_BODY_MAX, REVIEW_BODY_MIN, REVIEW_DRAG_SLOP, REVIEW_GAP, REVIEW_TYPING_BODY, stackReviewCards, stepReviewWidth } from '@/utils/review-sidebar';
import type { ReviewResize } from '@/hooks/useReviewSidebar';
import { stripQuestionTag } from '@/utils/question-tag';
import type { ImageAttachment } from '@/api/chat';
import { cardFollowUpPlaceholder } from './ThreadCommentCard';
import { ThreadReplyBox } from './ThreadReplyBox';
import '@/styles/thread-review.css';

export interface ReviewEntry {
  key: string;
  number?: string;
  title: string;
  state: ThreadMarkState;
  question: string;
  /** The newest question at full length (the reply box's tooltip). */
  questionFull?: string;
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
    if (m.role === 'user' && !isTurnHead(m)) continue;
    if (m.role === 'user') {
      const id = m.sourceUuid ?? m.msgId ?? m.walnutMessageId;
      open = id ? { at: i, user: m } : undefined;
      if (id && open) out.set(id, open);
      continue;
    }
    if (m.role !== 'assistant' || !hasWords(m.text)) continue;
    // A row the split filed by its owner (a strict answer, ask-answer.ts): that
    // row's turn wherever it sits; '' is the main conversation's, no turn here.
    const owner = m.ownerId;
    if (owner !== undefined) {
      const t = owner ? out.get(owner) : undefined;
      if (t) t.reply = m;
      continue;
    }
    if (open) open.reply = m;
  }
  return out;
}

/** One entry per question with a measured passage, in the anchors' order,
 *  from the persisted rows (live words are laid over by withLiveAnswers). */
export function buildReviewEntries(a: {
  keys: readonly string[];
  tree: ThreadTree;
  metaIndex: ThreadMetaIndex;
  numbers: ReadonlyMap<string, string>;
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
    const body = last ? questionBodyOf(typedUserText(last.user.text ?? '')) : '';
    out.push({
      key,
      ...(number !== undefined ? { number } : {}),
      title: displayTitleOf(node, a.metaIndex).title,
      state: a.markStates.get(key) ?? 'read',
      question: body ? plainExcerpt(body, 240) : '',
      questionFull: body ? askedLine(body) : '',
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
    const body = questionBodyOf(typedUserText(text));
    const question = plainExcerpt(body, 240);
    return question && question !== e.question ? { ...e, question, questionFull: askedLine(body), answer: '' } : e;
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
  canAsk: boolean;
  /** A question's composer draft key (its reply box keeps its words there). */
  draftKeyOf: (key: string) => string | null;
  /** Send a follow-up into the question. */
  onSend: (key: string, text: string, images?: ImageAttachment[]) => Promise<boolean>;
  /** The card's reply box took the keyboard. */
  onPick: (key: string) => void;
}

/** How long a card's conversation follows the answer to a send from its box. */
const FOLLOW_ANSWER_MS = 5 * 60_000;

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
    // The card whose box holds the keyboard keeps a readable piece of its
    // conversation even when the cards are crowded (2026-11-11 review: near the
    // view's foot it was squeezed to one clipped line of the answer).
    // Only the box counts: a click on the card's head focuses the head, and
    // moving the card under that click would lose it.
    const box = document.activeElement?.closest('.thread-card-composer');
    const typing = box ? parts.find((x) => !!x.body && !!cards.current.get(x.key)?.contains(box))?.key : undefined;
    const bodyOf = (x: (typeof parts)[number], cap: number) => (x.key === typing
      ? Math.min(x.bodyH, Math.max(cap, REVIEW_TYPING_BODY))
      : cap >= REVIEW_BODY_MIN ? Math.min(x.bodyH, cap) : 0);
    const stackWith = (cap: number) => stackReviewCards(
      parts.map((x) => ({ key: x.key, anchor: x.anchor, height: x.head + bodyOf(x, cap) })),
      REVIEW_GAP, cur.selected,
    );
    const bottomOf = (tops: Map<string, number>, cap: number) => {
      let bottom = 0;
      for (const x of parts) bottom = Math.max(bottom, (tops.get(x.key) ?? 0) + x.head + bodyOf(x, cap));
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
    // The card being typed in keeps its box on screen: past the view's foot the
    // next key typed made the browser scroll the timeline to the caret
    // (2026-11-10 review: 633px on a second follow-up). It rises (the cards
    // above it with it) until its box and that piece of conversation fit above
    // the foot; only what still does not fit scrolls inside it.
    const scroller = layer.closest<HTMLElement>('.session-history');
    const view = scroller?.getBoundingClientRect();
    const foot = view ? view.bottom - origin - REVIEW_GAP : Number.POSITIVE_INFINITY;
    const ceiling = view ? Math.max(0, view.top - origin + REVIEW_GAP) : 0;
    const typed = typing ? parts.find((x) => x.key === typing) : undefined;
    let typedBody = typed ? bodyOf(typed, cap) : 0;
    if (typed) {
      const top = tops.get(typed.key) ?? 0;
      // A card wholly past the foot (read elsewhere, focus left in it) stays put.
      if (top < foot) {
        const over = top + typed.head + typedBody - foot;
        if (over > 0) {
          tops = liftReviewCard(tops, new Map(parts.map((x) => [x.key, x.head + bodyOf(x, cap)])), typed.key, Math.max(ceiling, top - over), REVIEW_GAP);
          const now = tops.get(typed.key) ?? top;
          typedBody = Math.min(typedBody, Math.max(REVIEW_BODY_MIN, foot - now - typed.head));
        }
      }
    }
    for (const x of parts) {
      if (!x.body) continue;
      const own = x.key === typing ? typedBody : cap;
      const hide = x.key === typing ? false : cap < REVIEW_BODY_MIN;
      const max = !hide && x.bodyH > own ? `${Math.max(0, own - x.extra)}px` : '';
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
  // The keyboard moving into or out of a card's box changes what that card may grow to.
  useEffect(() => {
    const layer = p.layerRef.current;
    if (!layer) return;
    let raf = 0;
    const again = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; place(); }); };
    layer.addEventListener('focusin', again);
    layer.addEventListener('focusout', again);
    return () => { layer.removeEventListener('focusin', again); layer.removeEventListener('focusout', again); if (raf) cancelAnimationFrame(raf); };
  }, [place, p.layerRef]);
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

  // After a send from a card's box, its conversation keeps its end in view while
  // the question and its answer come in, until the reader scrolls or types in it
  // (2026-11-10 review: a third follow-up's answer arrived below the card's fold).
  const follows = useRef(new Map<string, () => void>());
  useEffect(() => () => { for (const stop of [...follows.current.values()]) stop(); }, []);
  const followEnd = useCallback((key: string) => {
    follows.current.get(key)?.();
    const body = cards.current.get(key)?.querySelector<HTMLElement>('.thread-review-body');
    if (!body) return;
    let at = 0;
    // A card gone from the column (its body out of the page) follows no more.
    const toEnd = () => {
      if (!body.isConnected) { stop(); return; }
      body.scrollTop = body.scrollHeight;
      at = body.scrollTop;
    };
    const mo = new MutationObserver(toEnd);
    mo.observe(body, { childList: true, subtree: true, characterData: true });
    // Its cap changes (place) and a picture loading grow it with no mutation.
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(toEnd);
    ro?.observe(body);
    if (body.firstElementChild) ro?.observe(body.firstElementChild);
    const READER = ['wheel', 'pointerdown', 'keydown', 'touchstart'] as const;
    const stop = () => {
      mo.disconnect();
      ro?.disconnect();
      for (const t of READER) body.removeEventListener(t, stop);
      body.removeEventListener('scroll', onScroll);
      window.clearTimeout(timer);
      if (follows.current.get(key) === stop) follows.current.delete(key);
    };
    // A scroll up from where it was put, short of the end: the reader dragged its
    // scrollbar (a taller cap pulls scrollTop back too, but to the end).
    const onScroll = () => { if (body.scrollTop < at - 2 && body.scrollHeight - body.scrollTop - body.clientHeight > 2) stop(); };
    for (const t of READER) body.addEventListener(t, stop, { passive: true });
    body.addEventListener('scroll', onScroll, { passive: true });
    const timer = window.setTimeout(stop, FOLLOW_ANSWER_MS);
    follows.current.set(key, stop);
    toEnd();
  }, [cards]);

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
          {/* Not while the open card lies over it: two boxes on one draft would
              each hold their own copy; mounted again, it reads the card's words. */}
          {p.enlarged !== e.key && <ThreadReplyBox
            draftKey={p.draftKeyOf(e.key)}
            canAsk={p.canAsk}
            placeholder={cardFollowUpPlaceholder(e.title)}
            asked={e.question}
            askedTitle={e.questionFull || e.question}
            onSend={(text, images) => p.onSend(e.key, text, images)}
            onFocus={() => p.onPick(e.key)}
            onSent={() => followEnd(e.key)}
          />}
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
  /** The column's width (open only): dragged, arrow keys, double-click resets. */
  resize?: ReviewResize;
}

/** A click on the open bar folds the column only once no second click follows
 *  (a double-click resets the width, and the first click must not fold it). */
const FOLD_DELAY_MS = 220;
const RESIZING_CLASS = 'walnut-col-resizing';

interface BarDrag {
  id: number;
  x0: number;
  /** The pointer's x now. */
  px: number;
  on: boolean;
  raf: number;
  /** Bar movement per px of width, measured (the sheet grows outward with the
   *  column, so the bar moves less than the width changed). */
  slope: number;
  prev?: { w: number; x: number };
  settle: number;
}

/**
 * The vertical bar on the sidebar's edge: sticky in the scroller (top 0 of its
 * content box, so below the glass header), as tall as what is visible
 * (`--review-visible-h`, written by useReviewSidebar's resize observer). Open, a
 * thin line between the text and the cards; folded, a narrow strip at the right
 * holding the question count. A click folds or unfolds the column. Open, the
 * line is also its resize handle (2026-11-10, the user: it "can be drag"): a
 * press that moves past REVIEW_DRAG_SLOP drags the column's width (the pointer
 * captured, the bar kept under it), ArrowLeft / ArrowRight change it by
 * REVIEW_W_STEP, a double-click puts the default width back.
 */
export const ThreadReviewBar = memo(function ThreadReviewBar(p: ThreadReviewBarProps) {
  const label = p.collapsed ? `Show questions (${p.count})` : 'Hide questions';
  const resizable = !p.collapsed && !!p.resize;
  const ref = useRef<HTMLButtonElement | null>(null);
  const drag = useRef<BarDrag | null>(null);
  const swallowClick = useRef(false);
  const foldTimer = useRef(0);
  const toggleRef = useRef(p.onToggle);
  toggleRef.current = p.onToggle;
  const resizeRef = useRef(p.resize);
  resizeRef.current = p.resize;
  const hintId = useId();

  const endDrag = useCallback((commit: boolean) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.raf) cancelAnimationFrame(d.raf);
    if (!d.on) return;
    document.documentElement.classList.remove(RESIZING_CLASS);
    ref.current?.classList.remove('is-dragging');
    const rz = resizeRef.current;
    if (!rz) return;
    rz.setDragging(false);
    if (!commit) return;
    // A quick release lands before the next frame: the rest of the way to the
    // pointer is taken now (2026-11-11: a flick of 60px kept only 23 of them).
    const w = rz.width();
    const r = ref.current?.getBoundingClientRect();
    const err = r ? d.px - (r.left + r.width / 2) : 0;
    rz.commit(Math.abs(err) < 1 ? w : clampReviewWidth(Math.round(w + err / d.slope), rz.room()), 'drag');
  }, []);
  useEffect(() => () => {
    window.clearTimeout(foldTimer.current);
    endDrag(true);
  }, [endDrag]);
  // Folded mid-drag (another window's choice): the drag ends where it is.
  useEffect(() => { if (!resizable) endDrag(true); }, [resizable, endDrag]);

  const barX = () => {
    const r = ref.current?.getBoundingClientRect();
    return r ? r.left + r.width / 2 : 0;
  };
  // Once a frame: the width that puts the bar under the pointer, from the
  // last width and where the bar moved for it.
  const frame = () => {
    const d = drag.current;
    const rz = resizeRef.current;
    if (!d || !rz) return;
    d.raf = 0;
    const w = rz.width();
    const x = barX();
    if (d.prev && Math.abs(w - d.prev.w) >= 2) {
      const k = (x - d.prev.x) / (w - d.prev.w);
      if (k < -0.2 && k > -1.5) d.slope = k;
    }
    d.prev = { w, x };
    const err = d.px - x;
    if (Math.abs(err) < 1) return;
    const next = clampReviewWidth(Math.round(w + err / d.slope), rz.room());
    if (next === w) return;
    rz.preview(next);
    if (ref.current) ref.current.dataset.width = String(next);
    d.settle += 1;
    if (d.settle < 6) d.raf = requestAnimationFrame(frame);
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
    swallowClick.current = false;
    if (!resizable || e.button !== 0) return;
    // No text selection starts from the handle; the click still fires.
    e.preventDefault();
    try { e.currentTarget.setPointerCapture(e.pointerId); } catch { /* an old engine: moves on the bar only */ }
    drag.current = { id: e.pointerId, x0: e.clientX, px: e.clientX, on: false, raf: 0, slope: -1, settle: 0 };
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    d.px = e.clientX;
    if (!d.on) {
      if (Math.abs(e.clientX - d.x0) <= REVIEW_DRAG_SLOP) return;
      d.on = true;
      window.clearTimeout(foldTimer.current);
      foldTimer.current = 0;
      resizeRef.current?.setDragging(true);
      document.documentElement.classList.add(RESIZING_CLASS);
      ref.current?.classList.add('is-dragging');
    }
    d.settle = 0;
    if (!d.raf) d.raf = requestAnimationFrame(frame);
  };
  const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d || e.pointerId !== d.id) return;
    // A drag is no click (the click that follows would fold the column).
    if (d.on) swallowClick.current = true;
    endDrag(true);
  };
  const onClick = (e: ReactMouseEvent<HTMLButtonElement>) => {
    if (swallowClick.current) { swallowClick.current = false; return; }
    // Folded, or the keyboard (detail 0): at once.
    if (!resizable || e.detail === 0) { toggleRef.current(); return; }
    window.clearTimeout(foldTimer.current);
    foldTimer.current = 0;
    if (e.detail >= 2) { resizeRef.current?.reset(); return; }
    foldTimer.current = window.setTimeout(() => { foldTimer.current = 0; toggleRef.current(); }, FOLD_DELAY_MS);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLButtonElement>) => {
    const rz = resizeRef.current;
    if (!resizable || !rz || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    e.stopPropagation();
    const next = stepReviewWidth(rz.width(), e.key, rz.room());
    if (ref.current) ref.current.dataset.width = String(next);
    rz.commit(next, 'keyboard');
  };

  return (
    <div className="thread-review-bar-slot" data-collapsed={p.collapsed ? 'true' : undefined}>
      <button
        ref={ref}
        type="button"
        className="thread-review-bar"
        data-testid="thread-review-bar"
        data-resizable={resizable ? 'true' : undefined}
        data-width={resizable ? p.resize!.width() : undefined}
        aria-label={label}
        aria-expanded={!p.collapsed}
        aria-describedby={resizable ? hintId : undefined}
        title={resizable ? `${label}. Drag to resize, double-click to reset` : label}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => endDrag(true)}
        onLostPointerCapture={() => { if (drag.current?.on) endDrag(true); }}
        onClick={onClick}
        onKeyDown={onKeyDown}
      >
        <span className="thread-review-bar-chevron" aria-hidden="true">{p.collapsed ? '‹' : '›'}</span>
        {p.collapsed && <span className="thread-review-bar-count" aria-hidden="true">{p.count}</span>}
      </button>
      {resizable && (
        <span id={hintId} className="thread-review-sr-only">
          Drag, or press the left and right arrow keys, to resize the question column; double-click resets its width.
        </span>
      )}
    </div>
  );
});
