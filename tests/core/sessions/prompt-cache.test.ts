/**
 * The prompt cache facts a session's requests leave behind, and when an idle session should
 * compact before its cache expires (src/core/sessions/prompt-cache.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  FIVE_MINUTES_MS, ONE_HOUR_MS, IDLE_COMPACT_LEAD_MS, cacheExpiresAtMs, idleCompactionWindow, noteCompaction,
  noteRequestUsage, ttlFromUsage, type PromptCacheFacts,
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
    expiresAt: new Date(T0 + ONE_HOUR_MS).toISOString(), ...over,
  });

  it('a big session with a 1-hour cache compacts a few minutes before it expires', () => {
    expect(idleCompactionWindow(facts(), T0 + 1000)).toEqual({ fireAtMs: T0 + ONE_HOUR_MS - IDLE_COMPACT_LEAD_MS, expiresAtMs: T0 + ONE_HOUR_MS });
  });

  it('never: too small, a 5-minute cache, an unknown lifetime, compacted already, or expired', () => {
    expect(idleCompactionWindow(facts({ tokens: 150_000 }), T0)).toBeNull();
    expect(idleCompactionWindow(facts({ tokens: 150_000 }), T0, { minTokens: 100_000 })).not.toBeNull();
    expect(idleCompactionWindow(facts({ ttlMs: FIVE_MINUTES_MS, expiresAt: new Date(T0 + FIVE_MINUTES_MS).toISOString() }), T0)).toBeNull();
    expect(idleCompactionWindow(facts({ ttlMs: undefined, expiresAt: undefined }), T0)).toBeNull();
    expect(idleCompactionWindow(facts({ compactedAt: new Date(T0).toISOString() }), T0)).toBeNull();
    expect(idleCompactionWindow(facts(), T0 + ONE_HOUR_MS)).toBeNull();
    expect(idleCompactionWindow(undefined, T0)).toBeNull();
  });
});
