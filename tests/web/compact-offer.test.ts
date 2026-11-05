/**
 * The prompt cache facts a session panel reads from its history when its record has none, and the
 * "+" row's token count, and which of two readings is current (web/src/components/sessions/compact-offer.ts).
 */
import { describe, it, expect } from 'vitest';
import { factsFromHistory, formatContextTokens, newerFacts } from '../../web/src/components/sessions/compact-offer';
import { ONE_HOUR_MS } from '../../src/core/sessions/prompt-cache';

describe('the token count', () => {
  it('words its numbers plainly', () => {
    expect(formatContextTokens(412_345)).toBe('412K');
    expect(formatContextTokens(1_250_000)).toBe('1.3M');
    expect(formatContextTokens(1_000_000)).toBe('1M');
  });
});

describe('the facts of a session that has none stored', () => {
  const usage = { input_tokens: 3, cache_creation_input_tokens: 2000, cache_read_input_tokens: 410_000, output_tokens: 30,
    cache_creation: { ephemeral_1h_input_tokens: 2000, ephemeral_5m_input_tokens: 0 } };
  it('come from the last reply\'s usage and time', () => {
    const f = factsFromHistory([
      { role: 'user', timestamp: '2026-11-04T09:59:00.000Z' },
      { role: 'assistant', timestamp: '2026-11-04T10:00:00.000Z', usage },
      { role: 'user', timestamp: '2026-11-04T10:00:05.000Z' },
    ])!;
    expect(f).toMatchObject({ tokens: 412_033, ttlMs: ONE_HOUR_MS, expiresAt: '2026-11-04T11:00:00.000Z' });
  });
  it('a compaction after it is read as compacted', () => {
    const f = factsFromHistory([
      { role: 'assistant', timestamp: '2026-11-04T10:00:00.000Z', usage },
      { role: 'system', timestamp: '2026-11-04T10:30:00.000Z', systemVariant: 'compact' },
    ]);
    expect(f?.compactedAt).toBe('2026-11-04T10:30:00.000Z');
    expect(factsFromHistory([])).toBeUndefined();
  });
});

describe('the current reading of the facts', () => {
  const before = { tokens: 400_000, ttlMs: ONE_HOUR_MS, requestAt: '2026-11-04T10:00:00.000Z', expiresAt: '2026-11-04T11:00:00.000Z' };
  const compacted = { tokens: 18_000, ttlMs: ONE_HOUR_MS, requestAt: '2026-11-04T10:05:00.000Z', compactedAt: '2026-11-04T10:05:00.000Z', expiresAt: '2026-11-04T11:05:00.000Z' };
  it('is the later one, whichever side holds it', () => {
    // A compaction sends no live usage after it: the live reading can be the one from before it.
    expect(newerFacts(before, compacted)).toBe(compacted);
    expect(newerFacts(compacted, before)).toBe(compacted);
  });
  it('is the one there is when only one is', () => {
    expect(newerFacts(undefined, compacted)).toBe(compacted);
    expect(newerFacts(before, undefined)).toBe(before);
    expect(newerFacts(undefined, undefined)).toBeUndefined();
  });
});
