/**
 * A passage is brought on screen by its own box, never by its element (2026-11-09 review:
 * Ask here in a markdown Preview jumped from line 396 to line 196). A markdown file whose
 * lines have no blank line between them renders as ONE paragraph; scrolling the passage's
 * parent element to the center centered that whole paragraph, the middle of the file.
 * revealRange (utils/page-find-geometry.ts) scrolls each scroller by the passage's rect.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('bringing a passage on screen', () => {
  const all = sources(WEB).map(p => ({ p: path.relative(WEB, p), s: readFileSync(p, 'utf8') }));

  it('no code scrolls the element holding a Range into view', () => {
    // startContainer / endContainer / commonAncestorContainer, then up to an element, then scrollIntoView.
    const bad = /(startContainer|endContainer|commonAncestorContainer)[^;\n]{0,60}scrollIntoView\(/;
    expect(all.filter(f => bad.test(f.s)).map(f => f.p)).toEqual([]);
  });

  it('the file Ask card and the page search reveal the passage itself', () => {
    for (const f of ['components/common/FileThreadLayer.tsx', 'utils/dom-text-search.ts']) {
      expect(all.find(x => x.p === f)?.s, f).toMatch(/revealRange\(/);
    }
  });

  it('Ask here holds the passage where it was selected while the card and its gutter reflow the text', () => {
    // 2026-11-09, WebKit: after Ask here on line 396 the passage slid ~250px down (the gutter
    // narrowed the text before the card's first measure). The selection's place is read at the
    // press, before the selection is cleared, and the first measure pins the passage there.
    const s = all.find(x => x.p === 'components/common/FileThreadLayer.tsx')!.s;
    const ask = s.slice(s.indexOf('askSelection: ({'), s.indexOf('}), [askQuote'));
    expect(ask.indexOf('armPin(')).toBeGreaterThan(-1);
    expect(ask.indexOf('armPin(')).toBeLessThan(ask.indexOf('clearSelection(inFrame)'));
    const passage = ask.slice(ask.indexOf('askPassage:'));
    expect(passage.indexOf('armPin(')).toBeLessThan(passage.indexOf('removeAllRanges()'));
    expect(s).toMatch(/const armed = armedPinRef\.current;[\s\S]{0,300}p\.nudge\?\.\(top - at\)/);
    // The send of a draft is a new key on the same passage: the hold starts over (2026-11-09).
    expect(s).toMatch(/if \(pin\.key !== openKey\) \{ pin\.key = openKey; pin\.until = Date\.now\(\) \+ PIN_PASSAGE_MS; \}/);
    // A press on the card (its Send) does not end the hold.
    expect(s).toMatch(/const letGo = \(e: Event\) => \{\n\s*if \(!pinRef\.current \|\| \(e\.target instanceof Node && layer\.contains\(e\.target\)\)\) return;/);
  });

  it('the hover Ask button stays inside the text scroller, and steps aside for a selection', () => {
    // 2026-11-09, WebKit: a one-paragraph file scrolled to its end put the paragraph's Ask
    // button at the layer's top, over the file header's History and Find buttons.
    const s = all.find(x => x.p === 'components/common/FileThreadLayer.tsx')!.s;
    const pick = s.slice(s.indexOf('const pick = rafThrottle'), s.indexOf('const onMove ='));
    expect(pick).toMatch(/top: Math\.max\(raw\.top, clipTop\)/);
    expect(pick).toMatch(/sel && !sel\.isCollapsed/);
  });

  it('the gutter stays through a draft\'s send while its card is open', () => {
    // 2026-11-09, WebKit: the send dropped the draft before its question was read back, the
    // gutter went for a frame, the text reflowed, and at the file's end the passage slid 250px.
    const s = all.find(x => x.p === 'components/common/FileThreadLayer.tsx')!.s;
    // Since 2026-11-10 the gutter does not follow the questions at all: it is kept for the surface.
    expect(s).toMatch(/const railClears = RAIL_CLEARED_SURFACES\.has\(surface\);/);
  });

  it('nothing sets or removes a layout-changing gutter mark but the grace helper', () => {
    // 2026-11-09, WebKit, the first question of a fresh Walnut: the layer mounted again on
    // send, its cleanup removed the gutter at once, and the passage slid 250px. Every mark that
    // changes how a file view's text wraps goes through utils/rail-gutter.ts.
    const marks = /(RAIL_SHOWN_ATTR|'data-file-rail')/;
    const direct = /(setAttribute|removeAttribute|toggleAttribute)\(\s*(RAIL_SHOWN_ATTR|'data-file-rail')/;
    expect(all.filter(f => f.p !== 'utils/rail-gutter.ts' && direct.test(f.s)).map(f => f.p)).toEqual([]);
    expect(all.filter(f => marks.test(f.s)).map(f => f.p).sort()).toEqual(['components/common/FileThreadLayer.tsx']);
  });
});

