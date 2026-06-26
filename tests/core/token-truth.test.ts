/**
 * Tests for token-truth — the shared real-token-space gate used by both the
 * background-compaction trigger (needsCompaction) and the triage bail.
 *
 * Regression target: the offline estimator undercounts Claude 3+ payloads by ~35%,
 * so a real ~1.03M-token history estimated ~758K and sailed under every gate —
 * compaction NEVER fired and the conversation grew until it 400'd. The fix decides
 * in real-token space via max(estimate × 1.35, last EXACT API tokens).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  ESTIMATE_CORRECTION,
  recordLastTurnTokens,
  getLastTurnTokens,
  clearLastTurnTokens,
  effectiveTotalTokens,
} from '../../src/core/token-truth.js';

const CONV = 'conv-token-truth-test';

beforeEach(() => {
  clearLastTurnTokens(CONV);
  clearLastTurnTokens('other-conv');
});

describe('token-truth: effectiveTotalTokens', () => {
  it('applies the static correction when no exact count is cached', () => {
    // 758K raw estimate × 1.35 = ~1023K — the exact scenario that must now exceed an 800K gate.
    const eff = effectiveTotalTokens(758_000, CONV);
    expect(eff).toBe(Math.round(758_000 * ESTIMATE_CORRECTION));
    expect(eff).toBeGreaterThan(800_000);
  });

  it('prefers the EXACT API count when it is larger than the corrected estimate', () => {
    recordLastTurnTokens(CONV, 1_030_000); // ground truth from a real API turn
    // Even if the offline estimate is a laughably low 600K, the exact count wins.
    const eff = effectiveTotalTokens(600_000, CONV);
    expect(eff).toBe(1_030_000);
  });

  it('prefers the corrected estimate when it is larger than a stale small exact count', () => {
    recordLastTurnTokens(CONV, 100_000); // an old, small turn
    const eff = effectiveTotalTokens(900_000, CONV); // history grew a lot since
    expect(eff).toBe(Math.round(900_000 * ESTIMATE_CORRECTION));
  });

  it('is conversation-scoped — one conversation\'s exact count never leaks into another', () => {
    recordLastTurnTokens(CONV, 1_030_000);
    expect(effectiveTotalTokens(10_000, 'other-conv')).toBe(Math.round(10_000 * ESTIMATE_CORRECTION));
    expect(effectiveTotalTokens(10_000, CONV)).toBe(1_030_000);
  });

  it('falls back to corrected estimate when conversationId is undefined', () => {
    recordLastTurnTokens(CONV, 1_030_000);
    expect(effectiveTotalTokens(500_000, undefined)).toBe(Math.round(500_000 * ESTIMATE_CORRECTION));
  });

  it('ignores non-positive exact counts (never caches a 0)', () => {
    recordLastTurnTokens(CONV, 0);
    recordLastTurnTokens(CONV, -5);
    expect(getLastTurnTokens(CONV)).toBeUndefined();
    expect(effectiveTotalTokens(700_000, CONV)).toBe(Math.round(700_000 * ESTIMATE_CORRECTION));
  });

  it('clearLastTurnTokens forgets the stale post-prune count so the gate stops re-firing', () => {
    recordLastTurnTokens(CONV, 1_030_000);
    expect(effectiveTotalTokens(50_000, CONV)).toBe(1_030_000); // would keep firing on stale value
    // After a compaction prunes the conversation, we clear it:
    clearLastTurnTokens(CONV);
    // Now the gate reflects the shrunk conversation (small estimate × 1.35), not the stale 1.03M.
    expect(effectiveTotalTokens(50_000, CONV)).toBe(Math.round(50_000 * ESTIMATE_CORRECTION));
  });
});
