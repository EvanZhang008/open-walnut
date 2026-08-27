/**
 * File view fullscreen: the chrome rows must be PLAIN flex rows, never sticky.
 *
 * Shipped bug (reported from the Mac app, a WKWebView): the toolbar rendered
 * ~110px INTO the fullscreened document, floating over the text. Cause — the
 * toolbar is `position: sticky` (right for the pane, where it rides the pane's
 * own scroll), but fullscreen makes `.file-content-view` `position: fixed`, and
 * WebKit still resolves a sticky descendant against the nearest scroll container
 * (`.session-file-explorer-preview`, `.file-mention-preview`) even with a fixed
 * ancestor in between, so it pinned to that pane's top edge. Blink resolves
 * against the fixed box, which is why Chromium looked fine and the Chromium
 * browser tier can't catch this — hence a CSS ratchet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const CSS_SRC = fs.readFileSync(
  path.resolve(import.meta.dirname, '../../web/src/styles/globals.css'),
  'utf8'
);

/** The declaration block that follows a selector list ending in `selector {`. */
function ruleBody(selectorLine: string): string {
  const idx = CSS_SRC.indexOf(selectorLine);
  expect(idx, `missing CSS rule: ${selectorLine}`).toBeGreaterThan(-1);
  return CSS_SRC.slice(idx, CSS_SRC.indexOf('}', idx) + 1);
}

describe('file view fullscreen chrome', () => {
  it('keeps the toolbar sticky in the pane (base rule intact)', () => {
    expect(ruleBody('.fv-html-toolbar {')).toContain('position: sticky');
    expect(ruleBody('.fv-reloading-badge {')).toContain('position: sticky');
  });

  it('drops sticky for every chrome row inside fullscreen', () => {
    const body = ruleBody('.file-content-view.fv-fullscreen > .fv-html-toolbar,');
    expect(body).toContain('position: static');
    expect(body).toContain('flex: 0 0 auto');
    // Every sticky-or-shrinkable chrome row the fullscreen column can hold.
    for (const row of [
      '.fv-html-toolbar',
      '.fv-reloading-badge',
      '.fv-search-bar',
      '.fv-save-error',
      '.file-viewer-truncated',
    ]) {
      expect(body, `fullscreen chrome rule must cover ${row}`)
        .toContain(`.file-content-view.fv-fullscreen > ${row}`);
    }
  });

  it('lets the read-only <pre> body grow and scroll in fullscreen', () => {
    const body = ruleBody('.file-content-view.fv-fullscreen > .file-viewer-code {');
    expect(body).toContain('flex: 1 1 auto');
    expect(body).toContain('min-height: 0');
    expect(body).toContain('overflow: auto');
  });
});
