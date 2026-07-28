/**
 * computePlacement — the fixed-dropdown placement math.
 *
 * Regression origin: the task kebab menu guessed its own height with a
 * hardcoded constant (`extraSection ? 560 : 350`). On a short window the guess
 * was far below the real height, so the "flip upward" branch still ran off the
 * bottom of the screen AND — because a position:fixed menu lives in no scroll
 * container — the overflowing items were unreachable: no scrollbar, no way to
 * click them.
 *
 * The invariants below are exactly what broke, so they are asserted directly:
 *   I1. maxHeight never exceeds the viewport (minus margins).
 *   I2. top + min(height, maxHeight) never passes the bottom margin.
 *   I3. top is never above the top margin.
 *   I4. a menu that doesn't fit gets a maxHeight SMALLER than its natural
 *       height — i.e. it is told to scroll instead of overflow.
 */

import { describe, it, expect } from 'vitest';
import { computePlacement, type PlacementInput } from '../../web/src/hooks/useMenuPlacement';

const GAP = 2;
const MARGIN = 8;
const MIN_HEIGHT = 180;

function place(over: Partial<PlacementInput> = {}) {
  const input: PlacementInput = {
    anchor: { top: 100, bottom: 120, right: 900 },
    naturalHeight: 300,
    menuWidth: 260,
    viewportWidth: 1440,
    viewportHeight: 900,
    gap: GAP,
    margin: MARGIN,
    minHeight: MIN_HEIGHT,
    ...over,
  };
  return { input, out: computePlacement(input) };
}

/** Assert the three "always on screen" invariants for any input. */
function expectOnScreen(input: PlacementInput, out: { top: number; maxHeight: number }) {
  const height = Math.min(input.naturalHeight || out.maxHeight, out.maxHeight);
  expect(out.maxHeight).toBeLessThanOrEqual(input.viewportHeight - input.margin * 2);  // I1
  // Epsilon because real geometry is fractional — the pre-fix E2E failure read
  // "bottom edge past viewport (746.5 > 700)". These inputs are integers, but the
  // production values they mirror are not.
  expect(out.top + height).toBeLessThanOrEqual(input.viewportHeight - input.margin + 0.001); // I2
  expect(out.top).toBeGreaterThanOrEqual(input.margin);                                // I3
}

describe('computePlacement: normal case', () => {
  it('opens downward just below the anchor when it fits', () => {
    const { input, out } = place();
    expect(out.top).toBe(120 + GAP);
    expectOnScreen(input, out);
  });

  it('right-aligns to the anchor', () => {
    const { out } = place();
    expect(out.right).toBe(1440 - 900);
  });
});

describe('computePlacement: the reported bug — tall menu, short window', () => {
  // The reported geometry: an 800px-tall viewport, the kebab in the session
  // header (bottom ≈ 90), and a two-section menu (task actions + inline date
  // picker + Session section) ≈ 770px tall. The old code estimated 560, saw
  // "710px below, that fits", opened downward at y=92 and let the last ~60px
  // hang off the bottom — unreachable, because a fixed menu has no scrollbar.
  const TALL = 770;
  const REPORTED = { naturalHeight: TALL, viewportHeight: 800, anchor: { top: 70, bottom: 90, right: 900 } };

  it('caps maxHeight below the natural height so the menu scrolls', () => {
    const { input, out } = place(REPORTED);
    expect(out.maxHeight).toBeLessThan(TALL);   // I4 — told to scroll
    expectOnScreen(input, out);
  });

  it('stays on screen even when the window is shorter than the menu', () => {
    const { input, out } = place({ naturalHeight: TALL, viewportHeight: 400, anchor: { top: 60, bottom: 80, right: 900 } });
    expect(out.maxHeight).toBeLessThan(TALL);
    expectOnScreen(input, out);
  });

  it('leaves a menu that genuinely fits uncapped', () => {
    // Sanity guard on the other side: don't start scrolling menus that were fine.
    const { out } = place({ naturalHeight: 700, viewportHeight: 880, anchor: { top: 60, bottom: 80, right: 900 } });
    expect(out.maxHeight).toBe(700);
  });

  it('never returns a maxHeight larger than the viewport, even below minHeight room', () => {
    // Window shorter than minHeight (180). The naive ordering — clamp up to
    // minHeight and stop — hands back 180 in a 120px window and clips again, so
    // the viewport cap must be applied LAST and win.
    const { input, out } = place({ naturalHeight: TALL, viewportHeight: 120, anchor: { top: 40, bottom: 60, right: 900 } });
    expect(out.maxHeight).toBeLessThanOrEqual(120 - MARGIN * 2);
    expectOnScreen(input, out);
  });
});

describe('computePlacement: flipping', () => {
  it('flips upward when there is more room above', () => {
    // Anchor near the bottom: 40px below, ~780px above.
    const { input, out } = place({ naturalHeight: 400, anchor: { top: 800, bottom: 820, right: 900 } });
    expect(out.top).toBeLessThan(800);          // opened upward
    expect(out.top + 400).toBeLessThanOrEqual(800);
    expectOnScreen(input, out);
  });

  it('does NOT flip when the menu already fits below', () => {
    const { out } = place({ naturalHeight: 200, anchor: { top: 100, bottom: 120, right: 900 } });
    expect(out.top).toBe(122);
  });

  it('flipped-but-still-too-tall stays fully on screen (the old 560-guess failure)', () => {
    // Anchored low in a short window, menu taller than BOTH sides. The old code
    // computed `rect.top - 560` and let the rest hang off the bottom.
    const { input, out } = place({ naturalHeight: 700, viewportHeight: 500, anchor: { top: 420, bottom: 440, right: 900 } });
    expectOnScreen(input, out);
  });
});

describe('computePlacement: horizontal clamping', () => {
  it('keeps the left edge on screen for a narrow viewport', () => {
    const { out } = place({ viewportWidth: 320, menuWidth: 260, anchor: { top: 100, bottom: 120, right: 300 } });
    // right must be small enough that left = vw - right - width >= margin
    expect(320 - out.right - 260).toBeGreaterThanOrEqual(MARGIN);
  });

  it('never lets the menu hang off the right edge', () => {
    const { out } = place({ anchor: { top: 100, bottom: 120, right: 1500 } });
    expect(out.right).toBeGreaterThanOrEqual(MARGIN);
  });
});

describe('computePlacement: pre-measurement pass', () => {
  it('yields a usable box before the menu has mounted (height 0)', () => {
    const { input, out } = place({ naturalHeight: 0, menuWidth: 0 });
    expect(out.maxHeight).toBeGreaterThan(0);
    expectOnScreen(input, out);
  });
});

describe('computePlacement: cursor anchor (right-click a task row)', () => {
  it('treats a zero-height anchor as the cursor point', () => {
    const { input, out } = place({ anchor: { top: 300, bottom: 300, right: 640 }, naturalHeight: 300 });
    expect(out.top).toBe(302);
    expect(out.right).toBe(1440 - 640);
    expectOnScreen(input, out);
  });

  it('a cursor near the bottom edge still gets a fully visible menu', () => {
    const { input, out } = place({ anchor: { top: 860, bottom: 860, right: 640 }, naturalHeight: 500 });
    expectOnScreen(input, out);
  });
});

describe('computePlacement: idempotence (ResizeObserver re-measure must not ratchet)', () => {
  // The hook applies maxHeight to the very element a ResizeObserver watches, so
  // place() runs again on every cap change. Convergence rests on scrollHeight
  // being cap-independent — verified in a real Chromium: an element with 801px of
  // content reports scrollHeight 801 whether max-height is unset, 300px or 150px.
  it('re-running with the same natural height returns the same box', () => {
    const args = { naturalHeight: 700, viewportHeight: 880, anchor: { top: 60, bottom: 80, right: 900 } };
    const first = place(args).out;
    const second = place(args).out;
    expect(second).toEqual(first);
  });

  it('does not ratchet even if a caller mistakenly feeds the capped height back', () => {
    // Guards the failure mode directly: if the impl ever read a CLAMPED height
    // (offsetHeight/clientHeight) instead of scrollHeight, each pass would shrink
    // the menu further. Feeding maxHeight back in must reach a fixed point.
    const base = { viewportHeight: 800, anchor: { top: 70, bottom: 90, right: 900 } };
    let h = 770;
    const seen: number[] = [];
    for (let i = 0; i < 5; i++) {
      h = place({ ...base, naturalHeight: h }).out.maxHeight;
      seen.push(h);
    }
    // Converged after the first pass, and never collapsed toward zero.
    expect(new Set(seen).size).toBe(1);
    expect(h).toBeGreaterThan(MIN_HEIGHT);
  });
});
