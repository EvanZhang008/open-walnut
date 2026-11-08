/**
 * One Escape closes the innermost open thing in every file surface, and only it: the selection
 * toolbar, then a card, then the sheet (2026-11-10 review: in Changed, one Escape with the
 * Quote in chat toolbar up closed the whole sheet, while in Preview it closed only the toolbar).
 * And a sheet asks only about cards inside itself: a chat card open in another column kept
 * every full screen open on Escape.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { cardTakesEscape, fileCardOpenIn, toolbarTakesEscape, type CardEscapeFacts, type ToolbarEscapeFacts } from '../../web/src/utils/file-card-escape';

const el = (cls: string) => ({ cls, closest: (sel: string) => (sel.split(',').some((s) => s.trim() === `.${cls}`) ? {} : null) }) as unknown as Element;

const toolbar = (over: Partial<ToolbarEscapeFacts> = {}): ToolbarEscapeFacts => ({
  key: 'Escape', isComposing: false, consumed: false, overlayOpen: false, target: el('diff-line'), active: null, open: true, ...over,
});

describe('the selection toolbar takes the first Escape', () => {
  it('the reported case: the toolbar is up, so the press is its own', () => {
    expect(toolbarTakesEscape(toolbar())).toBe(true);
  });
  it('a menu, a modal, the editor\'s own panel or an IME goes first', () => {
    expect(toolbarTakesEscape(toolbar({ overlayOpen: true }))).toBe(false);
    expect(toolbarTakesEscape(toolbar({ target: el('cm-panels') }))).toBe(false);
    expect(toolbarTakesEscape(toolbar({ active: el('fv-search-bar') }))).toBe(false);
    expect(toolbarTakesEscape(toolbar({ isComposing: true }))).toBe(false);
    expect(toolbarTakesEscape(toolbar({ consumed: true }))).toBe(false);
  });
  it('no toolbar, or another key: not taken', () => {
    expect(toolbarTakesEscape(toolbar({ open: false }))).toBe(false);
    expect(toolbarTakesEscape(toolbar({ key: 'Enter' }))).toBe(false);
  });
  it('a card under an open toolbar steps aside, whatever order the listeners run in', () => {
    const card = { contains: () => false } as unknown as Element;
    const facts: CardEscapeFacts = {
      key: 'Escape', isComposing: false, defaultPrevented: false, target: null, active: null, card, scope: null, overlayOpen: false,
    };
    expect(cardTakesEscape(facts)).toBe(true);
    expect(cardTakesEscape({ ...facts, toolbarOpen: true })).toBe(false);
  });
});

describe('a sheet asks only about cards inside itself', () => {
  it('no scope is no card: never the whole page', () => {
    expect(fileCardOpenIn(null)).toBe(false);
    expect(fileCardOpenIn(undefined)).toBe(false);
    const sheet = { querySelector: () => ({}) } as unknown as ParentNode;
    expect(fileCardOpenIn(sheet)).toBe(true);
  });
});

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = path.join(dir, n);
    return statSync(p).isDirectory() ? sources(p) : /\.tsx?$/.test(n) ? [p] : [];
  });
}

/**
 * Every Escape owner of a file surface (Preview, Source, the iframe preview, Changed, the
 * sheets around them), by layer. A new file of these surfaces that reads Escape fails until it
 * is placed here.
 */
const OWNERS: Record<string, 'rules' | 'toolbar' | 'card' | 'field' | 'menu' | 'sheet' | 'forward'> = {
  'utils/file-card-escape.ts': 'rules',
  'components/common/SelectionAskPill.tsx': 'toolbar',
  'components/notes/NotesBubbleMenu.tsx': 'toolbar',
  'components/common/DocCommentsLayer.tsx': 'card',
  'components/common/DocCommentCard.tsx': 'field',
  'components/common/FileSearchBar.tsx': 'field',
  'components/common/FileQuestionRail.tsx': 'menu',
  'components/sessions/SessionDiffView.tsx': 'field',
  'components/common/FileContentView.tsx': 'sheet',
  'components/common/FileViewer.tsx': 'sheet',
  'hooks/useFullscreen.tsx': 'sheet',
  'components/common/preview-frame.ts': 'forward',
};
/** The files of the file surfaces. */
const SURFACE = /^(components\/common\/(File|DocComment|SelectionAskPill|preview-frame)|components\/sessions\/SessionDiffView|components\/notes\/NotesBubbleMenu|hooks\/useFullscreen|utils\/file-card-escape)/;

describe('guard: every Escape owner of the file surfaces, by layer', () => {
  const all = sources(WEB).map((p) => ({ p: path.relative(WEB, p), s: readFileSync(p, 'utf8') }));
  const owners = all.filter((f) => SURFACE.test(f.p) && /['"]Escape['"]|claim(Toolbar|FileCard)Escape\(/.test(f.s));

  it('lists them all', () => {
    expect(owners.map((f) => f.p).sort()).toEqual(Object.keys(OWNERS).sort());
  });

  it('a toolbar claims Escape through the one claim; a card through its own', () => {
    for (const f of owners) {
      if (OWNERS[f.p] === 'toolbar') expect(f.s, f.p).toMatch(/claimToolbarEscape\(/);
      if (OWNERS[f.p] === 'card') expect(f.s, f.p).toMatch(/claimFileCardEscape\(/);
    }
    // Every surface that shows a selection toolbar renders one that claims.
    for (const f of all.filter((x) => /<SelectionAskPill\b/.test(x.s))) expect(f.p).toMatch(/FileContentView|SessionDiffView/);
  });

  it('a sheet that hears Escape in the capture phase asks about the toolbar and its own cards first', () => {
    for (const f of owners.filter((x) => OWNERS[x.p] === 'sheet')) {
      const capture = /addEventListener\('keydown', handler, true\)/.test(f.s) || /addEventListener\('keydown', \w+, true\)/.test(f.s);
      if (!capture && f.p !== 'hooks/useFullscreen.tsx') continue;
      expect(f.s, f.p).toMatch(/selectionToolbarOpen\(/);
      expect(f.s, f.p).toMatch(/fileCardOpenIn(Fullscreen)?\(/);
    }
  });

  it('no sheet asks about a card anywhere on the page', () => {
    for (const f of all) expect(f.s, f.p).not.toMatch(/fileCardOpenIn\(document\)/);
  });
});
