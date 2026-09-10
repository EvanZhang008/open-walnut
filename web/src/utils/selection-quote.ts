/**
 * What passage is selected in a session timeline?
 *
 * ONE implementation of that question, because two callers ask it about the same
 * gesture: the quote pill (offer Copy / Pin / Ask on the passage) and the composer's
 * dictation path (the passage a voice question is about). A second copy would drift,
 * and the two would disagree about whether a passage can be anchored at all.
 *
 * ⚠️ CAPTURE WHILE THE SELECTION STILL EXISTS. Every quote-to-ask surface in this
 * app captures at gesture time, because a selection does not survive the things that
 * follow it: the instant-clear guard in `main.tsx` runs on mousedown ahead of every
 * app handler, and moving focus into the composer collapses the document selection
 * outright. By the time a click or a transcript is being handled, there is nothing
 * left to read.
 */
import { buildTextIndex, quoteFromRange, type TextQuote } from '@/utils/text-quote-anchor';

export interface SelectionQuote {
  /**
   * The row's id, when the passage sits in a row that HAS one. A streaming block
   * that has not been told its message id yet is prose all the same: Copy needs no
   * identity, so a passage is still captured and only Pin/Ask stand down.
   */
  msgId?: string;
  role: 'user' | 'assistant' | 'system';
  timestamp?: string;
  /** Captured from the message's text index while the selection still exists. */
  quote: TextQuote;
  /** What the browser says was selected — what Copy puts on the clipboard. */
  text: string;
}

const EDITABLE = 'input, textarea, [contenteditable="true"], [contenteditable=""]';

function roleOf(value: string | null | undefined): 'user' | 'assistant' | 'system' {
  return value === 'user' || value === 'system' ? value : 'assistant';
}

/** The message body a selection lives in, or null when the selection is not one
 *  message's prose: both ends must sit in the SAME `.session-msg-content` inside
 *  this container, in the top document, outside any editable control.
 *
 *  A `[data-message-id]` ancestor is NOT required — a live streaming block is a
 *  message body before it is told its id, and the reader watching that answer
 *  arrive is exactly who wants to copy a line out of it. */
export function selectionBody(container: HTMLElement, selection: Selection): Element | null {
  if (selection.isCollapsed || selection.rangeCount === 0) return null;
  const { anchorNode, focusNode } = selection;
  if (!anchorNode || !focusNode) return null;
  // A rich-HTML island renders in an iframe: its selection lives in another
  // document and cannot be anchored against this one's text index.
  if (anchorNode.ownerDocument !== document || focusNode.ownerDocument !== document) return null;
  const anchorEl = anchorNode.nodeType === Node.ELEMENT_NODE
    ? (anchorNode as Element)
    : anchorNode.parentElement;
  const focusEl = focusNode.nodeType === Node.ELEMENT_NODE
    ? (focusNode as Element)
    : focusNode.parentElement;
  if (!anchorEl || !focusEl) return null;
  if (anchorEl.closest(EDITABLE) || focusEl.closest(EDITABLE)) return null;
  const body = anchorEl.closest('.session-msg-content');
  if (!body || body !== focusEl.closest('.session-msg-content')) return null;
  if (!container.contains(body)) return null;
  return body;
}

/**
 * The selected passage, or null when the selection is not one message's prose.
 *
 * The quote MUST come from the body's text index rather than `selection.toString()`:
 * toString() serializes LAYOUT (block breaks become newlines, runs collapse), so its
 * string does not exist in the index and the passage could never be located again.
 */
export function captureSelectionQuote(container: HTMLElement, selection: Selection): SelectionQuote | null {
  const body = selectionBody(container, selection);
  if (!body) return null;
  const text = selection.toString();
  if (!text.trim()) return null;
  const range = selection.getRangeAt(selection.rangeCount - 1);
  // Indexing ONE message body per gesture tick — a paragraph, so microseconds.
  const quote = quoteFromRange(buildTextIndex(body), range);
  if (!quote) return null;
  const row = body.closest('[data-message-id]') as HTMLElement | null;
  const msgId = row?.getAttribute('data-message-id') ?? undefined;
  const timestamp = row?.getAttribute('data-msg-ts') ?? undefined;
  return {
    ...(msgId ? { msgId } : {}),
    role: roleOf(row?.getAttribute('data-msg-role')),
    ...(timestamp ? { timestamp } : {}),
    quote,
    text,
  };
}

/**
 * Is any part of the selection still inside the scroller's box?
 *
 * Two callers, same question. The pill uses it to decide whether it still has
 * anything to point at (a pill clamped to the viewport edge over unrelated words is
 * worse than no pill). The dictation path uses it as the FRESHNESS test a selection
 * otherwise has none of: a passage the reader selected and scrolled away from
 * minutes ago must not silently become the anchor for whatever they say next.
 */
export function selectionVisibleIn(container: HTMLElement, selection: Selection): boolean {
  if (selection.rangeCount === 0) return false;
  const box = container.getBoundingClientRect();
  const r = selection.getRangeAt(selection.rangeCount - 1).getBoundingClientRect();
  if (!r.width && !r.height) return false;
  // Both axes: a wide code block scrolls sideways inside a message.
  return r.bottom > box.top && r.top < box.bottom && r.right > box.left && r.left < box.right;
}

/**
 * Can a thread anchor name this passage? An anchor names its parent by the reply's
 * row id, so a passage with no id yet (a streaming block before `message_start`
 * lands) cannot hold one, and neither can a synthetic `queue-…` echo — a user line
 * the parser re-emitted is not a reply to ask about. "Ask about this" means asking
 * about a REPLY, so user/system rows stand down too.
 */
export function canAnchorQuote(
  captured: SelectionQuote | null | undefined,
): captured is SelectionQuote & { msgId: string } {
  return !!captured?.msgId && captured.role === 'assistant' && !captured.msgId.startsWith('queue-');
}
