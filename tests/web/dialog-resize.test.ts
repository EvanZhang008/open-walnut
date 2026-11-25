/**
 * Every dialog can be resized (the user, 2026-11-25: "I think every pop-up window can be
 * resized"). Pins two things:
 *  - the kept-size helpers (web/src/utils/dialog-size.ts): the kind of a dialog, the size that
 *    fits the window, a kept size merged per kind, and the inline size put on and taken off;
 *  - that the ONE layer (DialogResizeEdges) serves every dialog by construction: it is mounted in
 *    both of App's trees (the main window and a popped-out window) and finds dialogs by the family
 *    class `wn-dialog`, so no dialog file needs anything. A dialog that must not resize opts out
 *    with `data-no-dialog-resize`, named here with why.
 * The drag itself runs in a browser: tests/e2e/browser/dialog-resize.spec.ts.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';

const store = new Map<string, string>();
(globalThis as unknown as { localStorage: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
  key: () => null,
  length: 0,
} as Storage;

const {
  applyDialogSize, clampDialogSize, dialogKind, keepDialogSize, storedDialogSize,
  DIALOG_MIN_WIDTH, DIALOG_MIN_HEIGHT, DIALOG_WINDOW_GAP,
} = await import('../../web/src/utils/dialog-size');

const ROOT = join(__dirname, '..', '..');
const WEB_SRC = join(ROOT, 'web', 'src');

function panel(cls: string) {
  const { document } = parseHTML(`<div class="${cls}"></div>`);
  return document.querySelector('div') as unknown as HTMLElement;
}

describe('dialog-size helpers', () => {
  beforeEach(() => store.clear());

  it('names a dialog by its own classes, never a family, state or modifier class', () => {
    expect(dialogKind(panel('wn-dialog file-viewer-panel file-viewer-panel-explorer'))).toBe('file-viewer-panel file-viewer-panel-explorer');
    expect(dialogKind(panel('is-open has-x wn-dialog shortcuts-modal x--embedded'))).toBe('shortcuts-modal');
    // Dialogs that share a base class keep apart.
    expect(dialogKind(panel('app-modal shortcuts-help wn-dialog'))).not.toBe(dialogKind(panel('app-modal confirm-dialog wn-dialog')));
    expect(dialogKind(panel('wn-dialog'))).toBeNull();
  });

  it('fits a size to the window: never under the minimum, never past the window less its gap', () => {
    const view = { width: 1280, height: 800 };
    expect(clampDialogSize({ w: 10, h: 10 }, view)).toEqual({ w: DIALOG_MIN_WIDTH, h: DIALOG_MIN_HEIGHT });
    expect(clampDialogSize({ w: 5000, h: 5000 }, view)).toEqual({ w: 1280 - 2 * DIALOG_WINDOW_GAP, h: 800 - 2 * DIALOG_WINDOW_GAP });
    expect(clampDialogSize({ w: 700.4 }, view)).toEqual({ w: 700, h: undefined });
    // A window smaller than the minimum still gets the minimum (the dialog's own CSS fits it then).
    expect(clampDialogSize({ w: 900 }, { width: 200, height: 100 }).w).toBe(DIALOG_MIN_WIDTH);
  });

  it('keeps a size per kind, merges a side edge into it, and forgets it on null', () => {
    keepDialogSize('file-viewer-panel', { w: 1400, h: 900 });
    keepDialogSize('file-viewer-panel', { w: 1500 });
    keepDialogSize('shortcuts-modal', { h: 500 });
    expect(storedDialogSize('file-viewer-panel')).toEqual({ w: 1500, h: 900 });
    expect(storedDialogSize('shortcuts-modal')).toEqual({ w: undefined, h: 500 });
    // A bottom edge's drag (its width left undefined) keeps the width kept before.
    keepDialogSize('file-viewer-panel', { w: undefined, h: 700 });
    expect(storedDialogSize('file-viewer-panel')).toEqual({ w: 1500, h: 700 });
    keepDialogSize('file-viewer-panel', null);
    expect(storedDialogSize('file-viewer-panel')).toBeNull();
    expect(storedDialogSize('shortcuts-modal')).toEqual({ w: undefined, h: 500 });
  });

  it('reads a broken or foreign value as nothing kept', () => {
    store.set('walnut:dialog-size', '{not json');
    expect(storedDialogSize('x')).toBeNull();
    store.set('walnut:dialog-size', JSON.stringify({ x: { w: 'wide' } }));
    expect(storedDialogSize('x')).toBeNull();
    store.set('walnut:dialog-size', '[1,2]');
    keepDialogSize('x', { w: 400 });
    expect(storedDialogSize('x')).toEqual({ w: 400, h: undefined });
  });

  it('puts a size on a panel over its own caps, and takes it all off again', () => {
    const el = panel('wn-dialog x');
    applyDialogSize(el, { w: 800 });
    expect(el.style.getPropertyValue('width')).toBe('800px');
    expect(el.style.getPropertyValue('max-width')).toBe('none');
    expect(el.style.getPropertyValue('height') || '').toBe('');
    expect(el.hasAttribute('data-dialog-sized')).toBe(true);
    applyDialogSize(el, { w: 800, h: 600 });
    expect(el.style.getPropertyValue('max-height')).toBe('none');
    applyDialogSize(el, null);
    for (const p of ['width', 'height', 'max-width', 'max-height', 'min-width', 'min-height', 'flex']) {
      expect(el.style.getPropertyValue(p) || '', p).toBe('');
    }
    expect(el.hasAttribute('data-dialog-sized')).toBe(false);
  });
});

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.tsx')) out.push(p);
  }
  return out;
}

/** Dialogs that keep their own size, and why (none today). */
const NO_RESIZE: Record<string, string> = {};

describe('every dialog is resizable by construction', () => {
  it('the layer is mounted in both of App\'s trees and in a pop-out window\'s shell', () => {
    const app = readFileSync(join(WEB_SRC, 'App.tsx'), 'utf8');
    expect(app).toMatch(/import \{ DialogResizeEdges \} from '\.\/components\/common\/DialogResizeEdges'/);
    expect(app.match(/<DialogResizeEdges \/>/g)?.length, 'the main window and a popped-out window').toBe(2);
    const popout = app.indexOf('<PopoutRoot />');
    expect(popout).toBeGreaterThan(-1);
    expect(app.indexOf('<DialogResizeEdges />', popout) - popout).toBeLessThan(200);
    // A pop-out window boots through its own shell (popout/PopoutShell.tsx), which mounts the same hosts.
    const shell = readFileSync(join(WEB_SRC, 'popout', 'PopoutShell.tsx'), 'utf8');
    expect(shell).toMatch(/<PopoutRoot \/><DialogResizeEdges \/>/);
  });

  it('finds dialogs by the family class, so a new dialog needs nothing', () => {
    const src = readFileSync(join(WEB_SRC, 'components', 'common', 'DialogResizeEdges.tsx'), 'utf8');
    expect(src).toContain("querySelectorAll<HTMLElement>('.wn-dialog')");
    expect(src).toContain('[data-no-dialog-resize]');
  });

  it('a press on an edge is not an outside press of the dialog under it', () => {
    const hook = readFileSync(join(WEB_SRC, 'hooks', 'useOverlayLayer.ts'), 'utf8');
    expect(hook).toContain("closest?.('[data-dialog-resize-edge]')");
  });

  it('only the dialogs named here opt out', () => {
    const opted = walk(WEB_SRC)
      .filter((f) => !f.endsWith('DialogResizeEdges.tsx') && readFileSync(f, 'utf8').includes('data-no-dialog-resize'))
      .map((f) => f.slice(WEB_SRC.length + 1));
    expect(opted.sort()).toEqual(Object.keys(NO_RESIZE).sort());
  });
});
