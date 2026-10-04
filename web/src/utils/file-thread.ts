/**
 * Questions about a passage of a FILE (the Files tab). Pure helpers: which
 * questions belong to the file on show, the quote a whole block becomes, where
 * the comment card sits inside the file view's box, and which element under the
 * pointer is a block worth an inline Ask.
 *
 * A file question's anchor is `parent = file:<path>` (thread-tree.ts); the card
 * itself is the timeline's (SessionChatHistory draws it into the host box the
 * file view lends, see FileCardHost in SessionThreadsContext).
 */
import type { ThreadCardPlace } from '@/contexts/SessionThreadsContext';
import type { ThreadPendingPage } from '@/components/sessions/thread-ui-contract';
import type { ThreadMetaIndex, ThreadViewStatus } from '@/utils/thread-meta';
import { displayTitleOf, metaOf, statusOf } from '@/utils/thread-meta';
import { questionNumbers } from '@/utils/question-tag';
import type { PassageMarkSpec } from '@/utils/thread-card';
import { CARD_GAP, CARD_MIN_WIDTH, CARD_WIDTH } from '@/utils/thread-card';
import { ROOT_THREAD_KEY, fileOfParent, type ThreadTree } from '@/utils/thread-tree';
import { quoteFromRange, type QuoteTextIndex, type TextQuote } from '@/utils/text-quote-anchor';

/** The draft question's place, when one is being written (ThreadPendingPage). */
export type PendingFileMark = Pick<ThreadPendingPage, 'pageKey' | 'parentMsgId' | 'quote' | 'title'>;

/** Asks not sent yet: the one being written and the drafts left with words. */
type PendingMarks = PendingFileMark | ReadonlyArray<PendingFileMark> | null | undefined;
function pendingList(p: PendingMarks): ReadonlyArray<PendingFileMark> {
  if (!p) return [];
  return Array.isArray(p) ? p : [p as PendingFileMark];
}

/** The questions about passages of `path`, as marks (one neutral grey style),
 *  the draft being written about one included: its selection is gone once the
 *  card opens, so the mark is what says which passage it is about. */
export function fileQuestionMarks(
  tree: ThreadTree, hiddenKeys: ReadonlySet<string>, index: ThreadMetaIndex, path: string, pending?: PendingMarks,
): PassageMarkSpec[] {
  const out: PassageMarkSpec[] = [];
  for (const p of pendingList(pending)) {
    if (!p.quote?.exact || fileOfParent(p.parentMsgId) !== path || tree.byKey.has(p.pageKey)) continue;
    out.push({
      key: p.pageKey, headId: p.pageKey, parentMsgId: p.parentMsgId,
      quote: p.quote, hue: 0, resolved: false, title: p.title, neutral: true,
    });
  }
  for (const node of tree.threads) {
    if (node.key === ROOT_THREAD_KEY || hiddenKeys.has(node.key)) continue;
    if (node.file?.path !== path || !node.quote?.exact) continue;
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

/** One row of the file's question rail (FileQuestionRail): a question about a
 *  passage of this file, or the draft being written about one. */
export interface FileRailRow {
  key: string;
  kind: 'thread' | 'pending';
  number?: number;
  title: string;
  naming: boolean;
  status: ThreadViewStatus;
  current: boolean;
  unread: boolean;
}

/**
 * The questions about passages of `path`, in transcript order, the draft last:
 * what the rail at the top left of the file view shows (one mark each) and lists
 * on hover. `currentKey` is the question whose card is open (else the composer's
 * target), so the rail says where the reader is, the way the session's map does.
 */
export function fileQuestionRows(
  tree: ThreadTree, hiddenKeys: ReadonlySet<string>, index: ThreadMetaIndex, path: string,
  pending: PendingMarks, currentKey: string | null, unreadKeys: ReadonlySet<string>,
): FileRailRow[] {
  const numbers = questionNumbers(tree, index);
  const out: FileRailRow[] = [];
  for (const node of tree.threads) {
    if (node.key === ROOT_THREAD_KEY || hiddenKeys.has(node.key) || node.file?.path !== path) continue;
    const { title, naming } = displayTitleOf(node, index);
    const number = numbers.get(node.key);
    out.push({
      key: node.key, kind: 'thread', ...(number !== undefined ? { number } : {}), title, naming,
      status: statusOf(node, index), current: node.key === currentKey, unread: unreadKeys.has(node.key),
    });
  }
  for (const p of pendingList(pending)) {
    if (fileOfParent(p.parentMsgId) !== path || tree.byKey.has(p.pageKey)) continue;
    out.push({
      key: p.pageKey, kind: 'pending', title: p.title, naming: false, status: 'pending',
      current: p.pageKey === currentKey, unread: false,
    });
  }
  return out;
}

/** Block elements the inline Ask offers itself on (innermost wins). */
export const ASKABLE_BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, pre, blockquote, td, th, dd, dt, figcaption';

/**
 * The block under the pointer, when it is one worth asking about: inside `body`,
 * not part of the thread layer or a card, and holding some text. `li` wins over
 * the `p` inside it only when the `p` is the whole item (the common markdown
 * shape), so the Ask covers the item the reader sees.
 */
export function askableBlockOf(target: Element | null, body: Element): Element | null {
  if (!target || !body.contains(target)) return null;
  if (target.closest('.fv-thread-layer, .thread-card, .session-diff-ask-pill')) return null;
  const block = target.closest(ASKABLE_BLOCK_SELECTOR);
  if (!block || !body.contains(block) || block === body) return null;
  if (!(block.textContent ?? '').trim()) return null;
  const parent = block.parentElement;
  if (block.tagName === 'P' && parent?.tagName === 'LI' && parent.children.length === 1) return parent;
  return block;
}

/** A whole block as a quote: its text through the index (so the quote locates
 *  itself again), capped like a drag would be. */
export function blockQuoteOf(index: QuoteTextIndex, block: Element): TextQuote | null {
  const doc = block.ownerDocument;
  const range = doc.createRange();
  range.selectNodeContents(block);
  return quoteFromRange(index, range);
}

/** A box in the file view's coordinates (the host's top-left is 0,0). */
export interface HostRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/** The smallest card worth showing: header + one line + composer. */
export const FILE_CARD_MIN_HEIGHT = 180;

/**
 * Where the card sits inside the file view: below the passage, right-aligned to
 * it and never outside the host box. The host does not scroll (the file's own
 * surface does), so a passage scrolled past an edge keeps its card docked at
 * that edge, the way a comment stays reachable in a document.
 */
export function placeFileCard(anchor: HostRect, host: { width: number; height: number }, preferred = CARD_WIDTH): ThreadCardPlace {
  const width = Math.max(Math.min(preferred, host.width - 2 * CARD_GAP), Math.min(CARD_MIN_WIDTH, host.width));
  const left = Math.max(CARD_GAP, Math.min(anchor.right - width, host.width - width - CARD_GAP));
  const lowest = Math.max(CARD_GAP, host.height - FILE_CARD_MIN_HEIGHT - CARD_GAP);
  const top = Math.max(CARD_GAP, Math.min(anchor.bottom + CARD_GAP, lowest));
  const room = host.height - top - CARD_GAP;
  const maxHeight = Math.max(Math.min(FILE_CARD_MIN_HEIGHT, room), Math.min(Math.round(host.height * 0.6), room));
  return { top: Math.round(top), left: Math.round(left), width: Math.round(width), maxHeight: Math.round(maxHeight) };
}

/** A rect of the file's surface translated into host coordinates; a rect inside
 *  an iframe adds the frame's own offset. */
export function toHostRect(rect: DOMRect, host: DOMRect, frame?: DOMRect | null): HostRect {
  const dx = (frame ? frame.left : 0) - host.left;
  const dy = (frame ? frame.top : 0) - host.top;
  return { top: rect.top + dy, bottom: rect.bottom + dy, left: rect.left + dx, right: rect.right + dx };
}

/** Is a host-coordinate rect (partly) inside the host's box? */
export function rectInHost(rect: HostRect, host: { width: number; height: number }, margin = 0): boolean {
  return rect.bottom > margin && rect.top < host.height - margin && rect.right > 0 && rect.left < host.width;
}
