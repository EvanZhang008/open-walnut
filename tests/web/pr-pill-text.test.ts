import { describe, expect, it } from 'vitest';
import type { PrSnapshot } from '../../src/core/pull-requests/model';
import { prPillText } from '../../web/src/components/tasks/PrPill';

const url = (n: number) => `https://github.com/acme/app/pull/${n}`;
function pr(n: number, extra: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    provider: 'github', url: url(n), repo: 'acme/app', number: n, state: 'open', mine: true, author: 'walnut-dev',
    checks: { total: 2, passed: 1, failed: 1, pending: 0, skipped: 0, items: [] },
    checkedAt: '2026-11-04T10:00:00Z',
    ...extra,
  } as PrSnapshot;
}

describe('the pull request pill words', () => {
  it('folds to the number, the state word and how many more, each its own part', () => {
    const out = prPillText([pr(20), pr(21, { checks: { total: 1, passed: 1, failed: 0, pending: 0, skipped: 0, items: [] } })], [url(20), url(21)]);
    expect(out.text).toBe('#20 · 1 check failed (+1 PR)');
    expect(out.short).toBe('#20 1 check failed +1');
    expect(out.parts).toEqual({ n: '#20', who: undefined, word: '1 check failed', narrowWord: 'Failed', more: '+1', stale: undefined });
  });

  it('says what a review asked with room, and its short word in a narrower column', () => {
    const out = prPillText([pr(14, { review: 'changes_requested', checks: { total: 1, passed: 1, failed: 0, pending: 0, skipped: 0, items: [] } })], [url(14)]);
    expect(out.parts).toMatchObject({ word: 'Changes requested', narrowWord: 'Changes' });
    expect(out.text).toBe('#14 · Changes requested');
  });

  it('names another person in both forms', () => {
    const out = prPillText([pr(9, { mine: false, author: 'kim' })], [url(9)]);
    expect(out.text).toBe('#9 · 1 check failed · by kim');
    expect(out.short).toBe('#9 kim 1 check failed');
    expect(out.parts.who).toBe('kim');
  });

  it('marks an open pull request whose last read failed as not current, and only that', () => {
    const signedOut = { code: 'signed-out' as const, message: 'gh is not signed in' };
    expect(prPillText([pr(3, { error: signedOut })], [url(3)])).toMatchObject({ stale: true, text: '#3 · 1 check failed · not current', parts: { word: '1 check failed', narrowWord: 'Failed', stale: 'not current' } });
    expect(prPillText([pr(3)], [url(3)]).stale).toBe(false);
    // Merged is final: a failed read changes nothing about it.
    expect(prPillText([pr(3, { state: 'merged', error: signedOut })], [url(3)]).stale).toBe(false);
    // "not current" belongs to the state it follows; the count of more comes last.
    expect(prPillText([pr(3, { error: signedOut }), pr(4, { error: signedOut })], [url(3), url(4)]).short).toBe('#3 1 check failed not current +1');
  });

  it('of finished pull requests, leads with the one that merged', () => {
    const out = prPillText([pr(41, { state: 'closed' }), pr(40, { state: 'merged' })], [url(41), url(40)]);
    expect(out.lead?.number).toBe(40);
    expect(out.short).toBe('#40 Merged +1');
  });
});
