/**
 * One Escape closes one layer in the Files view (2026-11-09 review: in Source mode one
 * Escape closed the Ask card and the whole full-screen sheet). The card claims the press
 * from wherever focus is in the panel; every sheet exit steps aside while a card is open.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardTakesEscape, type CardEscapeFacts } from '../../web/src/utils/file-card-escape';

/** A tiny element: `closest` matches by class names, `contains` by ancestry. */
class El {
  ownerDocument: { body: El } | undefined;
  constructor(public cls: string[], public parent: El | null = null) {
    this.ownerDocument = parent?.ownerDocument;
  }
  contains(o: El | null): boolean {
    for (let n = o; n; n = n.parent) if (n === this) return true;
    return false;
  }
  closest(sel: string): El | null {
    const wanted = sel.split(',').map(s => s.trim());
    for (let n: El | null = this; n; n = n.parent) {
      if (wanted.some(w => (w.startsWith('.') ? w.slice(1).split('.').every(c => n!.cls.includes(c)) : n!.cls.includes(w)))) return n;
    }
    return null;
  }
}
const doc = { body: null as unknown as El };
const body = new El(['body']);
body.ownerDocument = doc;
doc.body = body;
const panel = new El(['session-panel'], body);
const editor = new El(['cm-editor'], panel);
const searchPanel = new El(['cm-panels'], editor);
const card = new El(['thread-card'], panel);
const cardBox = new El(['textarea'], card);
const cardButton = new El(['button'], card);
const elsewhere = new El(['textarea'], body);

const facts = (over: Partial<CardEscapeFacts>): CardEscapeFacts => ({
  key: 'Escape', isComposing: false, defaultPrevented: false, target: editor as unknown as Element,
  active: editor as unknown as Element, card: card as unknown as Element, scope: panel as unknown as Element,
  overlayOpen: false, ...over,
});
const as = (e: El) => e as unknown as Element;

describe('cardTakesEscape', () => {
  it('focus in the source editor: the card takes the press (the reported bug)', () => {
    expect(cardTakesEscape(facts({}))).toBe(true);
  });
  it('focus on the page body takes it too', () => {
    expect(cardTakesEscape(facts({ active: as(body), target: as(body) }))).toBe(true);
  });
  it('focus in the card is left to the card, which steps through its own sizes', () => {
    expect(cardTakesEscape(facts({ active: as(cardBox), target: as(cardBox) }))).toBe(false);
  });
  it('a card that reads Escape only in its box: a press on its button is claimed', () => {
    expect(cardTakesEscape(facts({ active: as(cardButton), target: as(cardButton), ownKeys: 'textarea' }))).toBe(true);
    expect(cardTakesEscape(facts({ active: as(cardBox), target: as(cardBox), ownKeys: 'textarea' }))).toBe(false);
  });
  it('a layer above the card goes first: a menu or modal, the editor search panel, an IME', () => {
    expect(cardTakesEscape(facts({ overlayOpen: true }))).toBe(false);
    expect(cardTakesEscape(facts({ target: as(searchPanel), active: as(searchPanel) }))).toBe(false);
    expect(cardTakesEscape(facts({ isComposing: true }))).toBe(false);
    expect(cardTakesEscape(facts({ defaultPrevented: true }))).toBe(false);
  });
  it('no card, another key, or focus in a field outside the panel: not claimed', () => {
    expect(cardTakesEscape(facts({ card: null }))).toBe(false);
    expect(cardTakesEscape(facts({ key: 'Enter' }))).toBe(false);
    expect(cardTakesEscape(facts({ active: as(elsewhere), target: as(elsewhere) }))).toBe(false);
  });
});

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

describe('every sheet exit and every file card layer', () => {
  const all = sources(WEB).map(p => ({ p: path.relative(WEB, p), s: readFileSync(p, 'utf8') }));

  it('an Escape that leaves full screen asks whether a file card is open first', () => {
    // A keydown listener that exits a full screen: FileContentView's own and useFullscreen today.
    const exits = all.filter(f => /addEventListener\('keydown'/.test(f.s) && /'Escape'/.test(f.s)
      // A bare leave() (useFullscreen's own), never a method of something else (ChatInput's drop zones).
      && /setFullscreen\(false\)|(?<![.\w])leave\(\);/.test(f.s));
    expect(exits.map(f => f.p).sort()).toEqual(['components/common/FileContentView.tsx', 'hooks/useFullscreen.tsx']);
    // Asked about the sheet's own cards (its element, or the sheets on show), never the whole page.
    for (const f of exits) expect(f.s, f.p).toMatch(/fileCardOpenIn(Fullscreen)?\((contentRef\.current|document)\)/);
    for (const f of exits) expect(f.s, f.p).not.toMatch(/fileCardOpenIn\(document\)/);
  });

  it('a card drawn over a file claims Escape while it is open', () => {
    // The Ask card is portalled into the box the Files tab lends (fileCardHost); comments draw DocCommentCard.
    const layers = all.filter(f => !f.p.endsWith('DocCommentCard.tsx') && (/cardFileHost\b/.test(f.s) || /<DocComment(Card|Draft)\b/.test(f.s)));
    expect(layers.length).toBeGreaterThanOrEqual(2);
    for (const f of layers) expect(f.s, f.p).toMatch(/claimFileCardEscape\(/);
  });

  it('a rich (ProseMirror) editor lets Escape through, so the sheet around it can leave', () => {
    // ProseMirror's key fallback preventDefaults every Escape; the sheet read that as taken
    // (2026-11-09: Escape with the caret in a markdown Preview never left full screen).
    const editors = all.filter(f => /from '@tiptap\/react'/.test(f.s) && /\buseEditor\(/.test(f.s));
    expect(editors.length).toBeGreaterThanOrEqual(1);
    for (const f of editors) {
      expect(f.s, f.p).toMatch(/handleDOMEvents:\s*\{[\s\S]{0,400}keydown:\s*\(_view, event\) => event\.key === 'Escape'/);
    }
  });
});
