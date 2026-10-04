/**
 * The comment card (Conversation Mode): one question, shown beside the passage
 * it is about, like a comment in a document. Pure helpers: which rows the card
 * shows, how a question's text reads without its quote, where the card sits,
 * and the marks every asked passage wears.
 */
import type { SessionPinnedQuote } from '@/types/session';
import type { ThreadMetaIndex } from '@/utils/thread-meta';
import { displayTitleOf, metaOf } from '@/utils/thread-meta';
import type { ThreadNode, ThreadTree } from '@/utils/thread-tree';
import { BACK_TO_MAIN_LINE, FILE_ABOUT_LINE_RE, ROOT_THREAD_KEY } from '@/utils/thread-tree';

/** The rows the tree reads (`SessionHistoryMessage` fits). */
export interface CardRowLike {
  role: string;
  msgId?: string;
  walnutMessageId?: string;
  text?: string;
  tools?: readonly unknown[];
}

/** One turn of the question: its user row and the reply rows after it. */
export interface CardTurn<M extends CardRowLike = CardRowLike> {
  user: M;
  /** The reply's rows with text (tool-only rows are the card's business to hide). */
  replies: M[];
}

/**
 * The question's turns in transcript order: each head row of `node.turnIds`
 * with the rows that follow it up to the next user row, text rows only. A
 * reply whose rows are all tool calls contributes nothing (the card is about
 * the answer, the timeline keeps the tools).
 */
export function cardTurnsOf<M extends CardRowLike>(messages: readonly M[], node: ThreadNode | undefined): CardTurn<M>[] {
  if (!node || node.turnIds.length === 0) return [];
  const want = new Set(node.turnIds);
  const out: CardTurn<M>[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i];
    const id = m.msgId ?? m.walnutMessageId;
    if (m.role !== 'user' || !id || !want.has(id)) continue;
    const replies: M[] = [];
    for (let j = i + 1; j < messages.length && messages[j].role !== 'user'; j++) {
      const r = messages[j];
      if (r.role === 'assistant' && (r.text ?? '').trim()) replies.push(r);
    }
    out.push({ user: m, replies });
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
/** Room an expanded timeline card leaves above it in the box, so the passage's
 *  last line stays in view once the card is scrolled whole into view. */
export const CARD_GROWN_HEADROOM = 72;

/** How far the expanded card reaches (its top stays the card's own). */
export interface CardGrown {
  left: number;
  width: number;
  maxHeight: number;
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
}

/** Every question with a passage, whichever reply it is about (Conversation
 *  Mode shows the whole transcript, so every asked passage wears its mark). */
export function allPassageMarks(tree: ThreadTree, hiddenKeys: ReadonlySet<string>, index: ThreadMetaIndex): PassageMarkSpec[] {
  const out: PassageMarkSpec[] = [];
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
