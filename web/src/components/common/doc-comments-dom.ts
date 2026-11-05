/**
 * The DOM half of DocCommentsLayer: where a view's text lives, the paint the HTML
 * preview's page is sent for its comments (its bridge paints them there), how a
 * passage is brought on screen, and a memo so the anchors are not matched again
 * on every frame while the text has not changed.
 */
import { docTextLocator, type DocTextLocator } from '@/utils/doc-comment-anchor';
import type { TextQuote } from '@/utils/text-quote-anchor';

export const HL_DOC_COMMENT = 'walnut-doc-comment';
export const HL_DOC_COMMENT_CURRENT = 'walnut-doc-comment-current';

export function bodyOf(root: HTMLElement | null): Element | null {
  return root?.querySelector('.ProseMirror, .fv-md-preview, .file-viewer-code, .cm-content') ?? null;
}

/** The paint in the HTML preview's page (doc-comments.css, light: the page brings its colors). */
export const FRAME_COMMENT_STYLE = `
::highlight(${HL_DOC_COMMENT}) { background-color: hsl(38 95% 55% / 0.22); text-decoration: underline 2px hsl(28 90% 48% / 0.85); text-underline-offset: 3px; }
::highlight(${HL_DOC_COMMENT_CURRENT}) { background-color: hsl(38 95% 52% / 0.42); text-decoration: underline 2px hsl(24 92% 44%); text-underline-offset: 3px; }
`;

/** The element that scrolls the doc vertically, from a node inside it. */
export function scrollerOf(node: Node | null): HTMLElement | null {
  let el = node instanceof Element ? node as HTMLElement : node?.parentElement ?? null;
  while (el && !(el.scrollHeight > el.clientHeight + 1 && /(auto|scroll)/.test(getComputedStyle(el).overflowY))) el = el.parentElement;
  // A page (the HTML preview's) scrolls its root, whose overflow reads visible.
  return el ?? (node?.ownerDocument?.scrollingElement as HTMLElement | null | undefined) ?? null;
}

/** Bring a passage to the middle of its scroller, vertically only: scrollIntoView
 *  also scrolls a code editor sideways, under its sticky line numbers. */
export function reveal(range: Range): void {
  const el = scrollerOf(range.startContainer);
  if (!el) return;
  const rect = range.getBoundingClientRect();
  const doc = el.ownerDocument;
  const root = el === doc.scrollingElement;
  const box = root ? { top: 0, height: doc.defaultView?.innerHeight ?? el.clientHeight } : el.getBoundingClientRect();
  el.scrollTop += rect.top - (box.top + box.height / 2);
}

/** Anchors located once per text: a scroll that redraws the same text matches nothing again. */
export class LocateMemo {
  private text: string | null = null;
  private loc: DocTextLocator | null = null;
  private hits = new Map<TextQuote, { start: number; end: number } | null>();

  locate(text: string, markup: boolean, quote: TextQuote): { start: number; end: number } | null {
    if (text !== this.text) {
      this.text = text;
      this.loc = docTextLocator(text, markup);
      this.hits = new Map();
    }
    if (!this.hits.has(quote)) this.hits.set(quote, this.loc!.locate(quote));
    return this.hits.get(quote)!;
  }
}
