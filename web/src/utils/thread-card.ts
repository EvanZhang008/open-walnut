/**
 * The comment card (Conversation Mode): one question, shown beside the passage
 * it is about, like a comment in a document. Pure helpers: which rows the card
 * shows, how a question's text reads without its quote, where the card sits,
 * and the marks every asked passage wears.
 */
import type { SessionPinnedQuote } from '@/types/session';
import type { ThreadMarkState } from '@/utils/thread-mark-state';
import type { ThreadMetaIndex } from '@/utils/thread-meta';
import { displayTitleOf, metaOf } from '@/utils/thread-meta';
import type { ThreadNode, ThreadTree } from '@/utils/thread-tree';
import { BACK_TO_MAIN_LINE, FILE_ABOUT_LINE_RE, ROOT_THREAD_KEY, fileOfParent, isTurnHead } from '@/utils/thread-tree';
import { stripQuestionTag } from '@/utils/question-tag';
import { stripTurnMarker } from '@/utils/turn-end-marker';

/** The rows the tree reads (`SessionHistoryMessage` fits). */
export interface CardRowLike {
  role: string;
  msgId?: string;
  walnutMessageId?: string;
  sourceUuid?: string;
  text?: string;
  tools?: readonly unknown[];
  /** Filed under this user row ('' = main) by the split, not by its place. */
  ownerId?: string;
}

/** An assistant row says something: text left once the `[Qn]` tag and the
 *  no-action line are gone. A reply that is only those and tool calls has no
 *  answer in it. */
export function hasWords(text: string | undefined): boolean {
  // A test, not a trim: the timeline asks this of every live text block per render.
  return !!text && /\S/.test(stripTurnMarker(stripQuestionTag(text)));
}

/** One turn of the question: its user row and the reply's final message. */
export interface CardTurn<M extends CardRowLike = CardRowLike> {
  user: M;
  /** The reply's LAST row with text, alone (empty when the reply has none). */
  replies: M[];
}

/**
 * The question's turns in transcript order: each head row of `node.turnIds`
 * with the final text row of the reply that follows it. The words a turn says
 * between its tool calls ("Let me check the file") are steps, not the answer:
 * the card shows the answer, the timeline keeps the steps (2026-10-06, the
 * user: "the run commands we don't need, just the final message").
 */
export function cardTurnsOf<M extends CardRowLike>(messages: readonly M[], node: ThreadNode | undefined): CardTurn<M>[] {
  if (!node || node.turnIds.length === 0) return [];
  const want = new Set(node.turnIds);
  // A row the split filed by its owner (a strict question's answer in its tag,
  // ask-answer.ts) answers that row's turn wherever it sits; the rest by place.
  const ownedLast = new Map<string, { at: number; row: M }>();
  for (let j = 0; j < messages.length; j++) {
    const r = messages[j];
    if (r.role === 'assistant' && r.ownerId && want.has(r.ownerId) && hasWords(r.text)) ownedLast.set(r.ownerId, { at: j, row: r });
  }
  const out: CardTurn<M>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const id = m.sourceUuid ?? m.msgId ?? m.walnutMessageId;
    if (!isTurnHead(m) || !id || !want.has(id)) continue;
    let last: M | undefined;
    let lastAt = -1;
    for (let j = i + 1; j < messages.length && !isTurnHead(messages[j]); j++) {
      const r = messages[j];
      if (r.role === 'assistant' && r.ownerId === undefined && hasWords(r.text)) { last = r; lastAt = j; }
    }
    const owned = ownedLast.get(id);
    if (owned && owned.at > lastAt) last = owned.row;
    out.push({ user: m, replies: last ? [last] : [] });
  }
  return out;
}

/**
 * A question's text as the card shows it: without the quoted passage the send
 * composed in front of it (the card already sits beside that passage) and
 * without the orientation line. The banner is stripped by the row renderer.
 */
/** Both orientation lines a send can open with (thread-tree.ts: the anchored
 *  "thread" form and the page's "question" form). */
const BACK_TO_LINE_RE = /^\(Back to the earlier (?:thread|question) about /;

export function questionBodyOf(text: string): string {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let i = 0;
  const skipBlank = () => { while (i < lines.length && !lines[i].trim()) i++; };
  skipBlank();
  // The reply-tag banner, when the raw text still carries it.
  if (i < lines.length && /^\[Question Q\d{1,5}\]\s*$/.test(lines[i])) {
    const close = lines.findIndex((l, k) => k > i && /^\[\/Question Q\d{1,5}\]\s*$/.test(l));
    if (close > i) { i = close + 1; skipBlank(); }
  }
  if (i < lines.length && (BACK_TO_LINE_RE.test(lines[i]) || lines[i] === BACK_TO_MAIN_LINE)) {
    i++;
    skipBlank();
  }
  // A file question names its file ahead of the quote (the card sits in that file).
  if (i < lines.length && FILE_ABOUT_LINE_RE.test(lines[i])) {
    i++;
    skipBlank();
  }
  if (i < lines.length && lines[i].startsWith('>')) {
    while (i < lines.length && lines[i].startsWith('>')) i++;
    skipBlank();
  }
  return lines.slice(i).join('\n').trim() || text.trim();
}

export interface CardAnchorRect {
  /** Relative to the card layer's box (content coordinates, scroll included). */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface CardPlacement {
  top: number;
  left: number;
  width: number;
}

export const CARD_WIDTH = 440;
export const CARD_MIN_WIDTH = 260;
export const CARD_GAP = 8;
/** The expanded card (its ⤢) grows in place: the same top, below its passage,
 *  as wide as the layer allows up to this, its right edge still on the passage's
 *  when there is room (2026-10-03: lifted to a panel overlay it read as a new
 *  place, not the same card made bigger). */
export const CARD_GROWN_WIDTH = 960;
/** Room an expanded timeline card leaves in the box: the passage's last line
 *  above it, and the history's jump-to-bottom button below it (the card's
 *  `scroll-margin-bottom`), once the card is scrolled whole into view. */
export const CARD_GROWN_HEADROOM = 96;

/** How far the expanded card reaches (its top stays the card's own). */
export interface CardGrown {
  left: number;
  width: number;
  maxHeight: number;
}

/** An open card's width over its review card: a comment's width, reaching over
 *  the text a little; a table or a diagram in it grows to CARD_GROWN_WIDTH. */
export const CARD_ENLARGED_WIDTH = 480;

/** The least an enlarged card is given before it moves up to have it. */
export const ENLARGED_MIN_HEIGHT = 360;
/** ...and the least share of the visible box: an open question reads as a
 *  page, not a strip under its row (2026-10-29: a row low on screen opened a
 *  card half the box tall over a five-round thread). */
export const ENLARGED_MIN_SHARE = 0.7;
/**
 * A card enlarged over `anchor` (a fullscreen review card, in the card layer's
 * coordinates): its top, its right edge, wider to the left down to 8px from the
 * layer's left. The review card sits past the layer's own width (in the
 * history's right gutter), so nothing clamps to the layer's width. Its height
 * is what is on screen below that top (`visible`, the part of the box the panel
 * header leaves), at most `maxRoom`; when less than ENLARGED_MIN_HEIGHT (or
 * ENLARGED_MIN_SHARE of the visible box) is left there, the card moves up just
 * enough to have it.
 */
export function placeCardOver(
  anchor: CardAnchorRect, visible: { top: number; bottom: number }, maxRoom: number,
): CardPlacement & { maxHeight: number; grown: CardGrown } {
  const right = Math.round(anchor.right);
  const span = Math.max(CARD_MIN_WIDTH, right - 8);
  const width = Math.min(CARD_ENLARGED_WIDTH, span);
  const wide = Math.min(CARD_GROWN_WIDTH, span);
  const want = Math.min(maxRoom, Math.max(ENLARGED_MIN_HEIGHT, Math.round((visible.bottom - visible.top) * ENLARGED_MIN_SHARE)));
  let top = anchor.top;
  if (visible.bottom - 12 - top < want) top = Math.max(visible.top + 8, visible.bottom - 12 - want);
  const maxHeight = Math.round(Math.max(want, Math.min(maxRoom, visible.bottom - 12 - top)));
  top = Math.max(0, Math.round(top));
  return { top, left: Math.max(0, right - width), width, maxHeight, grown: { left: Math.max(0, right - wide), width: wide, maxHeight } };
}

/**
 * Below the passage, its right edge on the passage's right edge (a comment
 * popover), pulled back so it never leaves the layer: a layer narrower than the
 * card gets a card as wide as the layer.
 */
export function placeCard(anchor: CardAnchorRect, layerWidth: number, preferred = CARD_WIDTH): CardPlacement {
  const width = Math.max(Math.min(preferred, layerWidth), Math.min(CARD_MIN_WIDTH, layerWidth));
  const left = Math.max(0, Math.min(anchor.right - width, layerWidth - width));
  return { top: Math.max(0, Math.round(anchor.bottom + CARD_GAP)), left: Math.round(left), width: Math.round(width) };
}

export interface PassageMarkSpec {
  key: string;
  headId: string;
  parentMsgId: string;
  quote: SessionPinnedQuote;
  hue: number;
  resolved: boolean;
  title: string;
  /** Painted in the one neutral style (Conversation Mode shows no hue). */
  neutral: true;
  /** What the mark says (thread-mark-state.ts), set by the caller. */
  state?: ThreadMarkState;
  /** An Ask not sent yet. */
  draft?: true;
}

/** An Ask not sent yet (ThreadPendingPage's fields the mark needs). */
export interface UnsentAsk { pageKey: string; parentMsgId: string; quote?: SessionPinnedQuote; title: string }

/** Every question with a passage, whichever reply it is about (Conversation
 *  Mode shows the whole transcript, so every asked passage wears its mark).
 *  The draft being written is included, as in the Files tab: its selection is
 *  gone once its card opens, so the mark is what says which words it is about. */
export function allPassageMarks(
  tree: ThreadTree, hiddenKeys: ReadonlySet<string>, index: ThreadMetaIndex, unsent: ReadonlyArray<UnsentAsk> = [],
): PassageMarkSpec[] {
  const out: PassageMarkSpec[] = [];
  for (const p of unsent) {
    if (!p.quote?.exact || fileOfParent(p.parentMsgId) !== null || tree.byKey.has(p.pageKey)) continue;
    out.push({
      key: p.pageKey, headId: p.pageKey, parentMsgId: p.parentMsgId,
      quote: p.quote, hue: 0, resolved: false, title: p.title, neutral: true, draft: true,
    });
  }
  for (const node of tree.threads) {
    if (node.key === ROOT_THREAD_KEY || hiddenKeys.has(node.key)) continue;
    if (!node.parent || !node.quote?.exact) continue;
    out.push({
      key: node.key,
      headId: node.headId,
      parentMsgId: node.parent,
      quote: node.quote,
      hue: node.hue,
      resolved: metaOf(node, index)?.status === 'resolved',
      title: displayTitleOf(node, index).title,
      neutral: true,
    });
  }
  return out;
}
