/**
 * A selection in the Changed tab's diff, as a passage of the FILE (the question
 * layer's `Ask here`, FileThreadLayer with surface `diff`).
 *
 * A question about a file is anchored by `parent = file:<path>` plus a quote of
 * the file's text, found again wherever that file is drawn: the Files tab, the
 * file's rail and marks, this diff. So only text that IS in the current file can
 * be asked about here:
 *  - The diff's own chrome (gutters, unfold bars, widgets, the file head, the AI
 *    strip) is not text at all: it stays out of the index.
 *  - Removed lines are not in the current file. A selection that takes any
 *    removed text gets no `Ask here` (only `Quote in chat`, which says what it
 *    quotes): its card would have no passage to sit beside in the Files tab, and
 *    in this diff only until the base, a commit or the next edit moves it. The
 *    threads record has no "diff" parent, and inventing one for a view that
 *    changes under it would leave questions that nothing can show.
 *  - A split diff draws every unchanged line twice. Its left copy is skipped and a
 *    selection end on it moves to the same character of the right copy, so the
 *    quote reads like the file.
 *  - A selection across an unfold bar joins lines that are not adjacent in the
 *    file; the quote is checked against the file's text (whitespace aside) and
 *    refused when it is not there.
 */
import { buildTextIndex, quoteFromRange, type QuoteLines, type QuoteSkip, type TextQuote } from '@/utils/text-quote-anchor';

/** Chrome inside a diff pane that is not file text (the diff's search skips it too). */
export const DIFF_CHROME_SKIP = '.diff-gutter, .diff-widget, .session-diff-expander, .session-diff-filepane-head, .session-diff-ai-summary, .session-diff-rendered-lineno, .session-diff-pending-card';

/** A removed line's text, unified or split. */
const REMOVED_CELL = '.diff-code-delete';
/** The left (old) copy of an unchanged line in a split row: gutter, code, gutter, code. */
const OLD_COPY_CELL = '.diff-line-normal > td.diff-code:not(:last-child)';

/**
 * A blank line's cell is not empty: react-diff-view fills it with one space so
 * the row keeps its height. The Files tab's views have no text for a blank line,
 * so with the filler a passage across one (`}` blank `func`) was quoted as
 * `} func` and never found there.
 */
export function isBlankLineFiller(t: Text): boolean {
  const cell = t.parentElement;
  return t.data === ' ' && !!cell && cell.matches('td.diff-code') && cell.childNodes.length === 1;
}

/** A table row's new-side line number: its last gutter (unified: old, new;
 *  split: old, code, new, code). */
function newLineOfRow(row: Element): number | undefined {
  const gutters = row.querySelectorAll(':scope > td.diff-gutter');
  const m = /\d+/.exec(gutters[gutters.length - 1]?.textContent ?? '');
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** A table diff's rows as the file's lines: between two rows, as many line
 *  breaks as their new-side numbers are apart (a blank line between them makes
 *  two). The rendered markdown view has no rows: it reads like the Files tab's
 *  rendered views. */
export const DIFF_FILE_LINES: QuoteLines = {
  rowOf: (t) => t.parentElement?.closest('tr.diff-line') ?? null,
  breaks: (prev, next) => {
    const a = newLineOfRow(prev);
    const b = newLineOfRow(next);
    return a !== undefined && b !== undefined && b > a ? b - a : 0;
  },
};

/** What the question layer indexes in a diff pane: the current file's text only,
 *  with its line breaks. */
export const DIFF_FILE_TEXT_SKIP: QuoteSkip = {
  selector: `${DIFF_CHROME_SKIP}, ${REMOVED_CELL}, ${OLD_COPY_CELL}`,
  text: isBlankLineFiller,
  lines: DIFF_FILE_LINES,
};

export type DiffPassage =
  | { ok: true; quote: TextQuote; line?: number }
  | { ok: false; reason: 'removed' | 'not-in-file' | 'empty' };

/** Why a diff selection has no `Ask here`, in the words its pill shows. */
export const DIFF_ASK_OFF_REASON: Record<'removed' | 'not-in-file' | 'empty' | 'deleted', string> = {
  removed: 'Removed lines are not in the file, so a question cannot sit beside them: quote them in the chat',
  'not-in-file': 'This selection runs across hidden lines and is not one passage of the file: quote it in the chat',
  empty: 'Only file text can be asked about here: quote it in the chat',
  deleted: 'This file was deleted, so a question cannot sit beside it: quote it in the chat',
};

/** Does the passage occur in the file's text? Whitespace is ignored: a tab the
 *  diff draws wider, a CRLF file's `\r` (the rows hold none). PURE. */
export function occursInFile(exact: string, fileText: string): boolean {
  const needle = exact.replace(/\s+/g, '');
  if (!needle) return false;
  return fileText.replace(/\s+/g, '').includes(needle);
}

function outsideChrome(el: Element | null): boolean {
  return !!el && !el.closest(DIFF_CHROME_SKIP);
}

/** The right (new) code cell of a split row, holding `node`? */
function inRightCell(node: Node): boolean {
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const cell = el?.closest('td.diff-code');
  const row = cell?.parentElement;
  return !!cell && !!row && row.lastElementChild === cell && row.querySelectorAll(':scope > td.diff-code').length === 2;
}

/**
 * Does the range take any non-blank text of a removed line? A drag down the
 * right side of a split diff runs, in DOM order, through the left cells of the
 * rows between (gutter, old, gutter, new): with both ends on the right, the left
 * column's removed lines are not part of what the reader selected.
 */
export function selectsRemovedText(body: Element, range: Range): boolean {
  const rightOnly = inRightCell(range.startContainer) && inRightCell(range.endContainer);
  const doc = body.ownerDocument;
  // Only the selection's own subtree: a long diff has tens of thousands of tokens.
  const common = range.commonAncestorContainer;
  const root = common.nodeType === Node.TEXT_NODE ? common.parentNode ?? body : common;
  const walker = doc.createTreeWalker(body.contains(root) ? root : body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    const parent = t.parentElement;
    const removed = parent?.closest(REMOVED_CELL);
    if (!removed || !outsideChrome(parent)) continue;
    if (rightOnly && removed.parentElement?.lastElementChild !== removed) continue;
    if (!range.intersectsNode(t)) continue;
    const from = t === range.startContainer ? range.startOffset : 0;
    const to = t === range.endContainer ? range.endOffset : t.data.length;
    if (t.data.slice(from, to).trim()) return true;
  }
  return false;
}

/** Characters of `cell`'s text before the point (container, offset). */
function charsBefore(cell: Element, container: Node, offset: number): number {
  const r = cell.ownerDocument.createRange();
  r.selectNodeContents(cell);
  try { r.setEnd(container, offset); } catch { return 0; }
  return r.toString().length;
}

/** The (text node, offset) `chars` characters into `cell`, or the cell's end. */
function pointAt(cell: Element, chars: number): { node: Node; offset: number } {
  const walker = cell.ownerDocument.createTreeWalker(cell, NodeFilter.SHOW_TEXT);
  let left = chars;
  let last: Text | null = null;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const t = n as Text;
    if (left <= t.data.length) return { node: t, offset: left };
    left -= t.data.length;
    last = t;
  }
  return last ? { node: last, offset: last.data.length } : { node: cell, offset: cell.childNodes.length };
}

/** A boundary on the left copy of an unchanged split line, moved to the right copy. */
function onNewSide(container: Node, offset: number): { node: Node; offset: number } {
  const el = container.nodeType === Node.ELEMENT_NODE ? container as Element : container.parentElement;
  const cell = el?.closest(OLD_COPY_CELL);
  const twin = cell?.parentElement?.querySelector(':scope > td.diff-code:last-child');
  if (!cell || !twin) return { node: container, offset };
  return pointAt(twin, charsBefore(cell, container, offset));
}

/** The new-side line number at a point: the row's last gutter (unified: old,
 *  new; split: old, code, new, code), or a rendered block's source line. */
function lineAt(node: Node): number | undefined {
  const el = node.nodeType === Node.ELEMENT_NODE ? node as Element : node.parentElement;
  const row = el?.closest('tr.diff-line');
  if (row) return newLineOfRow(row);
  const text = el?.closest('.session-diff-rendered-row')?.querySelector('.session-diff-rendered-lineno')?.textContent;
  const m = text ? /\d+/.exec(text) : null;
  const n = m ? Number(m[0]) : NaN;
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * The selection as a passage of the current file, or why it is not one.
 * `fileText` is the file's current text, or null where the pane draws nothing
 * but it (the rendered markdown view renders the whole new file).
 */
export function diffPassageOf(body: Element, range: Range, fileText: string | null): DiffPassage {
  if (selectsRemovedText(body, range)) return { ok: false, reason: 'removed' };
  const r = range.cloneRange();
  const start = onNewSide(r.startContainer, r.startOffset);
  const end = onNewSide(r.endContainer, r.endOffset);
  try {
    r.setStart(start.node, start.offset);
    r.setEnd(end.node, end.offset);
  } catch { /* keep the selection as it was */ }
  const quote = quoteFromRange(buildTextIndex(body, DIFF_FILE_TEXT_SKIP), r);
  if (!quote) return { ok: false, reason: 'empty' };
  if (fileText !== null && !occursInFile(quote.exact, fileText)) return { ok: false, reason: 'not-in-file' };
  const line = lineAt(r.startContainer);
  return { ok: true, quote, ...(line ? { line } : {}) };
}
