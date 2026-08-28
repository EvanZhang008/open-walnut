/** Stale-done-pin folding policy — pure functions behind the search-mode fold. */
import { describe, expect, it } from 'vitest';
import {
  isStaleDonePin,
  staleDonePinIds,
  STALE_DONE_PIN_DAYS,
} from '@/components/tasks/pin-search-fold';

const NOW = Date.parse('2026-08-28T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('isStaleDonePin', () => {
  it('never folds live work, however old', () => {
    expect(isStaleDonePin({ id: 'a', phase: 'IN_PROGRESS', updated_at: daysAgo(400) }, NOW)).toBe(false);
    expect(isStaleDonePin({ id: 'b', phase: 'AGENT_COMPLETE', updated_at: daysAgo(400) }, NOW)).toBe(false);
  });

  it('keeps a freshly completed pin visible and folds an old one', () => {
    expect(isStaleDonePin({ id: 'a', phase: 'COMPLETE', completed_at: daysAgo(STALE_DONE_PIN_DAYS - 1) }, NOW)).toBe(false);
    expect(isStaleDonePin({ id: 'b', phase: 'COMPLETE', completed_at: daysAgo(STALE_DONE_PIN_DAYS + 1) }, NOW)).toBe(true);
  });

  it('recognizes done via status, falls back to updated_at, and treats undated done as stale', () => {
    expect(isStaleDonePin({ id: 'a', status: 'done', updated_at: daysAgo(90) }, NOW)).toBe(true);
    expect(isStaleDonePin({ id: 'b', status: 'done', updated_at: daysAgo(2) }, NOW)).toBe(false);
    expect(isStaleDonePin({ id: 'c', phase: 'COMPLETE' }, NOW)).toBe(true);
  });
});

describe('staleDonePinIds', () => {
  it('collects only the stale done ids', () => {
    const ids = staleDonePinIds([
      { id: 'live', phase: 'IN_PROGRESS' },
      { id: 'fresh', phase: 'COMPLETE', completed_at: daysAgo(3) },
      { id: 'old', phase: 'COMPLETE', completed_at: daysAgo(90) },
      { id: 'old2', status: 'done', updated_at: daysAgo(45) },
    ], NOW);
    expect([...ids].sort()).toEqual(['old', 'old2']);
  });
});
