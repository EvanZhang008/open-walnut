/**
 * The DOM half of utils/reading-line.ts: which surface of a file view is on show, which
 * source line is at its top, and how to bring a line back to its top.
 *
 * The surfaces: the source editor (CodeMirror, `cm`: it draws only the lines near its
 * viewport, so its own height map names lines), the read-only code view (`pre`: `data-line`
 * rows), and Preview (`md`, the read-only render, and `wys`, the editable one: their text is
 * the source's words, matched through reading-line.ts).
 */
import { EditorView } from '@codemirror/view';
import { foldText, lineCount, renderedIndexOfLine, sourceLineOfText } from './reading-line';
import { topCaret } from './reading-place';
import type { FileViewKind } from './file-view-state';

export type ReadingKind = Exclude<FileViewKind, 'html'>;
/** A surface that can say its line. The HTML preview cannot (its page is in another origin). */
export interface LineSurface { kind: ReadingKind; scroller: HTMLElement; body: HTMLElement }

/** The bodies of each surface, at most one on show. */
const BODIES: ReadonlyArray<readonly [ReadingKind, string]> = [
  ['cm', '.fv-source-editor .cm-editor'],
  ['wys', '.fv-wysiwyg-editor'],
  ['md', '.fv-md-preview'],
  ['pre', '.file-viewer-code'],
];

/**
 * The element that actually scrolls a file body: the markdown preview and the editors scroll
 * themselves, while the plain-source `<pre>` only scrolls HORIZONTALLY and its vertical
 * scroller is an ancestor (the explorer's pane, the fullscreen overlay, the pop-out root).
 */
export function findScroller(start: HTMLElement | null): HTMLElement | null {
  let el: HTMLElement | null = start;
  while (el && el !== document.body) {
    const overflowY = getComputedStyle(el).overflowY;
    if (/auto|scroll|overlay/.test(overflowY) && el.scrollHeight > el.clientHeight + 1) return el;
    el = el.parentElement;
  }
  return null;
}

/** The surface on show in a file view, with its scroller (null: none, or nothing to scroll yet). */
export function lineSurfaceOf(root: HTMLElement | null): LineSurface | null {
  if (!root) return null;
  for (const [kind, sel] of BODIES) {
    const body = root.querySelector<HTMLElement>(sel);
    if (!body) continue;
    const scroller = findScroller(kind === 'cm' ? body.querySelector<HTMLElement>('.cm-scroller') ?? body : body);
    return scroller ? { kind, scroller, body } : null;
  }
  return null;
}

/** The source line at a share of the document, when its text cannot be matched. */
function lineAtShare(source: string, share: number): number {
  return 1 + Math.round(Math.max(0, Math.min(1, share)) * (lineCount(source) - 1));
}

function scrollShare(s: LineSurface): number {
  const max = s.scroller.scrollHeight - s.scroller.clientHeight;
  return max > 0 ? s.scroller.scrollTop / max : 0;
}

/** The rendered text from a point onward, up to `max` characters (across the following text nodes). */
function textFrom(body: HTMLElement, node: Text, offset: number, max = 120): string {
  let out = node.data.slice(offset);
  const walker = body.ownerDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  walker.currentNode = node;
  for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) out += ` ${(n as Text).data}`;
  return out.slice(0, max);
}

/** The source line at the top of the surface (1-based). `source` is the text the surface shows. */
export function readTopLine(s: LineSurface, source: string): number {
  if (s.scroller.scrollTop < 2) return 1;
  if (s.kind === 'cm') {
    const view = EditorView.findFromDOM(s.body);
    if (view) {
      const top = s.scroller.getBoundingClientRect().top - view.documentTop + 2;
      return view.state.doc.lineAt(view.lineBlockAtHeight(Math.max(0, top)).from).number;
    }
    return lineAtShare(source, scrollShare(s));
  }
  const at = topCaret(s);
  if (s.kind === 'pre') {
    const el = at ? ('el' in at ? at.el : at.node.parentElement) : null;
    const row = el?.closest('[data-line]');
    const n = row ? Number(row.getAttribute('data-line')) : NaN;
    return Number.isFinite(n) && n > 0 ? n : lineAtShare(source, scrollShare(s));
  }
  // A block hit with no character (an image, the gap between paragraphs) gives its own words,
  // unless it is a container of the whole text (the editor's root), whose words start at line 1.
  const blockText = at && 'el' in at ? at.el.textContent ?? '' : '';
  const snippet = !at ? '' : 'el' in at ? (blockText.length <= 400 ? blockText : '') : textFrom(s.body, at.node, at.offset);
  const share = s.scroller.scrollHeight > 0 ? s.scroller.scrollTop / s.scroller.scrollHeight : 0;
  return (snippet && sourceLineOfText(source, snippet, share)) || lineAtShare(source, scrollShare(s));
}

/** Where Preview draws a source line: the viewport top of its words, or null when they are not found. */
function renderedTopOf(s: LineSurface, source: string, line: number): number | null {
  const nodes: Text[] = [];
  const starts: number[] = [];
  let all = '';
  const walker = s.body.ownerDocument.createTreeWalker(s.body, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const f = foldText((n as Text).data).text;
    if (!f) continue;
    nodes.push(n as Text);
    starts.push(all.length);
    all += f;
  }
  const share = (line - 1) / Math.max(1, lineCount(source) - 1);
  const at = renderedIndexOfLine(source, line, all, share);
  if (at < 0) return null;
  let i = starts.length - 1;
  while (i > 0 && starts[i]! > at) i--;
  const node = nodes[i]!;
  const offset = foldText(node.data).map[at - starts[i]!] ?? 0;
  const range = s.body.ownerDocument.createRange();
  range.setStart(node, offset);
  range.setEnd(node, Math.min(offset + 1, node.length));
  const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
  return r && (r.width || r.height) ? r.top : null;
}

/** What one step toward a line did: it is there, it moved (look again next frame), or the
 *  document cannot reach it yet (still growing). */
export type PlaceStep = 'done' | 'moved' | 'wait';

/** One step of bringing the scroller to `target` px (a place measured in this same view). */
export function stepToTop(scroller: HTMLElement, target: number): PlaceStep {
  const max = scroller.scrollHeight - scroller.clientHeight;
  const top = Math.max(0, Math.min(Math.round(target), max));
  if (Math.abs(scroller.scrollTop - top) > 1) { scroller.scrollTop = top; return 'moved'; }
  return target > max + 1 ? 'wait' : 'done';
}

/** One step of bringing `line` to the top of the surface. */
export function stepToLine(s: LineSurface, source: string, line: number): PlaceStep {
  const { scroller } = s;
  if (line <= 1) return stepToTop(scroller, 0);
  const box = scroller.getBoundingClientRect();
  if (s.kind === 'cm') {
    const view = EditorView.findFromDOM(s.body);
    if (!view) return 'wait';
    const doc = view.state.doc;
    const block = view.lineBlockAt(doc.line(Math.min(line, doc.lines)).from);
    // The document's top in the scroller's content (its padding, a gutter above it).
    return stepToTop(scroller, block.top + view.documentTop - box.top + scroller.scrollTop);
  }
  if (s.kind === 'pre') {
    const row = s.body.querySelector(`[data-line="${line}"]`);
    if (!row) return 'wait';
    return stepToTop(scroller, scroller.scrollTop + row.getBoundingClientRect().top - box.top);
  }
  const top = renderedTopOf(s, source, line);
  if (top === null) {
    // Its words are not in Preview (a line of markup only, a link's address): the same share.
    const step = stepToTop(scroller, ((line - 1) / Math.max(1, lineCount(source) - 1)) * (scroller.scrollHeight - scroller.clientHeight));
    return step === 'moved' ? 'moved' : 'done';
  }
  return stepToTop(scroller, scroller.scrollTop + top - box.top);
}
