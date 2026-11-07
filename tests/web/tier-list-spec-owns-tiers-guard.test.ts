/**
 * Guard: a browser spec that pins the exact list of pin tier buttons owns the tier list it reads.
 *
 * Every browser spec talks to one fixture server, and several make real custom tiers on it while
 * others run (display-order-every-view, pinned-tier-order, entity-refs, kebab-menu-viewport-fit).
 * The draft's More menu lists every tier the server has, so a spec that expected exactly Focus,
 * Satellite and Parked read MixA/MixB from a spec running beside it (CI, 2026-11-07).
 *
 * The class: a `test(...)` block that asserts `.task-kebab-tier-btn` with `toHaveText([...])`
 * (an exact, ordered list). Each member routes GET `/api/focus/tiers` (the custom tier registry,
 * the only source of custom tiers in the page) to the list it expects. A new member fails here
 * until it does.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SPECS = join(__dirname, '../e2e/browser');

function testBlocks(src: string): { title: string; body: string }[] {
  const starts = [...src.matchAll(/^\s*test(?:\.only)?\(\s*(['"`])(.*?)\1/gm)];
  return starts.map((m, i) => ({
    title: m[2]!,
    body: src.slice(m.index!, i + 1 < starts.length ? starts[i + 1]!.index : src.length),
  }));
}

const EXACT_TIER_LIST = /\.task-kebab-tier-btn['"]\)\)\.toHaveText\(\s*\[/;
const OWNS_TIERS = /page\.route\(\s*['"`][^'"`]*\/api\/focus\/tiers['"`]/;

describe('a spec pinning the exact tier list owns the tier registry', () => {
  const members: string[] = [];
  const unowned: string[] = [];
  for (const file of readdirSync(SPECS).filter((f) => f.endsWith('.spec.ts'))) {
    const src = readFileSync(join(SPECS, file), 'utf8');
    for (const block of testBlocks(src)) {
      if (!EXACT_TIER_LIST.test(block.body)) continue;
      const key = `${file} :: ${block.title}`;
      members.push(key);
      if (!OWNS_TIERS.test(block.body)) unowned.push(key);
    }
  }

  it('finds the known member (the scan still reads the specs)', () => {
    expect(members.some((m) => m.startsWith('draft-decision-menu.spec.ts :: More on a fresh draft'))).toBe(true);
  });

  it('every member routes GET /api/focus/tiers', () => {
    expect(unowned, "route '**/api/focus/tiers' to the tiers the test expects").toEqual([]);
  });
});
