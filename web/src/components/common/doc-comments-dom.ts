/**
 * The DOM half of DocCommentsLayer: where a view's text lives (the top document,
 * or the HTML preview's same-origin frame), how its comments are painted there,
 * how a passage is brought on screen, and a memo so the anchors are not matched
 * again on every frame while the text has not changed.
 */
import { docTextLocator, type DocTextLocator } from '@/utils/doc-comment-anchor';
import type { TextQuote } from '@/utils/text-quote-anchor';
import { keepWindowHighlightRepaints } from '@/utils/highlight-repaint';

export const HL_DOC_COMMENT = 'walnut-doc-comment';
export const HL_DOC_COMMENT_CURRENT = 'walnut-doc-comment-current';

export function bodyOf(root: HTMLElement | null): Element | null {
  return root?.querySelector('.ProseMirror, .fv-md-preview, .file-viewer-code, .cm-content') ?? null;
}

export function frameDocOf(frame: HTMLIFrameElement | null): Document | null {
  // A cross-origin navigation inside the preview throws here: no comments then.
  try { return frame?.contentDocument ?? null; } catch { return null; }
}

const FRAME_STYLE_ID = 'walnut-doc-comments';
/** The paint in the HTML preview's own document (doc-comments.css, light: the page brings its colors). */
const FRAME_STYLE = `
::highlight(${HL_DOC_COMMENT}) { background-color: hsl(38 95% 55% / 0.22); text-decoration: underline 2px hsl(28 90% 48% / 0.85); text-underline-offset: 3px; }
::highlight(${HL_DOC_COMMENT_CURRENT}) { background-color: hsl(38 95% 52% / 0.42); text-decoration: underline 2px hsl(24 92% 44%); text-underline-offset: 3px; }
`;

type FrameWindow = Window & { CSS?: { highlights?: Map<string, unknown> }; Highlight?: new (...r: Range[]) => object };

/** Paint into the frame's own highlight registry (the top one cannot reach its ranges). */
export function paintFrame(doc: Document | null, open: Range[], current: Range[]): void {
  const w = doc?.defaultView as FrameWindow | null | undefined;
  const reg = w?.CSS?.highlights;
  const Ctor = w?.Highlight;
  if (!doc || !reg || !Ctor) return;
  keepWindowHighlightRepaints(w);
  if (!doc.getElementById(FRAME_STYLE_ID) && doc.head) {
    const style = doc.createElement('style');
    style.id = FRAME_STYLE_ID;
    style.textContent = FRAME_STYLE;
    doc.head.appendChild(style);
  }
  for (const [name, ranges] of [[HL_DOC_COMMENT, open], [HL_DOC_COMMENT_CURRENT, current]] as const) {
    if (ranges.length) reg.set(name, new Ctor(...ranges)); else reg.delete(name);
  }
}

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

/**
 * The frame's document while it shows THIS file: a link followed inside the
 * preview (same origin) shows another page, whose words are not this doc's.
 */
export function frameDocFor(frame: HTMLIFrameElement | null): Document | null {
  const doc = frameDocOf(frame);
  if (!doc || !frame?.src) return doc;
  const page = (u: string) => u.replace(/#.*$/, '');
  return page(doc.URL) === page(frame.src) ? doc : null;
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
