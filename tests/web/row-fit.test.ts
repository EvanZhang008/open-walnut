import { describe, it, expect, vi, afterEach } from 'vitest';
import { observeRowFit, rowFitFor, rowIsNarrow, ROW_FIT_NARROW_BELOW_PX, ROW_FIT_TIGHT_BELOW_PX } from '../../web/src/utils/row-fit';

afterEach(() => { vi.unstubAllGlobals(); });

describe('rowFitFor', () => {
  it('is tight below the threshold and roomy from it', () => {
    expect(rowFitFor(ROW_FIT_TIGHT_BELOW_PX - 1)).toBe('tight');
    expect(rowFitFor(ROW_FIT_TIGHT_BELOW_PX)).toBe('roomy');
    expect(rowFitFor(0)).toBe('tight');
    expect(rowFitFor(2000)).toBe('roomy');
  });
});

describe('rowIsNarrow', () => {
  it('is narrow below its threshold only, and never for an unmeasured 0', () => {
    expect(rowIsNarrow(ROW_FIT_NARROW_BELOW_PX - 1)).toBe(true);
    expect(rowIsNarrow(ROW_FIT_NARROW_BELOW_PX)).toBe(false);
    expect(rowIsNarrow(0)).toBe(false);
    expect(ROW_FIT_NARROW_BELOW_PX).toBeLessThan(ROW_FIT_TIGHT_BELOW_PX);
  });
});

describe('observeRowFit', () => {
  it('sets data-row-fit now, follows the width, and stops on cleanup', () => {
    let fire: () => void = () => {};
    let disconnected = false;
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: () => void) { fire = cb; }
      observe() {}
      disconnect() { disconnected = true; }
    });
    let width = 306;
    const el = { dataset: {} as Record<string, string>, get clientWidth() { return width; } } as unknown as HTMLElement;
    const stop = observeRowFit(el);
    expect(el.dataset.rowFit).toBe('tight');
    width = 640; fire();
    expect(el.dataset.rowFit).toBe('roomy');
    width = 300; fire();
    expect(el.dataset.rowFit).toBe('tight');
    expect(el.dataset.rowNarrow).toBeUndefined();
    width = ROW_FIT_NARROW_BELOW_PX - 1; fire();
    expect(el.dataset.rowNarrow).toBe('true');
    width = 300; fire();
    expect(el.dataset.rowNarrow).toBeUndefined();
    stop();
    expect(disconnected).toBe(true);
  });

  it('still sets the value where ResizeObserver does not exist', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const el = { dataset: {} as Record<string, string>, clientWidth: 500 } as unknown as HTMLElement;
    const stop = observeRowFit(el);
    expect(el.dataset.rowFit).toBe('roomy');
    expect(() => stop()).not.toThrow();
  });
});
