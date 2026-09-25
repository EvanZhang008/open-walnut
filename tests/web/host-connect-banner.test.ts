/**
 * The live host-connect banner's state machine (utils/host-connect-banner.ts):
 * the 1.5s no-flash threshold, the success hold, failures only when this page saw
 * the attempt start, dismiss vs the server's own timed retry, the queued rule,
 * and that every duration runs on the caller's monotonic clock, never on `at`.
 */

import { describe, it, expect } from 'vitest';
import type { HostStatus } from '../../web/src/api/hosts';

const b = await import('../../web/src/utils/host-connect-banner');

let seq = 0;
function st(host: string, over: Partial<HostStatus> = {}): HostStatus {
  return {
    host, label: host, hostname: `${host}.example`, connected: false, phase: 'ssh',
    phaseLabel: `Opening an SSH connection to ${host}…`, steps: [], phaseElapsedMs: 0,
    connectElapsedMs: 0, at: ++seq, ...over,
  };
}
const ok = (host: string, over: Partial<HostStatus> = {}) => st(host, { connected: true, phase: 'connected', phaseLabel: 'Connected', ...over });
const bad = (host: string, over: Partial<HostStatus> = {}) => st(host, { phase: 'failed', error: 'Permission denied (publickey)', ...over });

/** Feed frames in order at the given times and settle after each one. */
function run(frames: Array<[number, HostStatus[]]>): b.BannerState {
  let s = b.EMPTY_BANNER;
  for (const [t, list] of frames) s = b.settleBanner(b.ingestHostStatuses(s, list, t), t);
  return s;
}
const view = (s: b.BannerState, t: number) => b.bannerView(b.settleBanner(s, t), t);

describe('no flash', () => {
  it('a connect that finishes inside 1.5s never shows', () => {
    const s = run([[0, [st('devbox-a')]], [800, [ok('devbox-a')]]]);
    for (let t = 800; t < 5000; t += 100) expect(view(s, t).mode).toBe('hidden');
  });

  it('a longer connect shows at 1.5s with the phase sentence, and its time ticks locally', () => {
    const s = run([[0, [st('devbox-a', { connectElapsedMs: 0 })]]]);
    expect(view(s, 1400).mode).toBe('hidden');
    const v = view(s, 1600);
    expect(v.mode).toBe('connecting');
    expect(v.rows[0]).toMatchObject({ host: 'devbox-a', state: 'connecting' });
    expect(view(s, 4000).rows[0].elapsedMs).toBeGreaterThan(v.rows[0].elapsedMs);
    expect(b.bannerTitle(v, (h) => h)).toBe('Connecting to devbox-a');
  });

  it('a connect the server says is already long shows at once (reload mid-connect)', () => {
    const s = run([[0, [st('devbox-a', { connectElapsedMs: 20_000 })]]]);
    expect(view(s, 0).mode).toBe('connecting');
  });

  it('the server clock plays no part (skewed at)', () => {
    const s = run([[0, [st('devbox-a', { at: Date.now() + 5000, connectElapsedMs: 200 })]], [800, [ok('devbox-a')]]]);
    expect(view(s, 900).mode).toBe('hidden');
  });
});

describe('success', () => {
  it('holds a Connected state for 3s, then hides', () => {
    const s = run([[0, [st('devbox-a'), st('devbox-b')]], [2000, []], [5000, [ok('devbox-a'), ok('devbox-b')]]]);
    const v = view(s, 5100);
    expect(v.mode).toBe('success');
    expect(b.bannerTitle(v, (h) => h)).toBe('Connected to devbox-a and devbox-b');
    expect(view(s, 7500).mode).toBe('success');
    expect(view(s, 8100).mode).toBe('hidden');
  });

  it('a host that finished stays as a check row while another is still connecting', () => {
    const s = run([[0, [st('devbox-a'), st('devbox-b')]], [2000, []], [3000, [ok('devbox-a')]]]);
    const v = view(s, 9000);
    expect(v.mode).toBe('connecting');
    expect(v.rows.map((r) => [r.host, r.state])).toEqual([['devbox-a', 'connected'], ['devbox-b', 'connecting']]);
  });
});

describe('failures', () => {
  it('a failure of an attempt this page saw start stays, with its cause', () => {
    const s = run([[0, [st('devbox-b')]], [2000, []], [3000, [bad('devbox-b', { hint: 'Check your key' })]]]);
    const v = view(s, 13_000);
    expect(v.mode).toBe('failed');
    expect(v.rows[0]).toMatchObject({ state: 'failed' });
    expect(v.rows[0].status.hint).toBe('Check your key');
  });

  it('a host already failed when the page loaded is not news', () => {
    const s = run([[0, [bad('devbox-b', { retryInMs: 60_000 })]]]);
    expect(view(s, 5000).mode).toBe('hidden');
  });

  it("the server's timed retry of an old failure stays quiet, and its success is shown briefly", () => {
    const s0 = run([[0, [bad('devbox-b', { retryInMs: 5000 })]], [5000, [st('devbox-b')]]]);
    expect(view(s0, 9000).mode).toBe('hidden');
    const s1 = b.settleBanner(b.ingestHostStatuses(s0, [ok('devbox-b')], 12_000), 12_000);
    expect(view(s1, 12_100).mode).toBe('success');
    expect(view(s1, 15_100).mode).toBe('hidden');
  });

  it('a shown failure switches to connecting in place on a timed retry, then back', () => {
    const s = run([[0, [st('devbox-b')]], [2000, []], [3000, [bad('devbox-b', { retryInMs: 4000 })]]]);
    expect(view(s, 5000).rows[0].retryInMs).toBe(2000);
    const s2 = b.settleBanner(b.ingestHostStatuses(s, [st('devbox-b', { connectElapsedMs: 0 })], 7000), 7000);
    expect(view(s2, 7000).rows[0].state).toBe('connecting');
    const s3 = b.settleBanner(b.ingestHostStatuses(s2, [bad('devbox-b')], 7500), 7500);
    expect(view(s3, 7600).rows[0].state).toBe('failed');
  });
});

describe('dismiss', () => {
  it('hides until a new attempt; the timed retry of the dismissed failure does not count', () => {
    let s = run([[0, [st('devbox-b')]], [2000, []], [3000, [bad('devbox-b', { retryInMs: 4000 })]]]);
    s = b.dismissBanner(s, 4000);
    expect(view(s, 4100).mode).toBe('hidden');
    s = b.settleBanner(b.ingestHostStatuses(s, [st('devbox-b')], 7000), 7000);
    expect(view(s, 10_000).mode).toBe('hidden');
    s = b.settleBanner(b.ingestHostStatuses(s, [bad('devbox-b', { retryInMs: 8000 })], 11_000), 11_000);
    expect(view(s, 12_000).mode).toBe('hidden');
    // Another host starting a real attempt is news again.
    s = b.settleBanner(b.ingestHostStatuses(s, [st('devbox-a')], 12_000), 12_000);
    expect(view(s, 14_000).rows.map((r) => r.host)).toEqual(['devbox-a']);
  });

  it('a Retry-style attempt after dismiss (no server retry clock) shows again', () => {
    let s = run([[0, [st('devbox-b')]], [2000, []], [3000, [bad('devbox-b')]]]);
    s = b.dismissBanner(s, 4000);
    s = b.settleBanner(b.ingestHostStatuses(s, [st('devbox-b')], 5000), 5000);
    expect(view(s, 7000).mode).toBe('connecting');
  });
});

describe('queued and discovered', () => {
  it('a queued host shows only beside another shown host (or after its own 1.5s)', () => {
    const s = run([[0, [st('devbox-a'), st('devbox-b', { phase: 'queued' })]]]);
    expect(view(s, 1000).mode).toBe('hidden');
    const v = view(s, 1600);
    expect(v.rows.map((r) => r.state)).toEqual(['connecting', 'queued']);
  });

  it('a discovered host never produces a row', () => {
    const s = run([[0, [st('devbox-c', { discovered: true, connectElapsedMs: 30_000 })]]]);
    expect(view(s, 5000).mode).toBe('hidden');
  });

  it('rows keep first-seen order through state changes', () => {
    const s = run([[0, [st('devbox-a'), st('devbox-b')]], [2000, []], [3000, [bad('devbox-a')]]]);
    expect(view(s, 3100).rows.map((r) => r.host)).toEqual(['devbox-a', 'devbox-b']);
  });
});

describe('joinNames', () => {
  it('reads like a sentence', () => {
    expect(b.joinNames(['a'])).toBe('a');
    expect(b.joinNames(['a', 'b'])).toBe('a and b');
    expect(b.joinNames(['a', 'b', 'c'])).toBe('a, b and c');
  });
});
