/**
 * A pop-up hung on its key by CSS alone stays inside the window (web/src/utils/inline-overlay-fit.ts;
 * 2026-11-28, the UI audit: the Agents page's last card opened its menu under the window's edge).
 *
 *  - the maths: a menu past the window's foot flips above its key when it fits there, else it is
 *    shifted in and capped; one above its key past the top flips below; left and right shift in;
 *  - the class: every CSS rule that hangs a box at `top` or `bottom` 100% with `position: absolute`
 *    belongs to a pop-up this layer places (a family member, `wn-overlay`, or one that opts in with
 *    `data-fit-window`), is a ::before or ::after decoration, or is named below with why it is not a
 *    pop-up. A new hung pop-up that is
 *    neither fails here.
 * The real menu at the window's foot: tests/e2e/browser/inline-overlay-fit.spec.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fitInWindow, FIT_MARGIN } from '../../web/src/utils/inline-overlay-fit';

const WEB_SRC = join(__dirname, '..', '..', 'web', 'src');
const view = { width: 390, height: 844 };

describe('fitInWindow', () => {
  it('leaves a pop-up that fits where its CSS put it', () => {
    expect(fitInWindow({ top: 240, left: 201, width: 150, height: 98 }, { top: 210, left: 320, width: 30, height: 28 }, view))
      .toEqual({ dx: 0, dy: 0, maxHeight: undefined });
  });

  it('flips a menu hung below its key above it when it runs past the foot (the Agents page, 390 x 844)', () => {
    // The measured case: key 803..831, menu 833..975 (2 px gap).
    const fit = fitInWindow({ top: 833, left: 201, width: 150, height: 142 }, { top: 803, left: 321, width: 30, height: 28 }, view);
    expect(fit.dy).toBe(803 - 2 - 142 - 833);
    expect(fit.dx).toBe(0);
    expect(fit.maxHeight).toBeUndefined();
  });

  it('flips a menu hung above its key below it when it runs past the top', () => {
    const fit = fitInWindow({ top: -60, left: 20, width: 200, height: 120 }, { top: 64, left: 20, width: 32, height: 32 }, view);
    expect(fit.dy).toBe(96 + 4 - -60);
  });

  it('shifts and caps a menu that fits on neither side', () => {
    const fit = fitInWindow({ top: 500, left: 20, width: 200, height: 1200 }, { top: 470, left: 20, width: 32, height: 28 }, view);
    expect(fit.dy).toBe(FIT_MARGIN - 500);
    expect(fit.maxHeight).toBe(844 - 2 * FIT_MARGIN);
  });

  it('shifts a pop-up past the bottom that hangs beside its key (not below it) up into the window', () => {
    const fit = fitInWindow({ top: 780, left: 20, width: 200, height: 120 }, { top: 760, left: 0, width: 390, height: 200 }, view);
    expect(fit.dy).toBe(844 - FIT_MARGIN - 120 - 780);
  });

  it('shifts a pop-up past the left or right edge in, and keeps its width when the window is wide enough', () => {
    expect(fitInWindow({ top: 100, left: 300, width: 150, height: 80 }, { top: 70, left: 360, width: 30, height: 28 }, view).dx)
      .toBe(390 - FIT_MARGIN - 150 - 300);
    expect(fitInWindow({ top: 100, left: -40, width: 150, height: 80 }, { top: 70, left: 0, width: 30, height: 28 }, view).dx)
      .toBe(FIT_MARGIN + 40);
  });
});

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/** CSS rules hung at 100% that are not a pop-up this layer places, each with why. Key: the selector's last class. */
const NOT_A_POPUP: Record<string, string> = {
  'phone-updates-pill': 'a pill in the phone top bar, part of the bar',
  'phone-status-row': 'a status row under the phone top bar, part of the bar',
  'md-code-status': "a code block's status line, inside the block",
  'shortcut-hint': 'the key badge under a button while a modifier is held (no pointer, gone on key up)',
  'mic-silence-warning': 'portalled and placed by MicPopover (position: fixed, useMenuPlacement)',
};

describe('every pop-up hung by CSS is kept inside the window', () => {
  const tsx = walk(WEB_SRC, '.tsx').map((f) => readFileSync(f, 'utf8')).join('\n');
  const rules: Array<{ file: string; selector: string; cls: string }> = [];
  for (const f of walk(WEB_SRC, '.css')) {
    const css = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const [selector, body] = [m[1].trim(), m[2]];
      if (!/position:\s*absolute/.test(body) || !/(^|[;\s])(top|bottom):\s*(calc\()?100%/.test(body)) continue;
      const first = selector.split(',')[0];
      // A ::before or ::after is a decoration, never a pop-up.
      if (/::?(before|after)\b/.test(first)) continue;
      const classes = [...first.replace(/:not\([^)]*\)/g, '').matchAll(/\.([a-zA-Z][\w-]*)/g)].map((c) => c[1]);
      rules.push({ file: relative(WEB_SRC, f), selector: selector.replace(/\s+/g, ' '), cls: classes[classes.length - 1] ?? '' });
    }
  }

  /** The element that carries `cls` in some TSX className or opts in beside it. */
  const placed = (cls: string) => {
    const esc = cls.replace(/[-]/g, '\\-');
    // The name whole (not a prefix of a longer one: `foo-menu` is not `foo-menu-item`).
    const name = `${esc}(?![\\w-])`;
    const inClass = new RegExp(`["\`' ]${name}[^"\`\\n]*\\bwn-overlay\\b|\\bwn-overlay\\b[^"\`\\n]*[\\s"\`']${name}`);
    const optIn = new RegExp(`className="${esc}"[^>]*data-fit-window|data-fit-window[^>]*className="${esc}"|className="${esc}"\\s*\\n\\s*data-fit-window`);
    return inClass.test(tsx) || optIn.test(tsx);
  };

  it('finds the rules it guards', () => {
    expect(rules.length).toBeGreaterThan(20);
    expect(rules.some((r) => r.cls === 'agent-menu')).toBe(true);
  });

  it('each is a pop-up this layer places, or named as not a pop-up', () => {
    const loose = rules.filter((r) => !NOT_A_POPUP[r.cls] && !placed(r.cls)).map((r) => `${r.file}: ${r.selector}`);
    expect(loose, 'A box hung at 100% by CSS that is neither a family member (wn-overlay) nor opted in (data-fit-window): add one of them, or name it in NOT_A_POPUP with why').toEqual([]);
  });

  it('names nothing that is no longer there', () => {
    const seen = new Set(rules.map((r) => r.cls));
    expect(Object.keys(NOT_A_POPUP).filter((c) => !seen.has(c))).toEqual([]);
  });

  it('is installed for every window, before the app mounts', () => {
    const main = readFileSync(join(WEB_SRC, 'main.tsx'), 'utf8');
    expect(main).toMatch(/import \{ installInlineOverlayFit \} from '\.\/utils\/inline-overlay-fit'/);
    expect(main).toMatch(/^\s*installInlineOverlayFit\(\);/m);
  });
});
