/**
 * Tests for web/src/cache/finished-agents-store.ts — the client-side
 * accumulator for server-transported orphan finished-agent ids
 * (inc-1786496042099).
 *
 * Contract pinned here:
 *   · union-accumulating — a later response missing an id (whale tail window
 *     slid past the notification) must NOT erase proof already held;
 *   · stable snapshot reference until the set actually grows (required by
 *     useSyncExternalStore — a fresh object per get() would render-loop);
 *   · subscribers notified only on growth.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  recordFinishedAgentIds,
  getFinishedAgentIds,
  subscribeFinishedAgentIds,
  __resetFinishedAgentsForTesting,
} from '@/cache/finished-agents-store';

beforeEach(() => {
  __resetFinishedAgentsForTesting();
});

describe('finished-agents-store', () => {
  it('accumulates ids per session (union across responses)', () => {
    recordFinishedAgentIds('s1', ['toolu_a']);
    recordFinishedAgentIds('s1', ['toolu_b']);
    const ids = getFinishedAgentIds('s1');
    expect(ids.has('toolu_a')).toBe(true);
    expect(ids.has('toolu_b')).toBe(true);
    expect(getFinishedAgentIds('s2').size).toBe(0);
  });

  it('a later response missing an id does not shrink the set (finished only flaps to true)', () => {
    recordFinishedAgentIds('s1', ['toolu_a', 'toolu_b']);
    recordFinishedAgentIds('s1', ['toolu_b']); // whale window slid — toolu_a gone from payload
    recordFinishedAgentIds('s1', undefined);   // response with no field at all
    recordFinishedAgentIds('s1', []);
    const ids = getFinishedAgentIds('s1');
    expect(ids.has('toolu_a')).toBe(true);
    expect(ids.has('toolu_b')).toBe(true);
  });

  it('snapshot reference is stable until the set grows (useSyncExternalStore contract)', () => {
    recordFinishedAgentIds('s1', ['toolu_a']);
    const first = getFinishedAgentIds('s1');
    recordFinishedAgentIds('s1', ['toolu_a']); // no growth
    expect(getFinishedAgentIds('s1')).toBe(first); // same ref
    recordFinishedAgentIds('s1', ['toolu_b']); // growth
    expect(getFinishedAgentIds('s1')).not.toBe(first);
  });

  it('notifies subscribers only on growth; unsubscribe works', () => {
    let calls = 0;
    const off = subscribeFinishedAgentIds('s1', () => { calls++; });
    recordFinishedAgentIds('s1', ['toolu_a']);
    expect(calls).toBe(1);
    recordFinishedAgentIds('s1', ['toolu_a']); // duplicate — no notify
    expect(calls).toBe(1);
    recordFinishedAgentIds('s2', ['toolu_x']); // other session — no notify
    expect(calls).toBe(1);
    off();
    recordFinishedAgentIds('s1', ['toolu_b']);
    expect(calls).toBe(1);
  });
});
