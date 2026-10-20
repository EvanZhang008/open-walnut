import { describe, expect, it } from 'vitest';
import { costHeadline, costModelLabel, costTimes, fmtDuration, fmtRates, fmtUsd } from '../../web/src/components/sessions/session-cost-format';
import type { SessionCost } from '../../web/src/api/session-cost';

const base: SessionCost = { sessionId: 's', engine: 'claude', source: 'claude-transcript', status: 'priced', totalUsd: 29.1949,
  responses: 10, unpricedResponses: 0, models: [], prices: { source: 'litellm' } };

describe('session cost format', () => {
  it('formats money, durations and model names for the picker', () => {
    expect([fmtUsd(29.1949), fmtUsd(0.42), fmtUsd(0.0031), fmtUsd(0), fmtUsd(1234.5)]).toEqual(['$29.19', '$0.42', '$0.0031', '$0', '$1235']);
    expect([fmtDuration(45_000), fmtDuration(12 * 60_000), fmtDuration(3 * 3600_000 + 4 * 60_000), fmtDuration((5 * 24 + 11) * 3600_000)])
      .toEqual(['45s', '12m', '3h 4m', '5d 11h']);
    expect(costModelLabel('claude-opus-5-5')).toBe('Opus 5.5');
    expect(costModelLabel('gpt-6-1-sol')).toBe('GPT-6.1 Sol');
    expect(costModelLabel('gpt-6-luna')).toBe('GPT-6 Luna');
    expect(costModelLabel('claude-opus-5-5', 'fast')).toBe('Opus 5.5 fast');
  });

  it('says what the headline leaves out', () => {
    expect(costHeadline(base)).toBe('$29.19');
    expect(costHeadline({ ...base, status: 'partial', unpricedResponses: 4 })).toBe('$29.19 + 4 requests without a price');
    expect(costHeadline({ ...base, status: 'unpriced', totalUsd: null, unpricedResponses: 4 })).toBe('unknown (4 requests without a price)');
    expect(costHeadline({ ...base, status: 'unavailable', totalUsd: null })).toBe('not available');
  });

  it('shows how long the session ran and its model time, the live clock first', () => {
    const c = { ...base, firstAt: '2026-10-15T06:53:42.000Z', lastAt: '2026-10-20T18:15:20.000Z', apiDurationMs: 3_948_316 };
    expect(costTimes(c)).toBe('span 5d 11h · model time 1h 5m');
    expect(costTimes(c, 7_200_000)).toBe('span 5d 11h · model time 2h');
  });

  it('names both cache-write lifetimes only where the price has both', () => {
    expect(fmtRates({ input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5, cacheWrite1h: 8 }))
      .toBe('$4 in · $20 out · $0.2 cache read · $5 / $8 cache write (5m / 1h)');
    expect(fmtRates({ input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }, true)).toBe('$2 in · $10 out · $0.1 cache read · $2.5 cache write');
  });
});
