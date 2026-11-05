/**
 * Room for the passage Comment box INSIDE the conversation, under the block the
 * passage ends in, so the box covers nothing the reader is looking at: not the
 * passage, not the rest of its paragraph, not the next paragraph or the table
 * under it, not the composer (2026-11-04, the user's screenshot of the box sitting
 * on the selected lines and the first table row; then two reviewers, of a box
 * placed under the passage: it still hid the words right after it, and at the
 * bottom of the timeline it lay on the composer's Send button).
 *
 * The block's bottom margin grows by the box's height while the box is open, so
 * what follows moves down and the box sits in the gap; closing it puts the margin
 * back. The block is markdown output with no style of its own; when a re-render
 * replaces it (a reply still streaming in), useCommentGap reopens the gap under
 * the block the passage ends in then.
 */

/** The elements a passage can end in that make a sensible line to open under. */
const BLOCKS = 'p, li, pre, blockquote, table, h1, h2, h3, h4, h5, h6';

/** The message body a node is in (the column the box lines up with). */
export function messageColumnOf(node: Node | null): HTMLElement | null {
  const el = node && (node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement);
  return el?.closest<HTMLElement>('.session-msg-content') ?? null;
}

/**
 * The block the passage ends in: the paragraph, list item, quote, code block,
 * table or heading holding its last character, inside its message body. A list
 * item inside a list is the item, so the gap opens under the item, not the list.
 */
export function passageEndBlock(range: Range): HTMLElement | null {
  const column = messageColumnOf(range.endContainer);
  if (!column) return null;
  // A user message is a shrink-wrapped bubble: a gap inside it would stretch the
  // coloured bubble around the box. Open under the whole bubble instead.
  const bubble = column.closest<HTMLElement>('.session-msg-user');
  if (bubble) return bubble;
  const end = range.endContainer.nodeType === Node.ELEMENT_NODE
    ? (range.endContainer as Element)
    : range.endContainer.parentElement;
  // A table cell's own paragraph would put the gap inside the table: open under the table.
  const table = end?.closest<HTMLElement>('table');
  if (table && column.contains(table)) return table;
  const block = end?.closest<HTMLElement>(BLOCKS);
  return block && column.contains(block) ? block : column;
}

export interface CommentGap {
  /** Resize the room as the box grows. */
  update: (height: number) => void;
  /** Give the text its own spacing back. */
  close: () => void;
  /** The bottom of the room (viewport px), for the reveal. */
  bottom: () => number;
}

/**
 * Make `block`'s bottom margin `height` px (never less than its own), so the box
 * gets the same room above and below whatever margin the block had. Always under
 * the block, never inside it: a room opened mid-paragraph cut a sentence in two (the
 * rest read like a new paragraph starting mid-sentence), and in WebKit the split
 * text lost the passage's mark (2026-11-05, two reviewers); the box's "On ..." line
 * says which words it is about when the paragraph runs on past them.
 */
export function openGapUnder(block: HTMLElement, height: number): CommentGap {
  const inline = block.style.marginBottom;
  const base = parseFloat(getComputedStyle(block).marginBottom) || 0;
  const set = (h: number) => { block.style.marginBottom = `${Math.round(Math.max(base, h))}px`; };
  set(height);
  block.dataset.commentGap = 'open';
  return {
    update: set,
    close: () => {
      block.style.marginBottom = inline;
      delete block.dataset.commentGap;
    },
    bottom: () => block.getBoundingClientRect().bottom + Math.max(base, parseFloat(block.style.marginBottom) || 0),
  };
}

/**
 * Scroll `scroller` the least needed so the band [top, bottom] (viewport px) is
 * inside its visible box, with `margin` px to spare. The top wins when the band is
 * taller than the box (the passage stays in sight, the box's own end may not).
 */
export function revealBand(scroller: HTMLElement, top: number, bottom: number, margin = 12): void {
  const box = scroller.getBoundingClientRect();
  const over = bottom + margin - box.bottom;
  const under = box.top + margin - top;
  if (over > 0) scroller.scrollTop += Math.min(over, Math.max(0, top - box.top - margin));
  else if (under > 0) scroller.scrollTop -= under;
}
