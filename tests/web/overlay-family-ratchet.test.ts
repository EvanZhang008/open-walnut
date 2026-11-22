/**
 * One overlay family (web/src/styles/overlay-family.css; standard.md "Overlays"): every menu, popover,
 * hover card, tooltip and dialog looks and closes the same way.
 *
 * 2026-11-21, the user, on Walnut's UI: "why the ui still not consistent ... why they are not even
 * consistent come on". The audit counted 159 files that portal a floating surface to <body>, with 7
 * radii, 42 shadow strings, 17 z-index values and four ways to close.
 *
 * Counted per file (overlay-family-scan.ts), from the source, so a NEW overlay is found by itself:
 *   - offFamily: a portal whose overlay (its first two elements) carries no family class
 *     (wn-overlay, wn-menu, wn-dialog, wn-scrim, wn-tip; or the notice card and glass families).
 *   - noCloseHook: a file that portals an overlay and closes it with neither useOverlayLayer
 *     (Escape, outside press, stacking) nor useModalOverlay (dialogs).
 *   - handEscape: a hand-written `key === 'Escape'` in such a file (the layer's `onEscape` and
 *     `onClose('escape')` are the way).
 *   - ownFrame: a CSS declaration giving a family member its own background, border, radius,
 *     shadow or z-index (the family class owns them). Phone stylesheets are exempt.
 *   - offTip: a role="tooltip" without wn-tip.
 * The counts that exist are in overlay-family-baseline.json and only go down. A new file or a
 * higher count fails; a lower count fails too until the baseline is lowered with
 * `OVERLAY_FAMILY_RECORD=1` on this file, so the ratchet stays tight.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { walk, scanCss } from './css-scan';
import { countAll, members, portalRoots, stripComments, ESCAPE_TEST, NOT_OVERLAY, WEB_SRC, type Counts } from './overlay-family-scan';

const BASELINE = path.join(__dirname, 'overlay-family-baseline.json');
const STANDARD = '.claude/skills/walnut-ui-requirements/standard.md';
const walkTsx = (dir: string) => walk(dir, ['.tsx']);
const walkCss = (dir: string) => walk(dir, ['.css']);
const KINDS = ['offFamily', 'noCloseHook', 'handEscape', 'ownFrame', 'offTip'] as const;

function compare(kind: keyof Counts, now: Record<string, number>, was: Record<string, number>) {
  const grew: string[] = [];
  const fell: string[] = [];
  for (const [file, n] of Object.entries(now)) {
    const before = was[file] ?? 0;
    if (n > before) grew.push(`${kind}: web/src/${file} has ${n} (was ${before})`);
  }
  for (const [file, before] of Object.entries(was)) {
    const n = now[file] ?? 0;
    if (n < before) fell.push(`${kind}: web/src/${file} has ${n} (baseline ${before})`);
  }
  return { grew, fell };
}

describe('overlay family: one look and one close for every floating surface', () => {
  const now = countAll();
  if (process.env.OVERLAY_FAMILY_RECORD === '1') fs.writeFileSync(BASELINE, `${JSON.stringify(now, null, 2)}\n`);
  const was = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Counts;

  for (const kind of KINDS) {
    it(`${kind}: no new overlay off the family`, () => {
      const { grew } = compare(kind, now[kind], was[kind]);
      expect(grew, `A floating surface off the family. Use the classes and hooks in web/src/styles/overlay-family.css and ${STANDARD}:\n${grew.join('\n')}`).toEqual([]);
    });
    it(`${kind}: the baseline follows every fix`, () => {
      const { fell } = compare(kind, now[kind], was[kind]);
      expect(fell, `Fewer exceptions than recorded: good. Lower the baseline with\nOVERLAY_FAMILY_RECORD=1 bun --bun vitest run tests/web/overlay-family-ratchet.test.ts\n${fell.join('\n')}`).toEqual([]);
    });
  }

  it('finds the overlays it guards', () => {
    const m = members();
    for (const known of ['task-kebab-menu', 'wn-context-menu', 'app-modal', 'cal-create-popover', 'worker-fold-tip']) expect(m, known).toContain(known);
    expect(portalRoots('createPortal(<div className="a wn-scrim"><div className={`b wn-dialog${x ? " c" : ""}`} /></div>, document.body)'))
      .toEqual([['a', 'wn-scrim', 'b', 'wn-dialog']]);
    // 2026-11-21 review: an aliased createPortal, other spellings of Escape and a hook named only
    // in a comment went past the scan.
    expect(portalRoots('import { createPortal as portal } from "react-dom"; portal(<div className="x" />, document.body)')).toEqual([['x']]);
    for (const spelling of ["e.key === 'Escape'", "'Escape' === e.key", "case 'Escape':", 'e.keyCode === 27']) {
      expect(spelling.match(ESCAPE_TEST), spelling).not.toBeNull();
    }
    expect(stripComments('// useOverlayLayer({ open })\nconst a = 1; /* useModalOverlay( */')).not.toMatch(/use(?:OverlayLayer|ModalOverlay)/);
    // A `/*` inside a line comment opens nothing (it swallowed 23 KB of SessionPathSelector).
    expect(stripComments('// see a/*.tsx\nuseOverlayLayer({ open })\n// */')).toMatch(/useOverlayLayer\(/);
    expect(stripComments('const u = "http://x"; const el = <p>a // b</p>;')).toContain('http://x');
  });

  it('every file it exempts still portals something, and says why', () => {
    for (const [file, why] of Object.entries(NOT_OVERLAY)) {
      const text = fs.readFileSync(path.join(WEB_SRC, file), 'utf8');
      expect(text, file).toContain('createPortal(');
      expect(why.length, file).toBeGreaterThan(10);
    }
  });

  it('every dialog close button draws the one close icon, at the one size', () => {
    // 2026-11-21 review: x, the multiplication sign, &times; and three hand-drawn SVGs closed dialogs side by side.
    const off: string[] = [];
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith('.tsx')) {
          const text = fs.readFileSync(p, 'utf8');
          for (const m of text.matchAll(/<button\b(?:=>|[^>])*?\bwn-dialog-close\b(?:=>|[^>])*?>([\s\S]*?)<\/button>/g)) {
            // The notes popup's close collapses it to its dock, so it draws the collapse icon.
            if (!['{ICON_CLOSE}', '{ICON_COLLAPSE}'].includes(m[1].trim())) off.push(`${path.relative(WEB_SRC, p)}: ${m[1].trim().slice(0, 40)}`);
            // One size too: 2026-11-22 audit, the org chart's small close read as far away and easy to miss.
            if (/\bbtn-(?:sm|xs)\b/.test(m[0].slice(0, m[0].length - m[1].length - '</button>'.length))) off.push(`${path.relative(WEB_SRC, p)}: a smaller close key`);
          }
        }
      }
    };
    walk(WEB_SRC);
    expect(off, 'A .wn-dialog-close renders {ICON_CLOSE} from web/src/components/common/Icons.tsx, as a plain btn btn-icon').toEqual([]);
  });

  it('the "more below" fade is measured in one place, useMoreBelow', () => {
    // 2026-11-22: the context menu measured it inline and the slash list not at all (its last row cut in half).
    const copies: string[] = [];
    for (const file of walkTsx(WEB_SRC)) {
      if (file.endsWith(path.join('hooks', 'useMoreBelow.ts'))) continue;
      if (/scrollHeight\s*-\s*\w+\.clientHeight[\s\S]{0,120}setMore\(/.test(fs.readFileSync(file, 'utf8'))) copies.push(path.relative(WEB_SRC, file));
    }
    expect(copies, 'Use useMoreBelow (web/src/hooks/useMoreBelow.ts) and data-more on the scroll box').toEqual([]);
  });

  it('a menu\'s backdrop is on the menu layer, so it stays over a dialog the menu opened in', () => {
    // 2026-11-22 review: with dialogs raised to the menu layer, the context menus' backdrops (9998,
    // 9999) fell under them, and a press outside a menu opened in a dialog no longer closed it.
    const backdrops = new Set<string>();
    for (const file of walkTsx(WEB_SRC)) {
      const text = fs.readFileSync(file, 'utf8');
      for (const roots of portalRoots(text)) {
        if (!roots.some((c) => c === 'wn-overlay' || c === 'wn-menu')) continue;
        for (const c of roots) if (/backdrop/.test(c)) backdrops.add(c);
      }
    }
    expect(backdrops.size).toBeGreaterThan(0);
    const off: string[] = [];
    for (const file of walkCss(WEB_SRC)) {
      for (const d of scanCss(path.relative(WEB_SRC, file), fs.readFileSync(file, 'utf8'))) {
        if (d.prop !== 'z-index') continue;
        const cls = d.selectors.flatMap((s) => [...s.matchAll(/\.([\w-]+)/g)].map((m) => m[1]));
        // A later rule of a co-class lifts a shared backdrop class (`.cal-popover-backdrop.code-ctx-backdrop`).
        if (cls.some((c) => backdrops.has(c)) && !/var\(--z-menu\)/.test(d.value) && !cls.some((c) => c === 'cal-popover-backdrop')) {
          off.push(`${path.relative(WEB_SRC, file)}:${d.line} ${d.selectors.join(', ')} { z-index: ${d.value} }`);
        }
      }
    }
    expect(off, 'z-index: var(--z-menu) (the menu is portalled after its backdrop, so it stays on top)').toEqual([]);
  });

  it('the standard names this family and this test', () => {
    const text = fs.readFileSync(path.join(__dirname, '../..', STANDARD), 'utf8');
    expect(text).toContain('tests/web/overlay-family-ratchet.test.ts');
    expect(text).toContain('wn-overlay');
  });
});
