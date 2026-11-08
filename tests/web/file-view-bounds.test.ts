/**
 * What floats over a file view stays inside the part of it that is the reader's
 * (2026-11-10 WebKit review):
 *  - an Ask card never reaches over the file header's breadcrumb and buttons, nor under the
 *    "1 comment" chip (which sat on its send); one whose passage scrolled away is not drawn;
 *  - the selection toolbar stays inside the sheet's box (it stuck out past the sheet's edge
 *    and over the file tree);
 *  - a press under the last line puts the caret at the end;
 *  - the editor's own dictation mic shows only while the reader writes in it.
 */
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FILE_CARD_MIN_HEIGHT, placeFileCardBelow } from '../../web/src/utils/file-thread';
import { placeToolbar, roomyBox } from '../../web/src/utils/toolbar-bounds';
import { pressBelowText } from '../../web/src/utils/blank-press';

const WEB = path.join(path.dirname(new URL(import.meta.url).pathname), '../../web/src');
const src = (p: string) => readFileSync(path.join(WEB, p), 'utf8');

describe('the file Ask card under the file header', () => {
  const host = { width: 900, height: 700 };
  const HEADER = 64; // the file bar (40) and the comments chip under it

  it('the reported case: a passage scrolled above the view leaves no card over the header', () => {
    const above = { top: -900, bottom: -880, left: 40, right: 600 };
    expect(placeFileCardBelow(above, host, HEADER).away).toBe(true);
    // Scrolled under the header (still in the root's box, out of the reader's part): away too.
    expect(placeFileCardBelow({ top: 20, bottom: HEADER - 4, left: 40, right: 600 }, host, HEADER).away).toBe(true);
    // Its last line just below the header: drawn, under the passage, under the header.
    const half = { top: 20, bottom: HEADER + 6, left: 40, right: 600 };
    const p = placeFileCardBelow(half, host, HEADER);
    expect(p.away).toBeUndefined();
    expect(p.top).toBeGreaterThanOrEqual(HEADER);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(host.height);
  });

  it('a passage just under the header puts the card under the passage, as before', () => {
    const near = { top: HEADER + 10, bottom: HEADER + 30, left: 40, right: 600 };
    const p = placeFileCardBelow(near, host, HEADER);
    expect(p.top).toBeGreaterThanOrEqual(near.bottom);
    expect(p.bottom).toBeUndefined();
  });

  it('a card over its passage keeps its foot over the passage and its head under the header', () => {
    const low = { top: 640, bottom: 660, left: 40, right: 600 };
    const p = placeFileCardBelow(low, host, HEADER, undefined, 400);
    expect(p.bottom).toBeDefined();
    expect(host.height - (p.bottom ?? 0)).toBeLessThanOrEqual(low.top);
    expect(p.top).toBeGreaterThanOrEqual(HEADER);
  });

  it('a header taller than the view leaves the card its minimum room', () => {
    const view = { width: 600, height: 300 };
    expect(placeFileCardBelow({ top: -50, bottom: -40, left: 0, right: 300 }, view, 280).away).toBe(true);
    const p = placeFileCardBelow({ top: 125, bottom: 140, left: 0, right: 300 }, view, 280);
    expect(p.away).toBeUndefined();
    // The card's box starts no lower than its minimum room from the bottom, and the card stays in it.
    expect(p.top).toBeGreaterThanOrEqual(300 - FILE_CARD_MIN_HEIGHT);
    expect(p.top + p.maxHeight).toBeLessThanOrEqual(300);
  });

  it('every file card is placed under the header, and the chip and its error are header items', () => {
    const layer = src('components/common/FileThreadLayer.tsx');
    expect(layer).not.toMatch(/\bplaceFileCard\(/);
    expect(layer).toMatch(/placeFileCardBelow\(anchor, host, inset/);
    expect(layer).toMatch(/fileHeaderInset\(root, stickyBarOf\(/);
    const head = src('components/common/DocCommentCard.tsx');
    expect(head).toMatch(/className="doc-comments-chip"[^>]*\{\.\.\.HEADER_ITEM\}/);
    expect(head).toMatch(/className="doc-comments-error"[^>]*\{\.\.\.HEADER_ITEM\}/);
  });
});

describe('the selection toolbar inside its box', () => {
  const sheet = { left: 300, top: 50, right: 1200, bottom: 800 };
  const size = { w: 180, h: 30 };

  it('the reported case: a selection at the sheet\'s right edge keeps the toolbar inside the sheet', () => {
    const rect = { left: 1100, top: 400, right: 1195, bottom: 418 };
    const p = placeToolbar(rect, 1190, size, sheet, true);
    expect(p.left + size.w).toBeLessThanOrEqual(sheet.right - 4);
    expect(p.left).toBeGreaterThanOrEqual(rect.left - size.w); // still beside the selection
  });

  it('and never out over the file tree on the left', () => {
    const p = placeToolbar({ left: 305, top: 400, right: 340, bottom: 418 }, 306, size, sheet, true);
    expect(p.left).toBeGreaterThanOrEqual(sheet.left + 4);
  });

  it('flips inside the box, and stays in it for a selection taller than the box', () => {
    expect(placeToolbar({ left: 500, top: 760, right: 600, bottom: 790 }, 550, size, sheet, true).below).toBe(false);
    const tall = placeToolbar({ left: 500, top: 0, right: 600, bottom: 900 }, 550, size, sheet, true);
    expect(tall.top).toBeGreaterThanOrEqual(sheet.top + 4);
    expect(tall.top + size.h).toBeLessThanOrEqual(sheet.bottom - 4);
  });

  it('a clip narrower than the toolbar gives way to the next box out', () => {
    const cell = { left: 600, top: 100, right: 700, bottom: 700 };
    expect(roomyBox([cell, sheet], size.w, size.h)).toBe(sheet);
    expect(roomyBox([sheet], size.w, size.h)).toBe(sheet);
  });

  it('every selection toolbar of a file view clamps to its own box, not the window', () => {
    const pill = src('components/common/SelectionAskPill.tsx');
    expect(pill).toMatch(/placeToolbar\(rect, anchor\.x/);
    expect(pill).not.toMatch(/window\.innerWidth - w/);
    expect(src('components/common/FileContentView.tsx')).toMatch(/boundsOf=\{\(\) => contentRef\.current\}/);
    // The rich editor's bubble menu (Ask here, Comment in Preview).
    expect(src('components/notes/NotesBubbleMenu.tsx')).toMatch(/const clip = clipRef\.current;[\s\S]{0,400}clip\.right - r\.width - 4/);
  });
});

describe('a press under the last line', () => {
  it('is under the text only below its last line and off the scrollbars', () => {
    const client = { left: 0, top: 0, right: 600, bottom: 400 };
    expect(pressBelowText(300, 100, 200, client)).toBe(true);
    expect(pressBelowText(150, 100, 200, client)).toBe(false);
    expect(pressBelowText(300, 100, null, client)).toBe(false); // the end is not drawn
    expect(pressBelowText(405, 100, 200, client)).toBe(false); // the sideways scrollbar
    expect(pressBelowText(300, 605, 200, client)).toBe(false); // the vertical one
    expect(pressBelowText(300, 100, 200, null)).toBe(true);
  });

  it('the source editor and the view around it put the caret at the end', () => {
    const ed = src('components/common/FileSourceEditor.tsx');
    expect(ed).toMatch(/host\.addEventListener\('mousedown', onBlankPress\)/);
    expect(ed).toMatch(/host\.removeEventListener\('mousedown', onBlankPress\)/);
    expect(ed).toMatch(/focusEnd: \(\) =>/);
    expect(src('components/common/FileMarkdownEditor.tsx')).toMatch(/focusEnd: \(\) =>/);
    expect(src('components/common/FileContentView.tsx')).toMatch(/editorRef\.current\?\.focusEnd\?\.\(\)/);
  });
});

describe('the editor\'s dictation mic in the file view', () => {
  it('shows only while the reader writes in the editor, records, or has a problem', () => {
    const css = src('styles/globals.css');
    const rule = /\.fv-wysiwyg-editor:not\(:focus-within\) > \.editor-mic-dock:not\(:has\(([^)]*)\)\) \{\s*display: none;/.exec(css);
    expect(rule).toBeTruthy();
    const kept = rule![1].split(',').map((x) => x.trim());
    expect(kept).toEqual(expect.arrayContaining(['.mic-recording', '.mic-transcribing', '.mic-error-bubble']));
    // A press on the dock keeps it (WebKit gives a pressed button no focus, so the editor blurs).
    expect(kept).toContain(':active');
    // Every menu or bubble the mic opens keeps it too, so a click inside one is never lost.
    const mic = src('components/common/MicButton.tsx');
    const popups = [...new Set([...mic.matchAll(/className="(mic-[a-z-]*(?:dropdown|bubble|popover|menu))[" ]/g)].map((m) => `.${m[1]}`))];
    expect(popups.length).toBeGreaterThanOrEqual(2);
    for (const p of popups) expect(kept, p).toContain(p);
    // The dock is the editor's direct child (the rule's `>`).
    expect(src('components/notes/NotesEditor.tsx')).toMatch(/<div className="editor-mic-dock"/);
  });
});

describe('the reading place is kept on every rewrapping body of the file view', () => {
  it('FileContentView keeps it, the open card hands over its passage', () => {
    const view = src('components/common/FileContentView.tsx');
    expect(view).toMatch(/keepReadingPlace\(view,/);
    // The keeper finds the surface the line keeper knows (utils/reading-line-dom.ts), CodeMirror aside.
    expect(view).toMatch(/const s = lineSurfaceOf\(view\);\s*return s && s\.kind !== 'cm'/);
    // Every body of file text the view renders (its own and the rich editor's root) is one of them.
    const bodiesSrc = src('utils/reading-line-dom.ts').match(/const BODIES[^=]*= \[([\s\S]*?)\];/)?.[1] ?? '';
    const kept = [...bodiesSrc.matchAll(/\['(?:wys|md|pre)', '([^']+)'\]/g)].map((m) => m[1]);
    const bodies = new Set<string>();
    for (const m of view.matchAll(/<(?:div|pre) className="((?:fv-md-preview|file-viewer-code)[^" ]*)/g)) bodies.add(`.${m[1]}`);
    const rich = src('components/common/FileMarkdownEditor.tsx').match(/<div className="(fv-[a-z-]+)"/)?.[1];
    if (rich) bodies.add(`.${rich}`);
    expect(bodies.size).toBe(3);
    for (const body of bodies) expect(kept, body).toContain(body);
    const layer = src('components/common/FileThreadLayer.tsx');
    expect(layer).toMatch(/setReadingAnchor\(root, \(\) =>/);
    expect(layer).toMatch(/if \(!inFrame\) setReadingAnchor\(root, null\);/);
  });
});

describe('a press in the blank space under the text', () => {
  it('never takes a press on a control there (a button, a link, a field) for blank space', () => {
    // 2026-11-10 review: the caret-to-end press caught buttons and links under ProseMirror.
    const view = src('components/common/FileContentView.tsx');
    const blank = /const blank = [\s\S]{0,400}?;\n/.exec(view)?.[0] ?? '';
    expect(blank).toBeTruthy();
    for (const sel of ['button', 'a', 'input', 'textarea', 'select', '[role=button]']) {
      expect(blank, sel).toMatch(new RegExp(`closest\\('[^']*(^|[ ,])${sel.replace(/[[\]]/g, '\\$&')}([ ,']|$)`));
    }
  });
});

describe('the open card\'s passage is looked up once per change of the text', () => {
  it('a miss is kept too, and only a change outside the card looks again', () => {
    // 2026-11-10 review: a quote not found was looked for again on every scroll frame, each a
    // walk of the whole document.
    const layer = src('components/common/FileThreadLayer.tsx');
    expect(layer).toMatch(/found\.gen === textGen && \(!found\.range \|\| found\.range\.startContainer\.isConnected\)\) return found\.range;/);
    expect(layer).toMatch(/if \(records\.some\(\(r\) => !layer\.contains\(r\.target\)\)\) textGen\+\+;/);
    // The per-frame passage and the reading anchor both read through it.
    expect(layer.match(/rangeForQuote\(b, mine\.quote/g)?.length).toBe(1);
    expect(layer).toMatch(/anchorRange = passageRange\(\);/);
  });
});
