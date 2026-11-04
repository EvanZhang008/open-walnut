/**
 * The prompt cache facts a session's requests leave behind, and when an idle session should
 * compact before its cache expires (src/core/sessions/prompt-cache.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  FIVE_MINUTES_MS, ONE_HOUR_MS, IDLE_COMPACT_LEAD_MS, cacheExpiresAtMs, idleCompactionWindow, idleCompactReasonText,
  idleCompactThreshold, noteCompaction, noteRequestUsage, resolveIdleCompactLimitPercent, ttlFromUsage, type PromptCacheFacts,
} from '../../../src/core/sessions/prompt-cache.js';

const T0 = Date.parse('2026-11-04T10:00:00.000Z');
const big = (ttl: '1h' | '5m' | null, read = 398_000) => ({
  input_tokens: 3, cache_creation_input_tokens: 2_000, cache_read_input_tokens: read, output_tokens: 1,
  ...(ttl ? { cache_creation: { ephemeral_1h_input_tokens: ttl === '1h' ? 2_000 : 0, ephemeral_5m_input_tokens: ttl === '5m' ? 2_000 : 0 } } : {}),
});

describe('the cache lifetime a request names', () => {
  it('reads the 1-hour and 5-minute splits, and nothing from a request that wrote none', () => {
    expect(ttlFromUsage(big('1h'))).toBe(ONE_HOUR_MS);
    expect(ttlFromUsage(big('5m'))).toBe(FIVE_MINUTES_MS);
    expect(ttlFromUsage(big(null))).toBeUndefined();
    expect(ttlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 0, ephemeral_5m_input_tokens: 0 } })).toBeUndefined();
    expect(ttlFromUsage(undefined)).toBeUndefined();
    // A 1-hour prefix with a 5-minute tail: the tail is cold in five minutes, so five minutes counts.
    expect(ttlFromUsage({ cache_creation: { ephemeral_1h_input_tokens: 9000, ephemeral_5m_input_tokens: 400 } })).toBe(FIVE_MINUTES_MS);
  });
});

describe('the facts after each report of a request', () => {
  it('a new request sets its time, size and expiry; later reports of it only fill in counts', () => {
    const start = noteRequestUsage(undefined, big('1h'), T0, true)!;
    expect(start).toEqual({
      tokens: 400_004, ttlMs: ONE_HOUR_MS, requestAt: new Date(T0).toISOString(), expiresAt: new Date(T0 + ONE_HOUR_MS).toISOString(),
    });
    const delta = noteRequestUsage(start, { ...big('1h'), output_tokens: 900 }, T0 + 40_000, false)!;
    expect(delta.requestAt).toBe(start.requestAt);
    expect(delta.tokens).toBe(400_003 + 900);
    expect(delta.expiresAt).toBe(start.expiresAt);
  });

  it('a request that only read the cache keeps the lifetime it had, from its own start', () => {
    const first = noteRequestUsage(undefined, big('1h'), T0, true)!;
    const readOnly = { input_tokens: 2, cache_read_input_tokens: 402_000, output_tokens: 10 };
    const next = noteRequestUsage(first, readOnly, T0 + 600_000, true)!;
    expect(next.ttlMs).toBe(ONE_HOUR_MS);
    expect(next.expiresAt).toBe(new Date(T0 + 600_000 + ONE_HOUR_MS).toISOString());
  });

  it('a stream that reports usage only at its end still moves the request time at its start', () => {
    const first = noteRequestUsage(undefined, big('1h'), T0, true)!;
    const zero = { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 };
    const started = noteRequestUsage(first, zero, T0 + 5_000, true)!;
    expect(started.requestAt).toBe(new Date(T0 + 5_000).toISOString());
    expect(started.tokens).toBe(first.tokens);
    // Its final usage comes later, for the same request.
    const final = noteRequestUsage(started, big('1h', 420_000), T0 + 60_000, false)!;
    expect(final.requestAt).toBe(started.requestAt);
    expect(final.tokens).toBe(422_004);
  });

  it('no lifetime is guessed when no request ever named one', () => {
    const facts = noteRequestUsage(undefined, big(null), T0, true)!;
    expect(facts.ttlMs).toBeUndefined();
    expect(facts.expiresAt).toBeUndefined();
    // A reader that must assume one takes the longer lifetime.
    expect(cacheExpiresAtMs(facts)).toBe(T0 + ONE_HOUR_MS);
  });

  it('a compaction leaves the small context and marks it; the next request clears the mark', () => {
    const first = noteRequestUsage(undefined, big('1h'), T0, true)!;
    const compacted = noteCompaction(first, 18_000, T0 + 3_000_000);
    expect(compacted).toMatchObject({ tokens: 18_000, ttlMs: ONE_HOUR_MS, compactedAt: new Date(T0 + 3_000_000).toISOString() });
    const after = noteRequestUsage(compacted, { input_tokens: 5, cache_creation_input_tokens: 19_000, output_tokens: 50,
      cache_creation: { ephemeral_1h_input_tokens: 19_000 } }, T0 + 4_000_000, true)!;
    expect(after.compactedAt).toBeUndefined();
    expect(after.tokens).toBe(19_055);
  });
});

describe('when an idle session compacts', () => {
  const facts = (over: Partial<PromptCacheFacts> = {}): PromptCacheFacts => ({
    tokens: 400_000, ttlMs: ONE_HOUR_MS, requestAt: new Date(T0).toISOString(),
    expiresAt: new Date(T0 + ONE_HOUR_MS).toISOString(), compactsAt: 450_000, compactsAtSource: 'auto-compact', ...over,
  });

  it('a big session with a 1-hour cache compacts a few minutes before it expires', () => {
    expect(idleCompactionWindow(facts(), T0 + 1000)).toEqual({ fireAtMs: T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS, expiresAtMs: T0 + ONE_HOUR_MS });
  });

  // 2026-11-04, Evan: "it should be 80% of the auto compaction limit defined ... if can't find use max,
  // if don't know don't do" (85% by default). A 300K session under a 500K window is left alone.
  it('only past its share of where it compacts by itself, and never when that is unknown', () => {
    expect(idleCompactionWindow(facts({ tokens: 300_000, compactsAt: 500_000 }), T0)).toBeNull();
    expect(idleCompactionWindow(facts({ tokens: 425_000, compactsAt: 500_000 }), T0)).not.toBeNull();
    expect(idleCompactionWindow(facts({ tokens: 300_000, compactsAt: 500_000 }), T0, { limitPercent: 60 })).not.toBeNull();
    expect(idleCompactionWindow(facts({ compactsAt: undefined }), T0)).toBeNull();
    expect(idleCompactThreshold({ compactsAt: 500_000 })).toBe(425_000);
    expect(idleCompactThreshold({ compactsAt: 500_000 }, 90)).toBe(450_000);
    expect(idleCompactThreshold({})).toBeNull();
    // 2026-11-04 review: on a 200K window 85% (170K) comes after Claude Code's own compaction (about
    // 167K), so the threshold stays 45K under the window there, and a 99% share never passes it.
    expect(idleCompactThreshold({ compactsAt: 200_000 })).toBe(155_000);
    expect(idleCompactThreshold({ compactsAt: 500_000 }, 99)).toBe(455_000);
    expect([resolveIdleCompactLimitPercent(undefined), resolveIdleCompactLimitPercent(null), resolveIdleCompactLimitPercent(40),
      resolveIdleCompactLimitPercent(100), resolveIdleCompactLimitPercent(90)]).toEqual([85, 85, 85, 85, 90]);
  });

  it('a compaction carries where its session compacts by itself across it', () => {
    const after = noteCompaction(facts(), 18_000, T0 + 5000);
    expect(after).toMatchObject({ tokens: 18_000, compactsAt: 450_000, compactsAtSource: 'auto-compact' });
  });

  it('says why it ran: the tokens, the threshold, and where the threshold came from', () => {
    expect(idleCompactReasonText({ tokens: 430_000, threshold: 425_000, limitPercent: 85, compactsAt: 500_000, source: 'auto-compact' }))
      .toBe('430K tokens, past 85% (425K) of the 500K auto-compaction window this session uses');
    expect(idleCompactReasonText({ tokens: 900_000, threshold: 850_000, limitPercent: 85, compactsAt: 1_000_000, source: 'model' }))
      .toBe("900K tokens, past 85% (850K) of the model's 1M context window (no auto-compaction window is set)");
    expect(idleCompactReasonText({ tokens: 160_000, threshold: 155_000, limitPercent: 85, compactsAt: 200_000, source: 'model' }))
      .toBe("160K tokens, past 155K: 45K under the model's 200K context window (no auto-compaction window is set), since Claude Code compacts by itself before 85% (170K)");
  });

  it('never: a 5-minute cache, an unknown lifetime, compacted already, or expired', () => {
    expect(idleCompactionWindow(facts({ ttlMs: FIVE_MINUTES_MS, expiresAt: new Date(T0 + FIVE_MINUTES_MS).toISOString() }), T0)).toBeNull();
    expect(idleCompactionWindow(facts({ ttlMs: undefined, expiresAt: undefined }), T0)).toBeNull();
    expect(idleCompactionWindow(facts({ compactedAt: new Date(T0).toISOString() }), T0)).toBeNull();
    expect(idleCompactionWindow(facts(), T0 + ONE_HOUR_MS)).toBeNull();
    expect(idleCompactionWindow(undefined, T0)).toBeNull();
  });
});
