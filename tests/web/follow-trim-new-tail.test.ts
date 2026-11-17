/**
 * A column that comes back to Home after many turns takes them in one read: the whole tail
 * is new, none of it drawn yet. Whether a cut back to the tail hides anything the reader sees
 * is not known until it is drawn (rowsAboveAreOffscreen answers null), and the pass after
 * that judges it (SessionChatHistory trimCheck). 2026-11-17, page-memory-soak: a column
 * behind the Routines page for thirty turns drew all 841 rows on its way back (budget 336).
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { rowsAboveAreOffscreen } from '@/components/sessions/SessionChatHistory';

/** A chat box holding rows with these message indexes (only what rowsAboveAreOffscreen reads). */
function box(indexes: number[]): HTMLElement {
  const rows = indexes.map((i) => ({ dataset: { msgIndex: String(i) }, getBoundingClientRect: () => ({ top: -100 }) }));
  return {
    querySelectorAll: () => rows,
    querySelector: () => rows[0] ?? null,
    getBoundingClientRect: () => ({ top: 0 }),
  } as unknown as HTMLElement;
}

describe('a follow cut over a tail that is not drawn yet', () => {
  it('is not known while the tail is all new; nothing drawn is no cut', () => {
    expect(rowsAboveAreOffscreen(box([0, 1, 2, 3]), 10)).toBeNull();
    expect(rowsAboveAreOffscreen(box([]), 10)).toBe(false);
    expect(rowsAboveAreOffscreen(null, 10)).toBe(false);
    // Drawn from the tail on, above the box's top: judged at once, as before.
    expect(rowsAboveAreOffscreen(box([0, 5, 10, 11]), 10)).toBe(true);
  });

  it('a pass after the draw judges it, once per message list', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../web/src/components/sessions/SessionChatHistory.tsx'), 'utf8');
    expect(src).toMatch(/offscreen === null && trimCheckFor\.current !== messages/);
    expect(src).toMatch(/requestAnimationFrame\(\(\) => \{ trimCheckWanted\.current = false; setTrimCheck/);
    expect(src).toMatch(/windowGrowth, sessionId, trimCheck\]\);/);
  });
});
