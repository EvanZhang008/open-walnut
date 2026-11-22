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

  it('every zone has a reason', () => {
    for (const [file, why] of Object.entries(ZONES)) expect(why.length, file).toBeGreaterThan(40);
  });
});
