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
import type { ThreadLiveState, ThreadMetaIndex, ThreadViewStatus } from '@/utils/thread-meta';
import { displayTitleOf, metaOf, viewStatusOf } from '@/utils/thread-meta';
import { questionLabels } from '@/utils/question-tag';
import type { PassageMarkSpec } from '@/utils/thread-card';
import { CARD_GAP, CARD_GROWN_WIDTH, CARD_MIN_WIDTH, CARD_WIDTH } from '@/utils/thread-card';
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
      quote: p.quote, hue: 0, resolved: false, title: p.title, neutral: true, draft: true,
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
  number?: string;
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
  pending: PendingMarks, currentKey: string | null, unreadKeys: ReadonlySet<string>, live: ReadonlyMap<string, ThreadLiveState>,
): FileRailRow[] {
  const numbers = questionLabels(tree, index);
  const out: FileRailRow[] = [];
  for (const node of tree.threads) {
    if (node.key === ROOT_THREAD_KEY || hiddenKeys.has(node.key) || node.file?.path !== path) continue;
    const { title, naming } = displayTitleOf(node, index);
    const number = numbers.get(node.key);
    out.push({
      key: node.key, kind: 'thread', ...(number !== undefined ? { number } : {}), title, naming,
      status: viewStatusOf(node, index, live), current: node.key === currentKey, unread: unreadKeys.has(node.key),
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
 * not part of the thread layer or a card, and holding some text; a table cell
 * gives its row. `li` wins over
 * the `p` inside it only when the `p` is the whole item (the common markdown
 * shape), so the Ask covers the item the reader sees.
 */
export function askableBlockOf(target: Element | null, body: Element): Element | null {
  if (!target || !body.contains(target)) return null;
  if (target.closest('.fv-thread-layer, .thread-card, .session-diff-ask-pill')) return null;
  const block = target.closest(ASKABLE_BLOCK_SELECTOR);
  if (!block || !body.contains(block) || block === body) return null;
  if (!(block.textContent ?? '').trim()) return null;
  // A table's cell asks about its row: a cell alone ("Mon", "14 ms") says
  // little, and a row leaves room for the Ask beside the table (2026-11-07).
  const row = block.closest('tr');
  if (row && body.contains(row)) return row;
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

/** The hovered block's inline Ask: its box (file-thread.css `.fv-ask-block`). */
export const ASK_CHIP_WIDTH = 44;
export const ASK_CHIP_HEIGHT = 20;
const ASK_CHIP_GAP = 6;

/**
 * Where the hovered block's inline Ask goes, off every word it can see: the
 * block's own and the lines just before and after it (`near`):
 *  - after the end of its last line, when that line is on screen and leaves room
 *    for it inside both the block and the view;
 *  - else right of the block, when the view has room there (a table row's
 *    right is its table's);
 *  - else under the block's right end, else over its first line's right end, when
 *    that gap is on screen and clear of the next (previous) line;
 *  - else whichever of those two covers less of that line (the gap between two
 *    blocks is often narrower than the chip), and a block taller than the view on
 *    both ends gets its top-right corner, kept on screen.
 * `lastLine`: the box of the block's last line of text, null when not known.
 * 2026-11-07: it always sat on the block's top-right corner, over the last word
 * of a full first line ("27" of "2026-10-27"), and a drag that started there
 * selected nothing.
 */
export function placeAskChip(
  block: HostRect, lastLine: HostRect | null, host: { width: number; height: number },
  opts: { near?: HostRect[] } = {},
): { top: number; left: number } {
  const H = ASK_CHIP_HEIGHT;
  const W = ASK_CHIP_WIDTH;
  const near = opts.near ?? [];
  const onScreen = (top: number) => top >= 0 && top + H <= host.height;
  const clampTop = (top: number) => Math.max(0, Math.min(top, host.height - H));
  const clampLeft = (left: number) => Math.max(0, Math.min(left, host.width - W - 4));
  const at = (top: number, left: number) => ({ top: Math.round(top), left: Math.round(left) });
  const covered = (top: number, left: number) => near.reduce((sum, r) => {
    const w = Math.min(left + W, r.right) - Math.max(left, r.left);
    const h = Math.min(top + H, r.bottom) - Math.max(top, r.top);
    return sum + (w > 0 && h > 0 ? w * h : 0);
  }, 0);
  const centred = (line: HostRect) => line.top + (line.bottom - line.top - H) / 2;
  if (lastLine && onScreen(centred(lastLine))) {
    const left = lastLine.right + ASK_CHIP_GAP;
    if (left + W <= block.right && left + W + 4 <= host.width) return at(centred(lastLine), left);
  }
  if (block.right + ASK_CHIP_GAP + W + 4 <= host.width) {
    const first = { ...block, bottom: Math.min(block.bottom, block.top + H) };
    const line = lastLine && onScreen(centred(lastLine)) ? lastLine : first;
    return at(clampTop(centred(line)), block.right + ASK_CHIP_GAP);
  }
  const right = clampLeft(block.right - W);
  const spots = [block.bottom + 2, block.top - H - 2].filter(onScreen);
  if (!spots.length) return at(clampTop(block.top), right);
  const clear = spots.find((top) => covered(top, right) === 0);
  if (clear !== undefined) return at(clear, right);
  return at(spots.reduce((a, b) => (covered(b, right) < covered(a, right) ? b : a)), right);
}

/** Text nodes worth a line box: not blank, not inside the thread layer or a card. */
function wordsNode(n: Node): boolean {
  if (!(n.nodeValue ?? '').trim()) return false;
  return !n.parentElement?.closest('.fv-thread-layer, .thread-card');
}

/** One line's box from line-box pieces: the first or the last line of them. */
function lineOf(rects: DOMRect[], which: 'first' | 'last'): DOMRect | null {
  const pieces = rects.filter((r) => r.width > 0 && r.height > 0);
  if (!pieces.length) return null;
  const line = which === 'last'
    ? (() => {
      const bottom = Math.max(...pieces.map((r) => r.bottom));
      const lh = Math.min(...pieces.filter((r) => r.bottom === bottom).map((r) => r.height));
      return pieces.filter((r) => r.top + r.height / 2 > bottom - lh);
    })()
    : (() => {
      const top = Math.min(...pieces.map((r) => r.top));
      const lh = Math.min(...pieces.filter((r) => r.top === top).map((r) => r.height));
      return pieces.filter((r) => r.top + r.height / 2 < top + lh);
    })();
  const left = Math.min(...line.map((r) => r.left));
  const right = Math.max(...line.map((r) => r.right));
  const top = Math.min(...line.map((r) => r.top));
  const bottom = Math.max(...line.map((r) => r.bottom));
  return new DOMRect(left, top, right - left, bottom - top);
}

function textRects(nodes: Node[]): DOMRect[] {
  const out: DOMRect[] = [];
  for (const n of nodes) {
    const range = n.ownerDocument!.createRange();
    range.selectNodeContents(n);
    out.push(...Array.from(range.getClientRects()));
  }
  return out;
}

/** The block's last line of text, in the coordinates of its own document. Text
 *  boxes only: a range over the block also returns its child blocks' whole
 *  boxes (a list item's paragraph, a nested list), as wide as the block. */
export function lastLineRect(block: Element): DOMRect | null {
  const walker = block.ownerDocument.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Node[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (wordsNode(n)) nodes.push(n);
  // The last few text nodes hold the last line (a line seldom spans more).
  return lineOf(textRects(nodes.slice(-8)), 'last');
}

/** The lines of text just before and just after the block inside `body` (the
 *  words the chip must not cover when it goes over or under the block). */
export function neighbourLines(block: Element, body: Element): DOMRect[] {
  const doc = block.ownerDocument;
  const out: DOMRect[] = [];
  const walker = doc.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  walker.currentNode = block;
  for (let n = walker.previousNode(); n; n = walker.previousNode()) {
    if (!wordsNode(n)) continue;
    const line = lineOf(textRects([n]), 'last');
    if (line) out.push(line);
    break;
  }
  // After the block's own text: from its last descendant on.
  let last: Node = block;
  while (last.lastChild) last = last.lastChild;
  walker.currentNode = last;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (block.contains(n) || !wordsNode(n)) continue;
    const line = lineOf(textRects([n]), 'first');
    if (line) out.push(line);
    break;
  }
  return out;
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
 * Where the card sits inside the file view: right-aligned to the passage, never
 * outside the host box, and never over the passage when the box has room for it
 * on either side. The room a side must have is the card's own height (`need`,
 * its content uncapped) when that is smaller than FILE_CARD_MIN_HEIGHT, else
 * FILE_CARD_MIN_HEIGHT (no `need`: FILE_CARD_MIN_HEIGHT):
 *  - under the passage's last line when that room is there;
 *  - else over its first line (anchored by its bottom edge, `bottom`, so it grows
 *    upward and its foot never reaches the passage), when it fits there;
 *  - else on the side with more room, as tall as that room (the passage is taller
 *    than the box leaves room for).
 * 2026-11-06 (later): a ~70px draft card with 135px free under a passage near
 * the end of the Changed tab's rendered diff still hung above, over the lines
 * before the passage, because the side was chosen for a 180px card.
 * 2026-11-06: the card was always placed under the passage and then pushed up
 * to keep FILE_CARD_MIN_HEIGHT in the box, so a passage in the box's last 188px
 * (the Changed tab's rendered diff, a selection near the bottom of any view) had
 * the card drawn ON it and the line above it.
 * The card stays with its passage: it is never pushed off it to keep a height in the
 * box, it is shorter instead (its body scrolls), and it goes to the other side when
 * that has more room. A passage out of the box is `away` (placeFileCardBelow) and its
 * card is not drawn. 2026-11-11 review: a card pushed up to keep its height, or docked
 * at an edge, stayed put while its passage scrolled on and away, so an answered card
 * (tall: it docked early) floated over other lines while an empty one (short) seemed
 * to follow.
 */
export function placeFileCard(
  anchor: HostRect, host: { width: number; height: number }, preferred = CARD_WIDTH, minLeft?: number, need?: number,
): ThreadCardPlace {
  // `minLeft`: where the text column starts (a code view's line-number gutter
  // ends there). The card stays right of it, narrowed down to its minimum width
  // to fit; a view too narrow even for that lets it go back over the gutter.
  const floorAt = Math.max(CARD_GAP, Math.round(minLeft ?? 0));
  const fits = (w: number) => host.width - floorAt - CARD_GAP >= w;
  const floor = fits(CARD_MIN_WIDTH) ? floorAt : CARD_GAP;
  const band = host.width - floor - CARD_GAP;
  // Never wider than the box less a gap each side: a box narrower than the
  // card's minimum (a narrow window, the file tree beside it) shrinks the card
  // to fit instead of clipping its right edge and its buttons (2026-11-08).
  const avail = Math.max(0, host.width - 2 * CARD_GAP);
  const width = Math.min(avail, Math.max(Math.min(preferred, band), CARD_MIN_WIDTH));
  const left = Math.max(floor, Math.min(anchor.right - width, host.width - width - CARD_GAP));
  // The room a side must have: the card's own height when it is smaller.
  const least = need !== undefined && Number.isFinite(need) && need > 0
    ? Math.min(Math.ceil(need), FILE_CARD_MIN_HEIGHT) : FILE_CARD_MIN_HEIGHT;
  const roomBelow = host.height - (anchor.bottom + CARD_GAP) - CARD_GAP;
  const roomAbove = anchor.top - CARD_GAP - CARD_GAP;
  const above = roomBelow < least && (roomAbove >= least || roomAbove > roomBelow);
  const capOf = (room: number) => Math.max(0, Math.min(Math.max(FILE_CARD_MIN_HEIGHT, Math.round(host.height * 0.6)), room));
  // Expanded: the same edge, as wide as the view allows, all the room on its side.
  const wide = Math.min(Math.max(avail, width), Math.max(Math.min(CARD_GROWN_WIDTH, band), width));
  const wideLeft = Math.max(floor, Math.min(anchor.right - wide, host.width - wide - CARD_GAP));
  const across = { left: Math.round(left), width: Math.round(width) };
  if (above) {
    // The card's foot: a gap over the passage's first line, wherever that line is.
    const foot = anchor.top - CARD_GAP;
    const room = Math.max(0, foot - CARD_GAP);
    const maxHeight = capOf(room);
    return {
      top: Math.round(foot - maxHeight), bottom: Math.round(host.height - foot), ...across, maxHeight: Math.round(maxHeight),
      grown: { left: Math.round(wideLeft), width: Math.round(wide), maxHeight: Math.round(Math.max(maxHeight, room)) },
    };
  }
  const top = anchor.bottom + CARD_GAP;
  const room = Math.max(0, host.height - top - CARD_GAP);
  const maxHeight = capOf(room);
  return {
    top: Math.round(top), ...across, maxHeight: Math.round(maxHeight),
    grown: { left: Math.round(wideLeft), width: Math.round(wide), maxHeight: Math.round(Math.max(maxHeight, room)) },
  };
}

/** Marks an element over the top of a file view that a card never covers (the doc comments
 *  chip, its error line): the card's box starts under it, as under the file header. */
export const FILE_HEADER_ITEM_ATTR = 'data-file-header-item';

/**
 * placeFileCard inside the part of the view under its header (`inset` px from the top: the
 * file bar, the chips over the text). The card never reaches over the bar's breadcrumb and
 * buttons (2026-11-10 review: after a widen the card pinned over the header, and the
 * "1 comment" chip sat on the card's mic and send), and a passage scrolled out of that part
 * (under the header, past the bottom) is `away`: its card is not drawn.
 */
export function placeFileCardBelow(
  anchor: HostRect, host: { width: number; height: number }, inset: number, minLeft?: number, need?: number,
): ThreadCardPlace {
  const top = Math.max(0, Math.min(Math.round(inset), host.height - FILE_CARD_MIN_HEIGHT));
  const place = placeFileCard(
    { ...anchor, top: anchor.top - top, bottom: anchor.bottom - top },
    { width: host.width, height: host.height - top }, undefined, minLeft, need,
  );
  // `bottom` (a card over its passage) counts from the host's bottom, which did not move.
  return { ...place, top: place.top + top, ...(fileCardAway(anchor, host, top) ? { away: true } : {}) };
}

/** Is the passage wholly out of the part of the view under its header (scrolled past the top
 *  or the bottom)? Its card is then not drawn, whatever state the card is in. */
export function fileCardAway(anchor: HostRect, host: { height: number }, inset: number): boolean {
  return anchor.bottom <= inset || anchor.top >= host.height;
}

/** How far the view's header reaches into it: the sticky bar and every header item. */
export function fileHeaderInset(root: Element, bar: Element | null): number {
  const rootTop = root.getBoundingClientRect().top;
  let bottom = rootTop;
  for (const el of [bar, ...root.querySelectorAll(`[${FILE_HEADER_ITEM_ATTR}]`)]) {
    if (!el) continue;
    const r = el.getBoundingClientRect();
    if (r.width || r.height) bottom = Math.max(bottom, r.bottom);
  }
  return Math.max(0, bottom - rootTop);
}

/** How tall a comment card would be with no max height: its box now plus what
 *  its scrolling body hides (`placeFileCard`'s `need`). Null before layout. */
export function cardNaturalHeight(card: HTMLElement): number | null {
  const body = card.querySelector<HTMLElement>(':scope > .thread-card-body');
  const height = card.offsetHeight + (body ? Math.max(0, body.scrollHeight - body.clientHeight) : 0);
  return height > 0 ? height : null;
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
