/**
 * The question toast leaves the rows that just changed visible (N14): above the
 * composer when that is clear, beside an open drawer, else the transcript top.
 */
import { describe, expect, it } from 'vitest';
import { placeToast, type PlaceBox } from '@/utils/thread-toast-place';

const panel: PlaceBox = { left: 0, top: 0, right: 800, bottom: 900 };
const composer: PlaceBox = { left: 0, top: 780, right: 800, bottom: 880 };
const toast = { width: 300, height: 40 };
const base = { panel, composer, contentTop: 100, toast, drawer: null, avoid: [] as PlaceBox[] };

describe('placeToast (N14)', () => {
  it('sits centered just above the composer when nothing is under it', () => {
    expect(placeToast(base)).toEqual({ top: 780 - 8 - 40, centerX: 400 });
  });

  it('moves to the transcript top when the asked-from rows fill the spot above the composer', () => {
    const rows = [{ left: 20, top: 700, right: 780, bottom: 770 }];
    expect(placeToast({ ...base, avoid: rows })).toEqual({ top: 108, centerX: 400 });
  });

  it('with the drawer open, takes the free space right of the drawer', () => {
    const drawer = { left: 6, top: 60, right: 306, bottom: 894 };
    const treeRows = [{ left: 6, top: 700, right: 306, bottom: 760 }];
    const at = placeToast({ ...base, drawer, avoid: treeRows });
    expect(at.top).toBe(732);
    expect(at.centerX).toBe(Math.round(306 + 8 + (800 - 12 - 314) / 2));
  });

  it('when every spot covers something, the one covering least wins', () => {
    const avoid = [{ left: 0, top: 700, right: 800, bottom: 780 }, { left: 350, top: 100, right: 450, bottom: 150 }];
    const at = placeToast({ ...base, avoid });
    expect(at.top).toBe(108);
  });

  it('a read-only panel keeps the bottom offset', () => {
    expect(placeToast({ ...base, composer: null }).top).toBe(900 - 16 - 40);
  });

  it('a toast wider than the strip beside the drawer wraps into it instead of covering the drawer (N14)', () => {
    const wide = { width: 640, height: 40 };
    const drawer = { left: 6, top: 60, right: 306, bottom: 894 };
    const head = { left: 6, top: 60, right: 306, bottom: 96 };
    const treeRows = [{ left: 6, top: 100, right: 306, bottom: 880 }];
    const at = placeToast({ ...base, toast: wide, drawer, avoid: treeRows, hard: [head] });
    const free = 800 - 12 - 314;
    expect(at.maxWidth).toBe(Math.floor(free));
    expect(at.centerX).toBe(Math.round(314 + free / 2));
    // Two lines above the composer.
    expect(at.top).toBe(780 - 8 - 80);
  });

  it('never covers the drawer header while another spot is clear of it, even over more rows (N14)', () => {
    const narrow: PlaceBox = { left: 0, top: 0, right: 480, bottom: 900 };
    const drawer = { left: 6, top: 60, right: 306, bottom: 894 };
    const head = { left: 6, top: 100, right: 306, bottom: 140 };
    const treeRows = [{ left: 6, top: 600, right: 306, bottom: 880 }];
    const at = placeToast({ ...base, panel: narrow, toast: { width: 440, height: 40 }, drawer, avoid: treeRows, hard: [head] });
    expect(at.top).toBe(780 - 8 - 40);
    expect(at.maxWidth).toBeUndefined();
  });
});
