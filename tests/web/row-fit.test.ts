import { describe, it, expect, vi, afterEach } from 'vitest';
import { observeRowFit, rowFitFor, ROW_FIT_TIGHT_BELOW_PX } from '../../web/src/utils/row-fit';

afterEach(() => { vi.unstubAllGlobals(); });

describe('rowFitFor', () => {
  it('is tight below the threshold and roomy from it', () => {
    expect(rowFitFor(ROW_FIT_TIGHT_BELOW_PX - 1)).toBe('tight');
    expect(rowFitFor(ROW_FIT_TIGHT_BELOW_PX)).toBe('roomy');
    expect(rowFitFor(0)).toBe('tight');
    expect(rowFitFor(2000)).toBe('roomy');
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
