/**
 * The big draws after a page load are drawn in slices (React transitions), so a key or a click
 * between slices goes first, and no draw lays the page out in the middle of a render.
 *
 * 2026-11-16, task 9bceb9f2: a Chromium boot of Home at the user's density on a 4x slower CPU
 * held the main thread 1.2 to 1.3 s in one task (the first mount, drawn at once); the Mac app
 * logged a 1.6 s block 3.2 s after a load, holding a chat's first content. Each check below
 * fails on the code before.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const read = (rel: string) => fs.readFileSync(path.join(__dirname, '..', '..', rel), 'utf8');

describe('boot draws in slices', () => {
  it('the app mounts as a transition', () => {
    const main = read('web/src/main.tsx');
    expect(main).toMatch(/startTransition\(\(\) => renderApp\(generation\)\)/);
    // Its boot phase ends at the first commit, not at the first macrotask after a sliced render.
    expect(main).toMatch(/<MountCommitted \/>/);
    expect(main).not.toMatch(/setTimeout\(\(\) => endPhase\(.boot:react-mount.\), 0\)/);
    // A remount on late prefs is a user-visible reset: that one stays urgent.
    expect(main).toMatch(/remount: \(\) => \{ if \(appRoot === root\) renderApp\(\+\+generation\); \}/);
  });

  it('the filter bar reads no layout while it renders', () => {
    const src = read('web/src/components/tasks/FilterBar.tsx');
    const body = src.slice(src.indexOf('export function FilterBar('));
    // Every listScroller call sits inside an effect, never in the render body.
    const calls = [...body.matchAll(/listScroller\(/g)].map((m) => m.index!);
    expect(calls.length).toBeGreaterThan(0);
    for (const at of calls) {
      const before = body.slice(Math.max(0, at - 200), at);
      expect(before, 'listScroller outside an effect').toMatch(/use(Layout)?Effect\(\(\) => \{[^]*$/);
    }
  });

  it("a chat's first thread marks wait for the frame after its commit before they read the page's styles", () => {
    const src = read('web/src/hooks/useThreadMarks.ts');
    expect(src).toMatch(/if \(derivedOnce\.current\) derive\(\);\s*else raf = requestAnimationFrame\(\(\) => \{ raf = 0; first = setTimeout\(derive, 0\); \}\);/);
  });
});
