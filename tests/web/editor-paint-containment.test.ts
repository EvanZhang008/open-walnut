/**
 * The rich-text editor's paint area stays bounded: WKWebView ratchet.
 *
 * The report (2026-09-02, three times): "the Mac app is super laggy — I open a
 * session's Files tab and clicking outside to close it takes ~3 seconds, Chrome is
 * smooth." Then the detail that cracked it: "if the file is OPEN I basically freeze
 * and can't close the panel for a very long time; if it was just opened and is still
 * loading or empty, that same close is fine."
 *
 * Benchmarked 2026-09-03 (scripts/local/panel-bench.local.mjs, six enter/exit cycles
 * per arm against the live server, all timing taken inside the page):
 *
 *   arm                              WebKit exit      Chromium exit
 *   nothing open in the preview           107ms              64ms
 *   a real markdown file open            2204ms              45ms
 *
 * 24/24 cycles, not a tail. The file was the repo README (15 images); the preview
 * mounts a TipTap/ProseMirror `contenteditable` that measured 454×13,405px with 103
 * block children and no virtualization. WebKit kept a backing store for the whole
 * scrollable height and re-rasterised all of it when the panel's geometry changed;
 * Blink does not, which is the entire "smooth in Chrome, frozen in the Mac app"
 * difference — the Mac app is a WKWebView.
 *
 * `contain: paint` on the content element took it to 85ms. What the measurements
 * ruled OUT, so nobody re-litigates it:
 *   - not layout: forcing a relayout at six widths cost 1-4ms, and `contain: layout`
 *     changed nothing (2188ms),
 *   - not editability: `contenteditable=false` was still 2154ms,
 *   - not the images: hiding them changed nothing (a deterministic re-rasterisation
 *     bench had already measured 58ms),
 *   - not the glass: `backdrop-filter: none` changed nothing, in headless AND in a
 *     real window where compositing genuinely goes through WindowServer,
 *   - not the fullscreen `position: fixed`: forcing it static was still 2126ms.
 *
 * Deleting the rule reproduced the freeze on the spot (2143ms), so it is
 * load-bearing rather than decoration. Chromium test tiers cannot see WebKit
 * compositor behaviour at all, hence a CSS ratchet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CSS_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'),
  'utf8',
);

function ruleBody(selectorLine: string): string {
  const idx = CSS_SRC.indexOf(selectorLine);
  expect(idx, `missing CSS rule: ${selectorLine}`).toBeGreaterThan(-1);
  return CSS_SRC.slice(idx, CSS_SRC.indexOf('}', idx) + 1);
}

describe('rich-text editor paint containment', () => {
  it('the editor content element bounds its paint area', () => {
    const body = ruleBody('.notes-editor .tiptap {');
    expect(
      body,
      'without `contain: paint` WebKit rasterises the editor\'s whole scrollable '
      + 'height; measured 2130ms per Files-panel collapse vs 85ms with it',
    ).toMatch(/contain:\s*(paint|content|strict)\b/);
  });

  it('containment is on the CONTENT element, not on the scroller around it', () => {
    // Two reasons, both measured. The bubble menu is a SIBLING of `.tiptap`, so
    // containing here clips nothing that floats, while containing the scroller
    // would newly clip it (a scroller is `position: static`, so an absolutely
    // positioned popup can currently escape its overflow). And it was simply
    // faster: 85ms on the content element vs 139ms on `.fv-wysiwyg-editor`.
    const scroller = ruleBody('.fv-wysiwyg-editor {');
    expect(scroller).toContain('overflow-y: auto');
    expect(
      scroller,
      'contain on the scroller is the slower option and clips the bubble menu',
    ).not.toMatch(/contain:/);
  });

  it('the rule is shared, so the Files preview and the Notes page cannot drift apart', () => {
    // `.notes-editor .tiptap` is the base rule for every mount of the editor. The
    // Files preview overrides `max-width`/`padding` further down; if a future
    // override moved containment into one surface's rule, the other would silently
    // keep the 2s freeze. Pin that containment is declared once, in the shared rule.
    const perSurface = CSS_SRC.match(/^\.fv-wysiwyg-editor \.notes-editor \.tiptap \{[^}]*contain:/m);
    expect(perSurface, 'containment belongs in the shared .notes-editor .tiptap rule').toBeNull();
  });

  it('editor popups are portalled, so containment cannot clip them', () => {
    // This is what makes `contain: paint` safe here, and it is an assumption a
    // future popup could quietly break: paint containment clips descendants to the
    // padding box, so a suggestion menu rendered INLINE near the end of a document
    // would be cut off, while a portalled one is not a descendant at all. Measured
    // at the time: zero descendants overflowed the box, and the bubble menu still
    // rendered (301×36) with containment on because it is a sibling.
    const dir = path.resolve(import.meta.dirname, '../../web/src/components/notes');
    const popups = [
      'CommandPalette.tsx',
      'TagAutocomplete.tsx',
      'slash-commands/SlashCommandPortal.tsx',
      'wiki-link/WikiLinkAutocomplete.tsx',
      'wiki-link/WikiLinkDisambiguation.tsx',
    ];
    for (const file of popups) {
      const src = fs.readFileSync(path.join(dir, file), 'utf8');
      expect(src, `${file} must portal out of the contained editor`).toContain('createPortal');
    }
  });

  it('the editor is still allowed to be taller than its scroller', () => {
    // `contain: strict`/`size` would ALSO contain the size, collapsing the document
    // to the scroller's height and hiding most of the file. Paint containment only.
    const body = ruleBody('.notes-editor .tiptap {');
    expect(body).not.toMatch(/contain:\s*(strict|size)\b/);
    expect(body).toContain('min-height: 100%');
  });
});
