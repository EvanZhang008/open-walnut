/**
 * A highlight that leaves the registry is emptied first, because WebKit (the Mac
 * app) keeps its words painted on screen otherwise (web/src/utils/highlight-repaint.ts;
 * 2026-11-02: a doc comment's paint stayed after Esc gave its draft up). This file
 * pins the patch and lists every source file that paints in a highlight registry
 * with the registry it paints in, so a new painter (or one in a frame that never
 * patches the frame's registry) fails here.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { keepHighlightRepaints } from '../../web/src/utils/highlight-repaint';

class FakeHighlight {
  ranges: string[];
  constructor(...ranges: string[]) { this.ranges = ranges; }
  clear() { this.ranges = []; }
}
class FakeRegistry {
  private m = new Map<string, unknown>();
  get(name: string) { return this.m.get(name); }
  set(name: string, value: unknown) { this.m.set(name, value); return this; }
  delete(name: string) { return this.m.delete(name); }
  clear() { this.m.clear(); }
  keys() { return this.m.keys(); }
}

describe('keepHighlightRepaints', () => {
  it('empties a highlight that is deleted, replaced, or cleared away', () => {
    const reg = new FakeRegistry();
    keepHighlightRepaints(reg);
    const a = new FakeHighlight('a');
    reg.set('x', a);
    reg.delete('x');
    expect(a.ranges).toEqual([]);

    const b = new FakeHighlight('b');
    const c = new FakeHighlight('c');
    reg.set('y', b);
    reg.set('y', c);
    expect(b.ranges).toEqual([]);
    expect(c.ranges).toEqual(['c']);
    // Set again with the same object: kept as it is.
    reg.set('y', c);
    expect(c.ranges).toEqual(['c']);

    reg.clear();
    expect(c.ranges).toEqual([]);
  });

  it('patches the prototype once, and never a shared built-in', () => {
    const reg = new FakeRegistry();
    keepHighlightRepaints(reg);
    const patched = FakeRegistry.prototype.set;
    keepHighlightRepaints(new FakeRegistry());
    expect(FakeRegistry.prototype.set).toBe(patched);
    expect(Object.getOwnPropertyNames(reg)).toEqual(['m']);

    const before = Map.prototype.delete;
    keepHighlightRepaints(new Map() as never);
    expect(Map.prototype.delete).toBe(before);
  });
});

describe('every highlight registry Walnut paints in is patched', () => {
  const ROOT = path.resolve(__dirname, '../../web/src');
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const full = path.join(dir, e.name);
    return e.isDirectory() ? walk(full) : /\.(ts|tsx)$/.test(e.name) ? [full] : [];
  });
  const painters = walk(ROOT)
    .map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }))
    .filter(({ file, text }) => file !== 'utils/highlight-repaint.ts' && /\.highlights\b/.test(text));

  // Each file that reaches a registry, and why its registry is patched.
  const MAIN = 'the app document: patched at boot by installHighlightRules (main.tsx)';
  const FRAME = 'a frame window: calls keepWindowHighlightRepaints on it';
  const PAINTERS: Record<string, string> = {
    'utils/highlight-rules.ts': MAIN,
    'utils/pin-highlights.ts': MAIN,
    'utils/page-find.ts': MAIN,
    'hooks/useThreadMarks.ts': MAIN,
    'hooks/useQuotePinPaint.ts': MAIN,
    'components/sessions/EngineSettingsPopoverBody.tsx': MAIN,
    'components/sessions/SessionDiffView.tsx': MAIN,
    'utils/dom-text-search.ts': FRAME,
    'components/common/FileThreadLayer.tsx': FRAME,
    'components/common/doc-comments-dom.ts': FRAME,
  };

  it('lists every file that paints, with its registry', () => {
    expect(painters.map((p) => p.file).sort(), 'a new painter: say which registry it paints in, and patch a frame\'s').toEqual(Object.keys(PAINTERS).sort());
  });

  it('a frame painter patches the frame\'s registry; the app\'s is patched at boot', () => {
    for (const { file, text } of painters) {
      if (PAINTERS[file] === FRAME) expect(text, file).toMatch(/keepWindowHighlightRepaints\(/);
      // An app-document painter never reaches into another window's registry.
      if (PAINTERS[file] === MAIN && file !== 'utils/highlight-rules.ts') expect(text, file).not.toMatch(/defaultView|contentWindow|contentDocument/);
    }
    const rules = painters.find((p) => p.file === 'utils/highlight-rules.ts')!.text;
    expect(rules).toMatch(/keepHighlightRepaints\(registry\)/);
    expect(fs.readFileSync(path.join(ROOT, 'main.tsx'), 'utf8')).toMatch(/installHighlightRules\(\)/);
  });
});
