/**
 * Marks in the HTML preview's page, drawn by the page's bridge (src/web/preview-bridge-script.ts).
 *
 * The console locates each anchor in the page's text with its own code (the page sends its
 * text, preview-frame.ts keeps it), then sends the page offsets into that text, tagged with
 * the text's version, and a highlight name for each. The page paints them, hit-tests clicks
 * and hovers on them, and reports the rects of the ones the console places a card or a line
 * by. Keys never leave the console: the page sees short ids (a question's key carries its
 * quote), mapped back here.
 */
import type { FrameHit, FrameMarkRects, FrameMsg } from './preview-messages';
import type { PreviewChannel } from './preview-frame';

export interface FrameMarkSpec {
  key: string;
  /** The highlight it is painted under; '' paints nothing (an anchor a card is placed by). */
  name: string;
  priority?: number;
  start: number;
  end: number;
  /** A click (and hover) on it is reported. */
  click?: boolean;
  /** Its click is the page's no more (it opens a card, not a link under it). */
  stop?: boolean;
  /** Its rects are reported (a card is placed by it). */
  rects?: boolean;
  /** Its text fragments and overflow clip are reported too (a line is drawn under it). */
  lines?: boolean;
}

export class FrameMarkGroup {
  private idOf = new Map<string, string>();
  private keyOf = new Map<string, string>();
  private rectsBy = new Map<string, FrameMarkRects>();
  private n = 0;

  constructor(readonly channel: PreviewChannel, readonly group: string) {}

  private id(key: string): string {
    let id = this.idOf.get(key);
    if (!id) {
      id = `m${++this.n}`;
      this.idOf.set(key, id);
      this.keyOf.set(id, key);
    }
    return id;
  }

  /** Paint these marks, located in the page's text of version `v`. */
  set(v: number, specs: readonly FrameMarkSpec[]): void {
    const items = specs.map((s) => ({
      id: this.id(s.key), name: s.name, priority: s.priority ?? 0, start: s.start, end: s.end,
      click: !!s.click, stop: !!s.stop, rects: !!s.rects, lines: !!s.lines,
    }));
    this.channel.send({ type: 'marks', group: this.group, v, items });
  }

  clear(): void {
    this.channel.send({ type: 'marks', group: this.group, v: 0, items: [] });
    this.rectsBy.clear();
  }

  /** Take the page's rects report (it carries every group's). */
  take(m: Extract<FrameMsg, { type: 'rects' }>): void {
    const next = new Map<string, FrameMarkRects>();
    for (const e of m.marks) {
      const key = e.group === this.group ? this.keyOf.get(e.id) : undefined;
      if (key) next.set(key, e);
    }
    this.rectsBy = next;
  }

  /** A mark's rects in the frame's viewport, as last reported. */
  rects(key: string): FrameMarkRects | undefined {
    return this.rectsBy.get(key);
  }

  entries(): IterableIterator<[string, FrameMarkRects]> {
    return this.rectsBy.entries();
  }

  /** The key of this group's mark among the page's hits, if any. */
  hit(hits: readonly FrameHit[]): string | null {
    const h = hits.find((x) => x.group === this.group);
    return h ? this.keyOf.get(h.id) ?? null : null;
  }

  /** Bring a mark to the middle of the page's scroller. */
  reveal(key: string): void {
    const id = this.idOf.get(key);
    if (id) this.channel.send({ type: 'reveal', group: this.group, id });
  }
}

/** Rects of the frame's viewport moved into the top one. */
export function toTop(rects: readonly DOMRect[], frame: DOMRect): DOMRect[] {
  return rects.map((r) => new DOMRect(r.left + frame.left, r.top + frame.top, r.width, r.height));
}

/** The bounding box of rects (null for none). */
export function unionOf(rects: readonly DOMRect[]): DOMRect | null {
  if (!rects.length) return null;
  let l = Infinity; let t = Infinity; let r = -Infinity; let b = -Infinity;
  for (const x of rects) { l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); b = Math.max(b, x.bottom); }
  return new DOMRect(l, t, r - l, b - t);
}
