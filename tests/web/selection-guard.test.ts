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
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import {
  KEEP_SELECTION_ATTR, heldPassageIntersects, pointerSelectingWithin, pressKeepsSelection, selectionIntersects,
} from '../../web/src/utils/selection-guard';
import { setHeldQuoteRange } from '../../web/src/utils/pin-highlights';

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

/**
 * The opt-out the mic uses so that reaching for voice input does not cost the user
 * their selection (reported 2026-09-10). The attribute NAME is the contract between
 * two files, and a typo in either one silently restores the bug — hence a unit test
 * at this level rather than only in the browser tier. That the attribute really sits
 * on the mic BUTTON is asserted in tests/e2e/browser/session-voice-selection.spec.ts.
 */
describe('pressKeepsSelection', () => {
  it('fails closed with no DOM at all (node env, nothing defined)', () => {
    expect(pressKeepsSelection(null)).toBe(false);
    expect(pressKeepsSelection({} as EventTarget)).toBe(false);
  });

  it('names the attribute the mic and the guard must agree on', () => {
    expect(KEEP_SELECTION_ATTR).toBe('data-keep-selection');
  });

  // The matching itself needs `Node`/`Element` to exist, since the predicate walks up
  // from whatever the press landed on. Minimal stand-ins rather than a whole DOM: the
  // only DOM call in the predicate is `closest()`.
  describe('with minimal DOM globals', () => {
    class FakeNode {
      parentElement: FakeElement | null = null;
    }
    class FakeElement extends FakeNode {
      constructor(private readonly opted: boolean) { super(); }
      closest(selector: string): FakeElement | null {
        return this.opted && selector === `[${KEEP_SELECTION_ATTR}]` ? this : null;
      }
    }
    const child = (parent: FakeElement | null): FakeNode => {
      const n = new FakeNode();
      n.parentElement = parent;
      return n;
    };

    beforeAll(() => {
      Object.assign(globalThis, { Node: FakeNode, Element: FakeElement });
    });
    afterAll(() => {
      delete (globalThis as Record<string, unknown>).Node;
      delete (globalThis as Record<string, unknown>).Element;
    });

    it('keeps the selection for a press inside an opted-out control', () => {
      expect(pressKeepsSelection(new FakeElement(true) as unknown as EventTarget)).toBe(true);
    });

    it('clears it for a press anywhere else', () => {
      expect(pressKeepsSelection(new FakeElement(false) as unknown as EventTarget)).toBe(false);
    });

    it('walks up from a non-element target (the icon inside the button)', () => {
      expect(pressKeepsSelection(child(new FakeElement(true)) as unknown as EventTarget)).toBe(true);
      expect(pressKeepsSelection(child(new FakeElement(false)) as unknown as EventTarget)).toBe(false);
      expect(pressKeepsSelection(child(null) as unknown as EventTarget)).toBe(false);
    });
  });
});

/**
 * A passage the quote pill HOLDS after the document selection collapsed (dictated
 * text took the composer's focus) counts as a selection for the scroll guards: the
 * reader is still pointing at those words, so follow-bottom must not carry them
 * away and growth above them is compensated. Pinned here because the guard reads
 * the pill's slot through `heldQuoteRange`, and a node-env consumer must still get
 * a plain false.
 */
describe('heldPassageIntersects', () => {
  const node = {} as Node;
  const rangeOver = (hit: boolean, collapsed = false) => ({
    collapsed,
    intersectsNode: () => hit,
  } as unknown as Range);

  afterAll(() => { setHeldQuoteRange(null); });

  it('is false with nothing held, and for no node', () => {
    setHeldQuoteRange(null);
    expect(heldPassageIntersects(node)).toBe(false);
    setHeldQuoteRange(rangeOver(true));
    expect(heldPassageIntersects(null)).toBe(false);
  });

  it('follows the held range while it is live', () => {
    setHeldQuoteRange(rangeOver(true));
    expect(heldPassageIntersects(node)).toBe(true);
    setHeldQuoteRange(rangeOver(false));
    expect(heldPassageIntersects(node)).toBe(false);
  });

  it('a collapsed held range (its text node re-rendered away) counts as nothing', () => {
    setHeldQuoteRange(rangeOver(true, true));
    expect(heldPassageIntersects(node)).toBe(false);
  });

  it('a range that throws on intersectsNode (detached) fails closed', () => {
    setHeldQuoteRange({ collapsed: false, intersectsNode: () => { throw new Error('detached'); } } as unknown as Range);
    expect(heldPassageIntersects(node)).toBe(false);
  });
});
