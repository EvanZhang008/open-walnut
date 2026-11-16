/**
 * Beside placement (web/src/hooks/menu-placement-beside.ts): the calendar's new-item
 * popover opens next to the block it creates, right first, then left, with an arrow
 * at the block; with no room either side the hook stacks it and the arrow moves to
 * the facing edge. Never over the anchor, never off the window.
 */
import { describe, expect, it } from 'vitest';
import { besidePlacement, verticalArrow } from '../../web/src/hooks/menu-placement-beside';

const base = { naturalHeight: 300, menuWidth: 330, viewportWidth: 1280, viewportHeight: 860, gap: 12, margin: 8 };
const menuBox = (p: { top: number; right: number }, h = 300) => ({ left: 1280 - p.right - 330, right: 1280 - p.right, top: p.top, bottom: p.top + h });

describe('besidePlacement', () => {
  it('opens right of the anchor, arrow on its left edge at the anchor', () => {
    const anchor = { top: 400, bottom: 448, left: 380, right: 500 };
    const p = besidePlacement({ ...base, anchor })!;
    const m = menuBox(p);
    expect(m.left).toBe(512);
    expect(p.arrow.edge).toBe('left');
    expect(p.arrow.x).toBe(512);
    expect(p.arrow.y).toBeGreaterThanOrEqual(anchor.top);
    expect(p.arrow.y).toBeLessThanOrEqual(anchor.bottom);
  });

  it('flips left when the right has no room (the week\'s last day)', () => {
    const anchor = { top: 400, bottom: 448, left: 1120, right: 1240 };
    const p = besidePlacement({ ...base, anchor })!;
    const m = menuBox(p);
    expect(m.right).toBe(1108);
    expect(p.arrow.edge).toBe('right');
    expect(m.left).toBeGreaterThanOrEqual(8);
  });

  it('gives up (null) when neither side fits: a full-width day column', () => {
    expect(besidePlacement({ ...base, anchor: { top: 400, bottom: 448, left: 100, right: 1200 } })).toBeNull();
  });

  it('stays inside the window near its bottom, the arrow still on the anchor', () => {
    const anchor = { top: 820, bottom: 850, left: 380, right: 500 };
    const p = besidePlacement({ ...base, anchor })!;
    expect(p.top + 300).toBeLessThanOrEqual(860 - 8);
    expect(p.arrow.y).toBeGreaterThanOrEqual(820);
    expect(p.arrow.y).toBeLessThanOrEqual(p.top + 300 - 16);
  });

  it('points at the visible part of a block scrolled half above the window', () => {
    const anchor = { top: -200, bottom: 60, left: 380, right: 500 };
    const p = besidePlacement({ ...base, anchor })!;
    expect(p.top).toBeGreaterThanOrEqual(8);
    expect(p.arrow.y).toBeGreaterThanOrEqual(8);
    expect(p.arrow.y).toBeLessThanOrEqual(60);
  });

  it('caps a tall menu to the window and keeps maxHeight for scrolling', () => {
    const p = besidePlacement({ ...base, naturalHeight: 2000, anchor: { top: 400, bottom: 448, left: 380, right: 500 } })!;
    expect(p.maxHeight).toBe(860 - 16);
    expect(p.top).toBe(8);
  });
});

describe('verticalArrow', () => {
  it('sits on the bottom edge of a menu above the anchor, under the anchor\'s middle', () => {
    const a = verticalArrow({ top: 100, right: 400, maxHeight: 500, side: 'up' }, { left: 500, right: 700 }, 330, 300, 1280);
    expect(a).toEqual({ edge: 'bottom', x: 600, y: 400 });
  });

  it('sits on the top edge of a menu below it, kept off the rounded corners', () => {
    const a = verticalArrow({ top: 500, right: 100, maxHeight: 300, side: 'down' }, { left: 0, right: 10 }, 330, 300, 1280);
    expect(a.edge).toBe('top');
    expect(a.x).toBe(1280 - 100 - 330 + 16);
    expect(a.y).toBe(500);
  });
});
