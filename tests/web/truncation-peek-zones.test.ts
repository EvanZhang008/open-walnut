/**
 * Cut-off text widens on hover only in a narrow side list of tasks (web/src/utils/truncation-peek-find.ts,
 * PEEK_ZONE_SELECTOR). 2026-11-23, the user, after a question card in a session opened down over the
 * reply box: "就是那种非常非常 narrow 的地方，然后可能我们放大可以，但所有东西都放大真的是不太舒服";
 * and on the Org page head: "这个 title 不要，就是放上去之后还要放大". Everywhere else the text keeps its
 * place, shows its full text as a native tooltip, and a click opens what holds it.
 *
 * A new place that widens is a new zone: it fails here until it is listed below with why.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { walk } from './truncation-peek-scan';

const ROOT = path.resolve(__dirname, '../..');
const WEB_SRC = path.join(ROOT, 'web/src');

/** The zones, each with why it may widen. */
const ZONES: Record<string, string> = {
  'web/src/components/tasks/TodoPanel.tsx': 'Home\'s task panel: the narrow side list beside the session columns, the sidebar-like list the user asked to widen (2026-11-12) and kept (2026-11-23)',
};

const ZONE_MARK = /data-peek-zone\b/;

describe('the truncation peek widens only in its zones', () => {
  it('only the listed components mark a zone', () => {
    const found = walk(WEB_SRC).filter((f) => /\.(tsx|ts)$/.test(f))
      .map((f) => path.relative(ROOT, f))
      .filter((rel) => rel !== 'web/src/utils/truncation-peek-find.ts' && rel !== 'web/src/utils/truncation-peek.ts')
      .filter((rel) => ZONE_MARK.test(fs.readFileSync(path.join(ROOT, rel), 'utf8')))
      .sort();
    expect(found, 'A new data-peek-zone widens cut text on hover there: the user wants that only in a narrow side list. List it in ZONES with why, or drop it').toEqual(Object.keys(ZONES).sort());
  });

  it('the peek asks the zone before it opens anything, and shows a tooltip outside it', () => {
    const find = fs.readFileSync(path.join(WEB_SRC, 'utils/truncation-peek-find.ts'), 'utf8');
    expect(find).toMatch(/export const PEEK_ZONE_SELECTOR = '\[data-peek-zone\]'/);
    expect(find).toMatch(/!peekAllowed\(target\)\) return null/);
    const peek = fs.readFileSync(path.join(WEB_SRC, 'utils/truncation-peek.ts'), 'utf8');
    expect(peek).toMatch(/!peekAllowed\(target\)\) \{[\s\S]{0,300}cutTip\(target\)/);
  });

  // The Time plugin's header pill grew a layer of exact numbers out of itself on hover: the same
  // widening, in a session's head. Its numbers are its tooltip now (task-slots.tsx TimeChip).
  it('the Time header pill grows no layer on hover or focus', () => {
    const dir = path.join(ROOT, 'examples/plugins/walnut-time/src/web');
    const css = fs.readFileSync(path.join(dir, 'styles-task.ts'), 'utf8');
    const tsx = fs.readFileSync(path.join(dir, 'task-slots.tsx'), 'utf8');
    expect(css, 'a .wt-pill rule that shows something on hover or focus').not.toMatch(/\.wt-pill(?::hover|:has\([^)]*:focus)[^{]*\{[^}]*(?:visibility:\s*visible|opacity:\s*1)/);
    expect(tsx).not.toMatch(/wt-pill-full/);
    expect(tsx).toMatch(/data-testid="time-session-chip"[\s\S]{0,300}title=\{tip\}/);
  });

  // A peek sits in the top layer, above every portal: it never opens while a floating layer shows
  // (2026-11-23: a cut task title opened over the right-click menu's Pin to). Every floating layer
  // takes a kind of the overlay family (tests/web/overlay-family-ratchet.test.ts), so each kind that
  // floats over the page is one the peek waits for; a new kind fails here until it is listed.
  it('the peek waits for every kind of floating layer', () => {
    const family = fs.readFileSync(path.join(WEB_SRC, 'styles/overlay-family.css'), 'utf8')
    const head = family.slice(0, family.indexOf('*/'))
    const kinds = [...head.matchAll(/^ {5}(wn-[a-z]+)\s/gm)].map((m) => m[1])
    expect(kinds.length, 'the family names its kinds').toBeGreaterThan(3)
    // wn-menu is a wn-overlay; a tooltip (wn-tip) covers nothing a person acts on.
    const notALayer = new Set(['wn-menu', 'wn-tip'])
    const find = fs.readFileSync(path.join(WEB_SRC, 'utils/truncation-peek-find.ts'), 'utf8')
    const selector = /export const OVERLAY_SELECTOR = '([^']+)'/.exec(find)?.[1] ?? ''
    for (const k of kinds.filter((k) => !notALayer.has(k))) expect(selector, `OVERLAY_SELECTOR names .${k}`).toContain(`.${k}`)
    const peek = fs.readFileSync(path.join(WEB_SRC, 'utils/truncation-peek.ts'), 'utf8')
    expect(peek, 'over() asks first').toMatch(/function over\([^)]*\)[^{]*\{[\s\S]{0,200}overlayShowing\(\)/)
    expect(peek, 'the open timer asks again').toMatch(/setTimeout\(\(\) => \{[\s\S]{0,160}overlayShowing\(\)/)
    expect(peek, 'a right-click closes an open peek').toMatch(/addEventListener\('contextmenu', hidePeek/)
  });

  it('every zone has a reason', () => {
    for (const [file, why] of Object.entries(ZONES)) expect(why.length, file).toBeGreaterThan(40);
  });
});
