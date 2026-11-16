/**
 * nextToolbarFold (web/src/hooks/useToolbarFit.ts): a toolbar's labeled buttons fold to
 * icons, one step at a time, while the search field beside them would be too narrow to
 * read, and unfold only with room to spare (2026-11-16: typed text in the Home task panel
 * search showed four letters beside "New task" and "Display").
 */
import { describe, expect, it } from 'vitest';
import {
  nextToolbarFold, TOOLBAR_FIT_HYSTERESIS_PX as HYST, TOOLBAR_FIT_MIN_INPUT_PX as MIN, TOOLBAR_FIT_TYPING_RESERVE_PX as RESERVE,
} from '@/hooks/useToolbarFit';

const at = (o: Partial<Parameters<typeof nextToolbarFold>[0]>) =>
  nextToolbarFold({ step: 0, maxStep: 2, roomPx: 300, unfoldCostPx: 0, ...o });

describe('nextToolbarFold', () => {
  it('keeps the labels while the field keeps its readable width with typing beside it', () => {
    expect(at({ roomPx: MIN + RESERVE })).toBe(0);
    expect(at({ roomPx: MIN + RESERVE - 1 })).toBe(1);
  });

  it('a count wider than the reserve still never leaves the field under its readable width', () => {
    expect(at({ roomPx: MIN + RESERVE + 20, fieldPx: MIN - 1 })).toBe(1);
    expect(at({ roomPx: MIN + RESERVE + 20, fieldPx: MIN })).toBe(0);
  });

  it('folds one step per call and stops at the last step', () => {
    expect(at({ step: 1, roomPx: 40 })).toBe(2);
    expect(at({ step: 2, roomPx: 40 })).toBe(2);
  });

  it('unfolds only when the field keeps its readable width with the label back, plus the margin', () => {
    expect(at({ step: 1, roomPx: MIN + RESERVE + 50 + HYST, unfoldCostPx: 50 })).toBe(0);
    expect(at({ step: 1, roomPx: MIN + RESERVE + 50 + HYST - 1, unfoldCostPx: 50 })).toBe(1);
  });

  it('never unfolds on an unknown cost (a step it has not measured)', () => {
    expect(at({ step: 2, roomPx: 1000, unfoldCostPx: 0 })).toBe(2);
  });
});
