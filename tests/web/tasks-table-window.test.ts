/**
 * The tasks table only renders the rows you can see, and the windowing arithmetic is
 * exact.
 *
 * Why the table is windowed at all (measured 2026-09-03 against the live server on the
 * real dataset, 2,923 tasks, three runs each):
 *
 *   open /tasks     before                    after
 *   ready           1984ms                    275ms
 *   main thread     blocked 1682ms            blocked 48ms
 *   DOM             79,073 elements           876 elements
 *   scroll          6-8 fps (WebKit)          98-100 fps
 *
 * Windowing is only safe if the scrollbar is a perfect lie: the spacer heights must add
 * up to exactly the height the full list would have, or every scroll position drifts.
 * Verified live (scrollHeight 107,240px, diff 0px from the arithmetic for all 2,983
 * items) and pinned here as logic.
 *
 * Two traps this file exists to hold shut:
 *
 *  1. The heights are hard-coded, so they must match the CSS. They are not measured at
 *     runtime on purpose (measuring 2,923 rows is the cost being avoided), which means a
 *     CSS change to `.tp-row` height silently misaligns every offset. Test reads both.
 *
 *  2. `visibleRangeFor` must never return a range SHORTER than the viewport. One item
 *     short shows a blank strip at the leading edge during a flick — the exact bug that
 *     reads as "scrolling is broken" and is miserable to spot by eye.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  ROW_H, GROUP_H, GHOST_H, WINDOW_MIN_ITEMS, OVERSCAN, visibleRangeFor, offsetsFor,
} from '../../web/src/components/tasks/tasks-table-window';

const WEB = path.resolve(import.meta.dirname, '../../web/src');
const CSS_SRC = fs.readFileSync(path.join(WEB, 'styles/tasks-page.css'), 'utf8');
const TABLE_SRC = fs.readFileSync(path.join(WEB, 'components/tasks/TasksPageTable.tsx'), 'utf8');

/**
 * The `height:` declared for a class in tasks-page.css.
 *
 * Scans EVERY rule whose selector list mentions the class, not just the first: these
 * classes also appear in a shared `.tp-thead, .tp-row, .tp-ghost { display: grid; … }`
 * rule that sets no height, and matching that one only would report "no height declared"
 * for a class that plainly has one.
 */
function cssHeight(cls: string): number {
  const found: number[] = [];
  // Comments first: a `/* … */` immediately above a rule is otherwise glued onto its
  // selector, so the selector no longer compares equal to the class name.
  const css = CSS_SRC.replace(/\/\*[\s\S]*?\*\//g, '');
  const rule = /([^{}]+)\{([^}]*)\}/g;
  for (let m = rule.exec(css); m; m = rule.exec(css)) {
    const selectors = m[1].split(',').map((s) => s.trim());
    if (!selectors.includes(cls)) continue;
    const h = m[2].match(/(?:^|[;\s])height:\s*(\d+(?:\.\d+)?)px/);
    if (h) found.push(Number(h[1]));
  }
  expect(
    found.length,
    `${cls} must declare exactly one explicit px height for windowing to work, found ${found.length}`,
  ).toBe(1);
  return found[0];
}

describe('tasks table windowing: heights match the CSS', () => {
  it('a row, a group header and a ghost row are the heights the code assumes', () => {
    // If this fails, the CSS moved and the offsets are now wrong everywhere below the
    // fold. Update the constants in web/src/components/tasks/tasks-table-window.ts.
    expect(cssHeight('.tp-row')).toBe(ROW_H);
    expect(cssHeight('.tp-group-header')).toBe(GROUP_H);
    expect(cssHeight('.tp-ghost')).toBe(GHOST_H);
  });

  it('nothing gives a row a height that varies with its content', () => {
    // `min-height` instead of `height`, or padding on `.tp-row`, would make rows taller
    // than ROW_H for long titles and every offset would drift by an unknown amount.
    const idx = CSS_SRC.indexOf('.tp-row {');
    const body = CSS_SRC.slice(idx, CSS_SRC.indexOf('}', idx) + 1);
    expect(body).not.toMatch(/min-height:/);
    expect(body).not.toMatch(/height:\s*auto/);
  });
});

describe('tasks table windowing: offsets are exact', () => {
  it('prefix sums land on the total height', () => {
    const heights = [GHOST_H, ROW_H, ROW_H, GROUP_H, ROW_H];
    const o = offsetsFor(heights);
    expect(o).toEqual([0, 34, 70, 106, 138, 174]);
    expect(o.at(-1)).toBe(heights.reduce((a, b) => a + b, 0));
  });

  it('the spacer arithmetic reproduces the full-list height for any window', () => {
    // This is the invariant the scrollbar depends on: leading spacer + rendered items +
    // trailing spacer == total. Checked at every possible window start, because a
    // boundary (first item, last item) is where the off-by-one would be.
    const heights = Array.from({ length: 400 }, (_, i) => (i % 40 === 0 ? GROUP_H : ROW_H));
    const o = offsetsFor(heights);
    const total = o.at(-1)!;
    for (let scrollTop = 0; scrollTop <= total; scrollTop += 137) {
      const [from, to] = visibleRangeFor(o, scrollTop, 900, OVERSCAN);
      const lead = o[from];
      const rendered = o[to + 1] - o[from];
      const trail = total - o[to + 1];
      expect(lead + rendered + trail, `window [${from},${to}] at scrollTop ${scrollTop}`).toBe(total);
    }
  });
});

describe('visibleRangeFor', () => {
  const heights = Array.from({ length: 1000 }, () => ROW_H);
  const offsets = offsetsFor(heights);

  it('covers the whole viewport, never one item short', () => {
    // The property that matters: every pixel of the viewport belongs to a rendered item.
    // Deliberately swept across offsets that fall INSIDE a row as well as on a boundary,
    // since a boundary-only test would miss a `<` vs `<=` mistake. Capped at the real
    // maximum scrollTop: past that there is no content left to cover, so asking for it
    // would be testing an impossible state rather than the range logic.
    const viewportH = 835;
    const maxTop = offsets.at(-1)! - viewportH;
    for (const scrollTop of [0, 1, 35, 36, 37, 719, 720, 721, 5000, 12345, maxTop]) {
      const [from, to] = visibleRangeFor(offsets, scrollTop, viewportH, 0);
      expect(offsets[from], `top edge covered at ${scrollTop}`).toBeLessThanOrEqual(scrollTop);
      expect(offsets[to + 1], `bottom edge covered at ${scrollTop}`)
        .toBeGreaterThanOrEqual(scrollTop + viewportH);
    }
  });

  it('overscan widens the range without walking off either end', () => {
    const [from, to] = visibleRangeFor(offsets, 0, 835, OVERSCAN);
    expect(from).toBe(0); // clamped, not negative
    const [from2, to2] = visibleRangeFor(offsets, 0, 835, 0);
    expect(to).toBe(to2 + OVERSCAN);
    expect(from2).toBe(0);
  });

  it('clamps at the very bottom of the list', () => {
    const total = offsets.at(-1)!;
    const [from, to] = visibleRangeFor(offsets, total - 835, 835, OVERSCAN);
    expect(to).toBe(heights.length - 1);
    expect(offsets[from]).toBeLessThanOrEqual(total - 835);
  });

  it('survives a scroll position past the end, and a negative one', () => {
    // A scroller can report an out-of-range scrollTop mid-resize (content shrank under
    // it). Returning an invalid slice there would throw while rendering.
    const [a, b] = visibleRangeFor(offsets, 10_000_000, 835, OVERSCAN);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(b).toBe(heights.length - 1);
    expect(a).toBeLessThanOrEqual(b);
    const [c, d] = visibleRangeFor(offsets, -500, 835, OVERSCAN);
    expect(c).toBe(0);
    expect(d).toBeGreaterThanOrEqual(0);
  });

  it('returns an empty range for an empty list', () => {
    expect(visibleRangeFor([0], 0, 835, OVERSCAN)).toEqual([0, -1]);
    expect(visibleRangeFor([], 0, 835, OVERSCAN)).toEqual([0, -1]);
  });

  it('handles a viewport taller than the whole list', () => {
    const small = offsetsFor(Array.from({ length: 5 }, () => ROW_H));
    expect(visibleRangeFor(small, 0, 5000, 0)).toEqual([0, 4]);
  });
});

describe('tasks table windowing: the component wiring', () => {
  it('short lists keep the old, unwindowed path', () => {
    // Several E2E specs locate rows by `data-task-id` or by text and assume every row is
    // in the DOM. Verified live on Inbox (36 tasks): 36 rows rendered, 0 spacers.
    expect(WINDOW_MIN_ITEMS).toBeGreaterThanOrEqual(100);
    expect(TABLE_SRC).toContain('items.length > WINDOW_MIN_ITEMS');
    expect(TABLE_SRC).toMatch(/!windowed[\s\S]{0,80}items\.map\(renderItem\)/);
  });

  it('scrolling does not re-render per pixel', () => {
    // A non-passive listener that setStates on every scroll event would hand back the
    // jank this change removed. The listener is passive, coalesced into one rAF, and
    // only setStates when the slice actually changes.
    expect(TABLE_SRC).toContain("addEventListener('scroll', onScroll, { passive: true })");
    expect(TABLE_SRC).toContain('requestAnimationFrame(compute)');
    expect(TABLE_SRC).toMatch(/if \(ps !== start \|\| pe !== stop\) setRange/);
  });

  it('the sticky project header is kept alive above the window', () => {
    // `.tp-group-header` is `position: sticky`, and a sticky element that is not in the
    // DOM cannot stick. Measured before the fix: at scrollTop 40000 the document held
    // ZERO group headers, so the table no longer said which project you were reading —
    // every row correct, the orientation gone. The covering header is now rendered
    // first and its height comes out of the leading spacer, which is why the total
    // height above still checks out.
    expect(CSS_SRC).toMatch(/\.tp-group-header \{[^}]*position:\s*sticky/);
    expect(TABLE_SRC).toMatch(/const pinned = headIdx >= 0 && headIdx < from/);
    expect(TABLE_SRC).toContain('offsets[from] - (pinned ? pinned.h : 0)');
  });
});
