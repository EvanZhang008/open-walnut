/**
 * Cut-off rows show their full text in place (web/src/utils/truncation-peek.ts; 2026-11-12,
 * the user, on a Home row's dark native tooltip: "I want it to actually make the full line
 * expanded like what we did for side bar"). Two guards:
 * - no element keeps a native `title` that only repeats its own text: that title was how a
 *   truncated row showed its full text, and it would now open a dark box over the pill (or
 *   repeat text in full view). A new row written that way fails here; drop the title, the peek
 *   needs nothing, or mark the element `data-peek="off"` if it must keep it;
 * - the pill's placement never leaves the window and grows out from the text's own spot.
 */
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findRepeatedTitles } from './truncation-peek-scan';
import { PEEK_EDGE, PEEK_PAD_X, PEEK_PAD_Y, placePeek, placeVertically } from '../../web/src/utils/truncation-peek-place';

const WEB_SRC = path.resolve(__dirname, '../../web/src');

describe('truncated rows rely on the in-place peek, not a native title', () => {
  it('no element carries a title that only repeats its own text', () => {
    const found = findRepeatedTitles(WEB_SRC).map((r) => `${r.file}:${r.line} <${r.tag} title=${r.title}>`);
    expect(found, 'A title that repeats the element\'s text is the native tooltip a cut-off row used. Remove it: utils/truncation-peek.ts shows the full text in place').toEqual([]);
  });

  it('the scan finds the shapes it is meant to find', async () => {
    const fs = await import('node:fs');
    const os = await import('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'peek-scan-'));
    fs.writeFileSync(path.join(dir, 'Row.tsx'), [
      'export const A = ({ t }: { t: string }) => <span className="x" title={t}>{t}</span>;',
      'export const B = () => <button title="Dismiss">Dismiss</button>;',
      'export const C = ({ t }: { t: string }) => <span title={`Go to ${t}`}>{t}</span>;',
      'export const D = ({ t }: { t: string }) => <span data-peek="off" title={t}>{t}</span>;',
      'export const E = ({ t }: { t: string }) => (',
      '  <span title={t}>',
      '    {t}',
      '  </span>',
      ');',
    ].join('\n'));
    try {
      expect(findRepeatedTitles(dir).map((r) => r.line)).toEqual([1, 2, 6]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('placePeek', () => {
  const vp = { width: 1280, height: 800 };

  it('keeps the text on its own spot and grows to the right on one line', () => {
    const box = placePeek({ left: 100, top: 50 }, 400, 200, vp);
    expect(box.left).toBe(100 - PEEK_PAD_X);
    expect(box.top).toBe(50 - PEEK_PAD_Y);
    expect(box.width).toBe(400 + PEEK_PAD_X * 2);
  });

  it('stays one line as far as the window allows, and wraps only past its width', () => {
    expect(placePeek({ left: 100, top: 50 }, 900, 200, vp).width).toBe(900 + PEEK_PAD_X * 2);
    const wide = placePeek({ left: 100, top: 50 }, 3000, 200, vp);
    expect(wide.width).toBe(vp.width - PEEK_EDGE * 2);
    expect(wide.left).toBe(PEEK_EDGE);
  });

  it('moves left, never past the window, when the room on the right is too narrow', () => {
    const box = placePeek({ left: 1100, top: 50 }, 600, 120, vp);
    expect(box.left + box.width).toBeLessThanOrEqual(vp.width - PEEK_EDGE);
    expect(box.width).toBe(600 + PEEK_PAD_X * 2);
  });

  it('fits a window narrower than the widest pill', () => {
    const narrow = { width: 400, height: 800 };
    const box = placePeek({ left: 30, top: 50 }, 2000, 100, narrow);
    expect(box.left).toBeGreaterThanOrEqual(PEEK_EDGE);
    expect(box.left + box.width).toBeLessThanOrEqual(narrow.width - PEEK_EDGE);
  });

  it('never narrower than what the row showed', () => {
    expect(placePeek({ left: 100, top: 50 }, 150, 300, vp).width).toBe(300 + PEEK_PAD_X * 2);
  });

  it('moves up when a wrapped pill would pass the bottom, never above the top edge', () => {
    const box = placePeek({ left: 100, top: 760 }, 3000, 200, vp);
    const placed = placeVertically(box, 120, vp.height);
    expect(placed.top + placed.height).toBeLessThanOrEqual(vp.height - PEEK_EDGE);
    expect(placeVertically(box, 2000, vp.height).top).toBe(PEEK_EDGE);
    expect(placeVertically(placePeek({ left: 100, top: 50 }, 300, 200, vp), 24, vp.height).top).toBe(50 - PEEK_PAD_Y);
  });
});
