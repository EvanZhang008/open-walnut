/**
 * A comment box opens in place, at the words it is about (2026-11-02, the user, on
 * a doc preview whose comment box sat in a column on the right: "comment, need in
 * place not in side bar, waste space", then "this is the doc, but anywhere is
 * same"). The rule is web/src/utils/in-place-card.ts; this file pins it and lists
 * every surface that opens a comment box with how it is placed, so a new surface
 * (or one that brings a side column back) fails here until it opens in place.
 * tests/e2e/browser/session-doc-comments.spec.ts measures it in the browser.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { IN_PLACE_GAP, IN_PLACE_MARGIN, inPlaceCardPosition } from '../../web/src/utils/in-place-card';

const ROOT = path.resolve(__dirname, '../../web/src');
function sources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sources(full));
    else if (/\.(ts|tsx|css)$/.test(entry.name)) out.push(full);
  }
  return out;
}
const files = sources(ROOT).map((f) => ({ file: path.relative(ROOT, f).split(path.sep).join('/'), text: fs.readFileSync(f, 'utf8') }));
const read = (rel: string) => {
  const hit = files.find((f) => f.file === rel);
  if (!hit) throw new Error(`${rel} is gone: update this guard's list`);
  return hit.text;
};

describe('the in-place rule', () => {
  const view = { width: 800, height: 600 };
  const card = { width: 380, height: 120 };

  it('opens right under the last line, where its words start', () => {
    const at = inPlaceCardPosition([{ left: 120, right: 700, top: 100, bottom: 120 }, { left: 40, right: 300, top: 122, bottom: 142 }], view, card)!;
    expect(at).toEqual({ left: 40, top: 142 + IN_PLACE_GAP, placement: 'below' });
  });

  it('a last line of several inline boxes (code, bold) starts at its leftmost', () => {
    const at = inPlaceCardPosition([
      { left: 300, right: 360, top: 200, bottom: 220 }, { left: 360, right: 420, top: 202, bottom: 222 }, { left: 420, right: 500, top: 200, bottom: 220 },
    ], view, card)!;
    expect(at).toEqual({ left: 300, top: 222 + IN_PLACE_GAP, placement: 'below' });
  });

  it('stays inside the view on the right and the left', () => {
    expect(inPlaceCardPosition([{ left: 700, right: 760, top: 10, bottom: 30 }], view, card)!.left).toBe(view.width - card.width - IN_PLACE_MARGIN);
    expect(inPlaceCardPosition([{ left: -50, right: 20, top: 10, bottom: 30 }], view, card)!.left).toBe(IN_PLACE_MARGIN);
  });

  it('goes over the first line only when there is no room under the last and there is over the first', () => {
    const low = [{ left: 60, right: 200, top: 540, bottom: 560 }];
    expect(inPlaceCardPosition(low, view, card)).toEqual({ left: 60, top: 540 - IN_PLACE_GAP - card.height, placement: 'above' });
    // Too tall for either side (a long thread): the side with more room, scrolling inside it.
    const tall = { width: 380, height: 500 };
    expect(inPlaceCardPosition([{ left: 60, right: 200, top: 200, bottom: 220 }], view, tall))
      .toEqual({ left: 60, top: 220 + IN_PLACE_GAP, placement: 'below', maxHeight: 600 - 220 - IN_PLACE_GAP - IN_PLACE_MARGIN });
    expect(inPlaceCardPosition([{ left: 60, right: 200, top: 400, bottom: 420 }], view, tall))
      .toEqual({ left: 60, top: IN_PLACE_MARGIN, placement: 'above', maxHeight: 400 - IN_PLACE_GAP - IN_PLACE_MARGIN });
    // No usable room at all (a very short view): lifted into the view so its buttons stay in reach.
    const short = inPlaceCardPosition([{ left: 60, right: 200, top: 40, bottom: 60 }], { width: 800, height: 150 }, card)!;
    expect(short).toEqual({ left: 60, top: 150 - card.height - IN_PLACE_MARGIN, placement: 'below' });
    // A passage below the view stays below it (the card is not drawn there).
    expect(inPlaceCardPosition([{ left: 60, right: 200, top: 700, bottom: 720 }], view, card)!.top).toBe(720 + IN_PLACE_GAP);
    expect(inPlaceCardPosition([], view, card)).toBeNull();
  });
});

describe('every comment box opens in place', () => {
  // Each surface that opens a comment box on a selection, and what places it at the words.
  const SURFACES: Record<string, RegExp> = {
    // A doc's comment (the Files tab: preview, editor, source, HTML preview).
    'components/common/DocCommentsLayer.tsx': /inPlaceCardPosition\(/,
    // The chat's comment on a passage: the selection pill, placed at the selection.
    'components/sessions/QuotePinSelectionBar.tsx': /useMenuPlacement\(/,
    // A saved chat comment's card: from its marker at the passage's end.
    'components/sessions/PassageCommentMarks.tsx': /useMenuPlacement\(/,
    // A diff line comment: an inline widget under the line it is on.
    'components/sessions/SessionDiffView.tsx': /rendered under a line via react-diff-view `widgets`[\s\S]*widgets=\{widgets\}/,
  };

  it('lists every surface that opens a comment box', () => {
    const boxes = files
      .filter(({ file }) => file.endsWith('.tsx'))
      .filter(({ text }) => /placeholder="Comment|ariaLabel="Comment|<DocCommentDraft\b|<DocCommentCard\b|function CommentBox\b|className="passage-comment-card/.test(text))
      .map(({ file }) => file)
      .filter((file) => file !== 'components/common/DocCommentCard.tsx')
      .sort();
    expect(boxes, 'a new comment box: place it with utils/in-place-card.ts (or at the selection) and list it here').toEqual(Object.keys(SURFACES).sort());
    for (const [file, placedBy] of Object.entries(SURFACES)) expect(read(file), file).toMatch(placedBy);
  });

  it('no comment surface keeps a column or reserves room beside the text', () => {
    const layer = read('components/common/DocCommentsLayer.tsx');
    expect(layer).not.toMatch(/onRoom|WIDE_FROM|is-wide|doc-comments-column/);
    expect(read('components/common/FileContentView.tsx')).not.toMatch(/fv-doc-comments-wide|onRoom=/);
    const css = files.filter(({ file }) => /styles\/(doc-comments|passage-comments)\.css$/.test(file));
    expect(css.length).toBe(2);
    for (const { file, text } of css) {
      expect(text, file).not.toMatch(/fv-doc-comments-wide|doc-comments-column/);
      expect(text, file).not.toMatch(/padding-right:\s*\d{3}px|width:\s*calc\(100% - \d{3}px\)/);
    }
  });
});
