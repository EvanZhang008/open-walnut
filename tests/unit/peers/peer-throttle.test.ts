/**
 * Unit test: peer-throttle — hub-side rate limiting for peers.send.
 *
 * Covers (plan §8):
 * - the 11th send in the rolling window is refused with a correct retryAfterMs
 * - the window sliding past old sends frees slots again
 * - duplicate (sender, target, text) suppression: hit within window, expiry after
 * - different senders do not affect each other
 */
import { describe, it, expect } from 'vitest';
import {
  PeerThrottle,
  PEER_SEND_WINDOW_MS,
  PEER_SEND_MAX_PER_WINDOW,
  PEER_DUP_WINDOW_MS,
  PEER_PENDING_CAP,
} from '../../../src/core/peers/peer-throttle.js';

function makeThrottle(start = 1_000_000): { throttle: PeerThrottle; tick: (ms: number) => void } {
  let now = start;
  const throttle = new PeerThrottle(() => now);
  return { throttle, tick: (ms) => { now += ms; } };
}

describe('PeerThrottle — per-sender rolling window', () => {
  it('admits up to the cap and refuses the next send', () => {
    const { throttle, tick } = makeThrottle();
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) {
      expect(throttle.admit('sender', `target-${i}`, `msg ${i}`).allowed).toBe(true);
      tick(100);
    }
    const refused = throttle.admit('sender', 'target-x', 'one too many');
    expect(refused.allowed).toBe(false);
  });

  it('reports retryAfterMs as the time until the oldest send leaves the window', () => {
    const { throttle, tick } = makeThrottle();
    // First send at t0, then 9 more spread over 900ms.
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) {
      throttle.admit('sender', `target-${i}`, `msg ${i}`);
      tick(100);
    }
    // now = t0 + 1000; oldest send (t0) frees its slot at t0 + WINDOW.
    const refused = throttle.admit('sender', 'target-x', 'extra');
    expect(refused.allowed).toBe(false);
    if (!refused.allowed) {
      expect(refused.retryAfterMs).toBe(PEER_SEND_WINDOW_MS - 1000);
    }
  });

  it('frees slots once the window slides past old sends', () => {
    const { throttle, tick } = makeThrottle();
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) {
      throttle.admit('sender', `target-${i}`, `msg ${i}`);
    }
    expect(throttle.admit('sender', 'target-x', 'still capped').allowed).toBe(false);
    tick(PEER_SEND_WINDOW_MS + 1);
    expect(throttle.admit('sender', 'target-x', 'window slid').allowed).toBe(true);
  });

  it('does not count a refused send against the window', () => {
    const { throttle, tick } = makeThrottle();
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) {
      throttle.admit('sender', `target-${i}`, `msg ${i}`);
      tick(1);
    }
    // Hammering while capped must not extend the lockout.
    for (let i = 0; i < 20; i++) {
      expect(throttle.admit('sender', 'target-x', `retry ${i}`).allowed).toBe(false);
      tick(1);
    }
    tick(PEER_SEND_WINDOW_MS);
    expect(throttle.admit('sender', 'target-x', 'after window').allowed).toBe(true);
  });

  it('isolates senders from each other', () => {
    const { throttle } = makeThrottle();
    for (let i = 0; i < PEER_SEND_MAX_PER_WINDOW; i++) {
      throttle.admit('sender-a', `target-${i}`, `msg ${i}`);
    }
    expect(throttle.admit('sender-a', 'target-x', 'capped').allowed).toBe(false);
    expect(throttle.admit('sender-b', 'target-x', 'unaffected').allowed).toBe(true);
  });
});

describe('PeerThrottle — duplicate suppression', () => {
  it('refuses an identical (sender, target, text) within the dup window', () => {
    const { throttle, tick } = makeThrottle();
    expect(throttle.admit('sender', 'target', 'same note').allowed).toBe(true);
    tick(1000);
    const dup = throttle.admit('sender', 'target', 'same note');
    expect(dup.allowed).toBe(false);
    if (!dup.allowed) {
      expect(dup.retryAfterMs).toBe(PEER_DUP_WINDOW_MS - 1000);
    }
  });

  it('allows the identical message again after the dup window expires', () => {
    const { throttle, tick } = makeThrottle();
    expect(throttle.admit('sender', 'target', 'same note').allowed).toBe(true);
    tick(PEER_DUP_WINDOW_MS + 1);
    expect(throttle.admit('sender', 'target', 'same note').allowed).toBe(true);
  });

  it('treats a different target or text as a distinct message', () => {
    const { throttle } = makeThrottle();
    expect(throttle.admit('sender', 'target-a', 'note').allowed).toBe(true);
    expect(throttle.admit('sender', 'target-b', 'note').allowed).toBe(true);
    expect(throttle.admit('sender', 'target-a', 'other note').allowed).toBe(true);
  });

  it('scopes duplicates per sender', () => {
    const { throttle } = makeThrottle();
    expect(throttle.admit('sender-a', 'target', 'note').allowed).toBe(true);
    expect(throttle.admit('sender-b', 'target', 'note').allowed).toBe(true);
  });
});

describe('constants', () => {
  it('exports the plan §7 values', () => {
    expect(PEER_SEND_WINDOW_MS).toBe(60_000);
    expect(PEER_SEND_MAX_PER_WINDOW).toBe(10);
    expect(PEER_DUP_WINDOW_MS).toBe(300_000);
    expect(PEER_PENDING_CAP).toBe(50);
  });
});
