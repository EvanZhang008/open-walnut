/**
 * When a session panel offers "Compact first" (web/src/components/sessions/compact-offer.ts): a big
 * Claude Code session whose prompt cache has expired, not dismissed for that request, no turn running.
 */
import { describe, it, expect } from 'vitest';
import { compactOffer, compactOfferDueAt, factsFromHistory, formatAgo, formatContextTokens } from '../../web/src/components/sessions/compact-offer';
import { ONE_HOUR_MS, FIVE_MINUTES_MS, type PromptCacheFacts } from '../../src/core/sessions/prompt-cache';

const T0 = Date.parse('2026-11-04T10:00:00.000Z');
const facts = (over: Partial<PromptCacheFacts> = {}): PromptCacheFacts => ({
  tokens: 412_000, ttlMs: ONE_HOUR_MS, requestAt: new Date(T0).toISOString(),
  expiresAt: new Date(T0 + ONE_HOUR_MS).toISOString(), ...over,
});
const base = { acp: false, running: false, nowMs: T0 + 3 * ONE_HOUR_MS };

describe('the cold-cache offer', () => {
  it('shows for a big session whose cache expired, saying how long ago', () => {
    expect(compactOffer({ ...base, facts: facts() })).toEqual({ tokens: 412_000, expiredForMs: 2 * ONE_HOUR_MS, requestAt: facts().requestAt });
  });

  it('a 5-minute cache goes cold after 5 minutes', () => {
    const f = facts({ ttlMs: FIVE_MINUTES_MS, expiresAt: new Date(T0 + FIVE_MINUTES_MS).toISOString() });
    expect(compactOffer({ ...base, facts: f, nowMs: T0 + 4 * 60_000 })).toBeNull();
    expect(compactOffer({ ...base, facts: f, nowMs: T0 + 6 * 60_000 })).not.toBeNull();
  });

  it('an unknown lifetime is taken as an hour', () => {
    const f = facts({ ttlMs: undefined, expiresAt: undefined });
    expect(compactOffer({ ...base, facts: f, nowMs: T0 + 59 * 60_000 })).toBeNull();
    expect(compactOffer({ ...base, facts: f, nowMs: T0 + 61 * 60_000 })).not.toBeNull();
  });

  it('not while warm, small, compacted, running, dismissed, on ACP or in a chat lane', () => {
    expect(compactOffer({ ...base, facts: facts(), nowMs: T0 + 30 * 60_000 })).toBeNull();
    expect(compactOffer({ ...base, facts: facts({ tokens: 150_000 }) })).toBeNull();
    expect(compactOffer({ ...base, facts: facts({ tokens: 150_000 }), minTokens: 100_000 })).not.toBeNull();
    expect(compactOffer({ ...base, facts: facts({ compactedAt: new Date(T0).toISOString() }) })).toBeNull();
    expect(compactOffer({ ...base, facts: facts(), running: true })).toBeNull();
    expect(compactOffer({ ...base, facts: facts(), dismissedFor: facts().requestAt })).toBeNull();
    expect(compactOffer({ ...base, facts: facts(), acp: true })).toBeNull();
    expect(compactOffer({ ...base, facts: facts(), lane: 'chat:general:c1' })).toBeNull();
    expect(compactOffer({ ...base, facts: undefined })).toBeNull();
  });

  it('a dismissal holds for that request only: the next big turn can offer again', () => {
    const later = facts({ requestAt: new Date(T0 + ONE_HOUR_MS).toISOString(), expiresAt: new Date(T0 + 2 * ONE_HOUR_MS).toISOString() });
    expect(compactOffer({ ...base, facts: later, dismissedFor: facts().requestAt })).not.toBeNull();
  });

  it('knows when it will appear, to wake an open panel', () => {
    expect(compactOfferDueAt(facts())).toBe(T0 + ONE_HOUR_MS);
    expect(compactOfferDueAt(facts({ tokens: 10_000 }))).toBeNull();
    expect(compactOfferDueAt(undefined)).toBeNull();
  });

  it('words its numbers plainly', () => {
    expect(formatContextTokens(412_345)).toBe('412K');
    expect(formatContextTokens(1_250_000)).toBe('1.3M');
    expect(formatContextTokens(1_000_000)).toBe('1M');
    expect(formatAgo(10_000)).toBe('1 min');
    expect(formatAgo(42 * 60_000)).toBe('42 min');
    expect(formatAgo(ONE_HOUR_MS)).toBe('1 hour');
    expect(formatAgo(3 * ONE_HOUR_MS)).toBe('3 hours');
    expect(formatAgo(80 * ONE_HOUR_MS)).toBe('3 days');
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
    expect(compactOffer({ ...base, facts: f })).not.toBeNull();
  });
  it('a compaction after it means nothing to offer', () => {
    const f = factsFromHistory([
      { role: 'assistant', timestamp: '2026-11-04T10:00:00.000Z', usage },
      { role: 'system', timestamp: '2026-11-04T10:30:00.000Z', systemVariant: 'compact' },
    ]);
    expect(f?.compactedAt).toBe('2026-11-04T10:30:00.000Z');
    expect(compactOffer({ ...base, facts: f })).toBeNull();
    expect(factsFromHistory([])).toBeUndefined();
  });
});
