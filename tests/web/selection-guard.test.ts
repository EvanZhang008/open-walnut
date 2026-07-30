/**
 * selection-guard — node-env safety contract.
 *
 * The module ships in the SPA but is imported by files that also run under
 * node-env vitest (via component transitive imports). Pin the contract that
 * it NEVER touches document/window at import time and that its predicates
 * fail closed (false = "no selection, don't pause anything") without a DOM.
 * Behavioral coverage (drag-select vs auto-scroll, freeze-during-selection)
 * lives in tests/e2e/browser/selection-copy.spec.ts against the real browser.
 */
import { describe, it, expect } from 'vitest';
import { pointerSelectingWithin, selectionIntersects } from '../../web/src/utils/selection-guard';

describe('selection-guard (no DOM)', () => {
  it('imports without touching document/window', () => {
    // Reaching this line means the import didn't throw in node env.
    expect(typeof pointerSelectingWithin).toBe('function');
    expect(typeof selectionIntersects).toBe('function');
  });

  it('pointerSelectingWithin fails closed without a DOM', () => {
    expect(pointerSelectingWithin(null)).toBe(false);
    expect(pointerSelectingWithin({ contains: () => true } as unknown as Element)).toBe(false);
  });

  it('selectionIntersects fails closed without a DOM', () => {
    expect(selectionIntersects(null)).toBe(false);
    expect(selectionIntersects({} as Element)).toBe(false);
  });
});
