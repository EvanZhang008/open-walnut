/**
 * The two draggable Mail columns' widths (mail-pane-widths.ts): what is stored, what is read back,
 * and the clamp that keeps the reader usable.
 *
 * - Only a DRAGGED width is stored; an absent width means "the stylesheet's default", which is what
 *   keeps the 1360px breakpoint working for a column nobody dragged.
 * - A stored number from an older build or a hand edit is re-clamped on read, never trusted.
 * - A throwing store (private window, full quota) reads as "no widths" and never throws.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PANE_BOUNDS, PANE_WIDTHS_KEY, READER_MIN, clampPane, paneStyle, readPaneWidths, writePaneWidths,
} from '../../web/src/apps/mail/mail-pane-widths';

let kept: Map<string, string>;

function install(opts: { throwOnGet?: boolean; throwOnSet?: boolean } = {}): void {
  kept = new Map<string, string>();
  vi.stubGlobal('window', {
    localStorage: {
      getItem: (key: string) => {
        if (opts.throwOnGet) throw new Error('this window refuses storage');
        return kept.get(key) ?? null;
      },
      setItem: (key: string, value: string) => {
        if (opts.throwOnSet) throw new Error('the quota is full');
        kept.set(key, value);
      },
      removeItem: (key: string) => { kept.delete(key); },
    },
  });
}

beforeEach(() => { install(); });
afterEach(() => { vi.unstubAllGlobals(); });

describe('clampPane', () => {
  it('keeps each column inside its bounds', () => {
    expect(clampPane('accounts', 10)).toBe(PANE_BOUNDS.accounts.min);
    expect(clampPane('accounts', 9_999)).toBe(PANE_BOUNDS.accounts.max);
    expect(clampPane('list', 10)).toBe(PANE_BOUNDS.list.min);
    expect(clampPane('list', 9_999)).toBe(PANE_BOUNDS.list.max);
    expect(clampPane('list', 400.6)).toBe(401);
  });

  it('stops where the reader would drop under READER_MIN, but never below the column minimum', () => {
    // 1000px of room for the list and the reader: the list may take at most 1000 - 380.
    expect(clampPane('list', 700, 1_000)).toBe(1_000 - READER_MIN);
    expect(clampPane('list', 500, 1_000)).toBe(500);
    // A console too narrow for both floors: the column keeps its minimum, the reader gets the rest.
    expect(clampPane('list', 500, 500)).toBe(PANE_BOUNDS.list.min);
  });
});

describe('stored widths', () => {
  it('round-trips the dragged columns only, rounded', () => {
    writePaneWidths({ list: 420.4 });
    expect(JSON.parse(kept.get(PANE_WIDTHS_KEY)!)).toEqual({ list: 420 });
    expect(readPaneWidths()).toEqual({ list: 420 });
    writePaneWidths({ accounts: 200, list: 500 });
    expect(readPaneWidths()).toEqual({ accounts: 200, list: 500 });
  });

  it('writing no widths removes the key (a reset leaves nothing behind)', () => {
    writePaneWidths({ list: 420 });
    writePaneWidths({});
    expect(kept.has(PANE_WIDTHS_KEY)).toBe(false);
  });

  it('re-clamps what it reads and drops what it cannot read', () => {
    kept.set(PANE_WIDTHS_KEY, JSON.stringify({ accounts: 5, list: 'wide', other: 3 }));
    expect(readPaneWidths()).toEqual({ accounts: PANE_BOUNDS.accounts.min });
    kept.set(PANE_WIDTHS_KEY, '[1,2]');
    expect(readPaneWidths()).toEqual({});
    kept.set(PANE_WIDTHS_KEY, '{not json');
    expect(readPaneWidths()).toEqual({});
  });

  it('a store that throws reads as no widths and a write is silently skipped', () => {
    install({ throwOnGet: true, throwOnSet: true });
    expect(readPaneWidths()).toEqual({});
    expect(() => writePaneWidths({ list: 400 })).not.toThrow();
  });
});

describe('paneStyle', () => {
  it('sets a custom property per dragged column and nothing for the others', () => {
    expect(paneStyle({})).toEqual({});
    expect(paneStyle({ list: 480 })).toEqual({ '--mail-list-w': '480px' });
    expect(paneStyle({ accounts: 200, list: 480 })).toEqual({ '--mail-accounts-w': '200px', '--mail-list-w': '480px' });
  });
});
