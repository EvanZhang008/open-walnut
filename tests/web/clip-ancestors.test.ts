/**
 * Which ancestors clip an element (web/src/utils/clip-ancestors.ts). 2026-11-10 review: a
 * full-screen Files sheet is `position: fixed` inside the old one-column panel's
 * `overflow: hidden`, and the Ask here / Quote in chat toolbar was clamped into that column.
 *
 * The node tier has no DOM, so a small element model stands in: each element carries its
 * computed style and its box.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { clippingAncestors, type ClipStyle } from '../../web/src/utils/clip-ancestors';
import { clipBoxesOf, placeToolbar, roomyBox } from '../../web/src/utils/toolbar-bounds';

type Box = { left: number; top: number; right: number; bottom: number };
interface Fake { name: string; parentElement: Fake | null; nodeType: 1; ownerDocument: { documentElement: Fake | null; defaultView: unknown }; style: ClipStyle; box: Box; getBoundingClientRect(): Box & { width: number; height: number } }

const STYLE: ClipStyle = {
  position: 'static', overflowX: 'visible', overflowY: 'visible', transform: 'none', perspective: 'none',
  filter: 'none', backdropFilter: 'none', contain: 'none', willChange: 'auto', containerType: 'normal',
  contentVisibility: 'visible', clipPath: 'none', mask: 'none',
};
const doc = { documentElement: null as Fake | null, defaultView: { getComputedStyle: (el: Fake) => el.style } };
function el(name: string, parent: Fake | null, style: Partial<ClipStyle> = {}, box: Box = { left: 0, top: 0, right: 1600, bottom: 900 }): Fake {
  return {
    name, parentElement: parent, nodeType: 1, ownerDocument: doc, style: { ...STYLE, ...style }, box,
    getBoundingClientRect() { return { ...this.box, width: this.box.right - this.box.left, height: this.box.bottom - this.box.top }; },
  };
}
const names = (n: Fake) => clippingAncestors(n as unknown as Node).map((c) => (c.el as unknown as Fake).name);

/** The reported page: a one-column panel (overflow hidden, 600px wide) holding a full-screen sheet. */
function page() {
  const html = el('html', null);
  doc.documentElement = html;
  const body = el('body', html);
  const column = el('column', body, { overflowX: 'hidden', overflowY: 'hidden' }, { left: 1000, top: 0, right: 1600, bottom: 900 });
  const panel = el('panel', column, { overflowX: 'hidden', overflowY: 'hidden', position: 'relative' }, { left: 1000, top: 0, right: 1600, bottom: 900 });
  const sheet = el('sheet', panel, { position: 'fixed', overflowX: 'hidden', overflowY: 'hidden' }, { left: 40, top: 40, right: 1560, bottom: 860 });
  const pane = el('pane', sheet, { overflowX: 'auto', overflowY: 'auto' }, { left: 300, top: 80, right: 1560, bottom: 860 });
  const text = el('text', pane);
  return { body, column, panel, sheet, pane, text };
}

beforeEach(() => {
  const g = globalThis as Record<string, unknown>;
  g.window = { innerWidth: 1600, innerHeight: 900, getComputedStyle: (e: Fake) => e.style };
});
afterEach(() => { delete (globalThis as Record<string, unknown>).window; });

describe('clippingAncestors', () => {
  it('the reported case: a fixed sheet is not cut by the narrower column it sits in', () => {
    const p = page();
    expect(names(p.text)).toEqual(['pane', 'sheet']);
  });

  it('the old column still clips once the sheet is not fixed (the column view)', () => {
    const p = page();
    p.sheet.style = { ...p.sheet.style, position: 'relative' };
    expect(names(p.text)).toEqual(['pane', 'sheet', 'panel', 'column']);
  });

  it('a fixed element under a transform is held by it, and clipped by it and everything above', () => {
    const p = page();
    p.panel.style = { ...p.panel.style, transform: 'translateX(0px)' };
    expect(names(p.text)).toEqual(['pane', 'sheet', 'panel', 'column']);
    // contain: paint, a filter and will-change: transform make the same containing block.
    for (const over of [{ contain: 'paint' }, { filter: 'blur(1px)' }, { willChange: 'transform' }] as Partial<ClipStyle>[]) {
      const q = page();
      q.column.style = { ...q.column.style, ...over };
      expect(names(q.text), JSON.stringify(over)).toEqual(['pane', 'sheet', 'column']);
    }
  });

  it('an absolute element escapes unpositioned overflow, not a positioned one', () => {
    const html = el('html', null);
    doc.documentElement = html;
    const outer = el('outer', html, { overflowX: 'hidden', overflowY: 'hidden' });
    const holder = el('holder', outer, { overflowX: 'hidden', overflowY: 'hidden', position: 'relative' });
    const plain = el('plain', holder, { overflowX: 'hidden', overflowY: 'hidden' });
    const pop = el('pop', plain, { position: 'absolute' });
    const inner = el('inner', pop);
    expect(names(inner)).toEqual(['holder', 'outer']);
  });

  it('a clip-path clips a fixed descendant too', () => {
    const p = page();
    p.column.style = { ...p.column.style, clipPath: 'inset(0)' };
    expect(names(p.text)).toEqual(['pane', 'sheet', 'column']);
  });

  it('clipBoxesOf: the toolbar stays inside the sheet, not inside the column it left', () => {
    const p = page();
    const boxes = clipBoxesOf(p.text as unknown as Element);
    // Innermost: the pane cut by the sheet; then the sheet; then the viewport. No 600px column.
    expect(boxes.map((b) => b.left)).toEqual([300, 40, 0]);
    const box = roomyBox(boxes, 220, 30);
    const at = placeToolbar({ left: 320, top: 400, right: 900, bottom: 420 }, 330, { w: 220, h: 30 }, box, true);
    expect(at.left).toBeLessThan(1000); // before the fix it was clamped into the column (left >= 1004)
  });
});

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('guard: every visible-box measure asks the one clip rule', () => {
  // The class: code that decides an ancestor clips by its overflow ("not visible", or a regex of
  // the clipping values). Each such file must take its ancestors from clippingAncestors, or a
  // fixed or absolute element is measured against a box it escaped.
  const DECIDES_CLIP = /overflow[XY]?\s*[!=]==\s*['"]visible['"]|\(auto\|scroll\|hidden\|clip\)/;
  const all = sources(WEB).map((p) => ({ p: path.relative(WEB, p), s: readFileSync(p, 'utf8') }));

  // Code that reads an overflow for another question than a visible box: each one's method is
  // taken out before the scan, so a real measure added beside it in the same file still counts.
  const NOT_A_MEASURE: Record<string, { method: string; why: string }> = {
    'utils/page-find.ts': { method: 'private needsSolid(', why: 'a clipping ancestor means the match box is drawn solid; nothing is measured' },
    'utils/truncation-peek-row.ts': { method: "// Up to the list's scroller: a box that cut a text to its own height grows with it.", why: 'an expanded row marks the boxes between its text and its list that cut the text, so they grow with it; nothing is measured against a clip' },
  };
  const withoutOthers = (f: { p: string; s: string }) => {
    const other = NOT_A_MEASURE[f.p];
    if (!other) return f.s;
    const at = f.s.indexOf(other.method);
    expect(at, `${f.p}: ${other.method}`).toBeGreaterThan(-1);
    const end = f.s.indexOf('\n  }\n', at);
    return f.s.slice(0, at) + f.s.slice(end);
  };

  it('finds the measures it guards, and each one walks clippingAncestors', () => {
    const members = all.filter((f) => f.p !== 'utils/clip-ancestors.ts' && DECIDES_CLIP.test(withoutOthers(f))).map((f) => f.p).sort();
    // Each listed other use still reads an overflow (or its entry goes).
    for (const p of Object.keys(NOT_A_MEASURE)) expect(DECIDES_CLIP.test(all.find((f) => f.p === p)!.s), p).toBe(true);
    // page-find-geometry keeps its own per-axis scroll facts, read only for the ancestors the rule gives.
    expect(members).toEqual(['utils/page-find-geometry.ts']);
    for (const p of members) expect(all.find((f) => f.p === p)!.s, p).toMatch(/clippingAncestors\(/);
  });

  it('the visible-box measures of the toolbars, the live lines, page find and plugin bounds use it', () => {
    for (const p of ['utils/toolbar-bounds.ts', 'components/notes/NotesBubbleMenu.tsx', 'utils/thread-live-lines.ts', 'utils/page-find-geometry.ts', 'plugins/plugin-bounds.ts', 'utils/truncation-peek.ts']) {
      expect(all.find((f) => f.p === p)?.s, p).toMatch(/clippingAncestors\(/);
    }
  });

  it('the bubble menu moves itself by a difference, never writes a window x into its fixed left', () => {
    const s = all.find((f) => f.p === 'components/notes/NotesBubbleMenu.tsx')!.s;
    expect(s).not.toMatch(/menu\.style\.left = `\$\{Math\.round\(at\)\}px`/);
    expect(s).toMatch(/menu\.style\.left = `\$\{Math\.round\(\(Number\.isFinite\(base\) \? base : r\.left\) \+ at - r\.left\)\}px`/);
  });
});
