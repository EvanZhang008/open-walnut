/**
 * Pure rules behind two review fixes of the question stack:
 *  - widthTier (web/src/utils/thread-stack-state.ts): the panel and drawer width
 *    observers store a TIER, so a resize re-renders them only when a boundary is
 *    crossed, and every `w > 0 && w < tier` reader decides the same;
 *  - restoreAttempt (web/src/hooks/useThreadStack.ts): a reload restore whose page
 *    head is not in the loaded part of the transcript WAITS until the history is
 *    complete, instead of giving up on the first partial tree.
 */
import { describe, it, expect } from 'vitest';
import { widthTier } from '@/utils/thread-stack-state';
import { restoreAttempt } from '@/hooks/useThreadStack';
import { ROOT_THREAD_KEY, buildThreadTree, threadKeyOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';

describe('widthTier', () => {
  const tiers = [560, 600, 720];
  it('buckets a width to the largest tier at or below it; 0 stays unmeasured, below all is 1', () => {
    expect(widthTier(0, tiers)).toBe(0);
    expect(widthTier(-5, tiers)).toBe(0);
    expect(widthTier(300, tiers)).toBe(1);
    expect(widthTier(559.6, tiers)).toBe(1);
    expect(widthTier(560, tiers)).toBe(560);
    expect(widthTier(640, tiers)).toBe(600);
    expect(widthTier(1400, tiers)).toBe(720);
  });
  it('every `w > 0 && w < tier` reader decides the same on the bucket as on the width', () => {
    for (let w = 0; w <= 900; w += 7) {
      const b = widthTier(w, tiers);
      for (const t of tiers) expect(b > 0 && b < t).toBe(w > 0 && w < t);
    }
  });
  it('a pixel-by-pixel resize inside one tier yields one value', () => {
    const seen = new Set<number>();
    for (let w = 601; w < 720; w++) seen.add(widthTier(w, tiers));
    expect([...seen]).toEqual([600]);
  });
});

const user = (msgId: string): ThreadTreeMessage => ({ role: 'user', msgId, text: `q ${msgId}` });
const reply = (msgId: string): ThreadTreeMessage => ({ role: 'assistant', msgId, text: `a ${msgId}` });
const anchor = (msgId: string, parent: string, exact: string): SessionThreadAnchor =>
  ({ msgId, parent, source: 'selection', at: '2026-09-03T10:00:00Z', quote: { exact } });

describe('restoreAttempt: a partial transcript waits for the page head', () => {
  const a = anchor('u2', 'r1', 'alpha passage here');
  const b = anchor('u3', 'r2', 'beta passage here');
  // Phase 1 / a windowed tail: the question u2 is loaded, its follow-up page u3 is not yet.
  const partial = buildThreadTree([user('u1'), reply('r1'), user('u2'), reply('r2')], [a, b]);
  const full = buildThreadTree([user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3')], [a, b]);
  const none = new Set<string>();

  it('waits while the head is missing and the history is not complete', () => {
    expect(restoreAttempt(partial, { path: ['u2', 'u3'] }, none, false)).toBe('wait');
    expect(restoreAttempt(partial, { leaf: 'u3' }, none, false)).toBe('wait');
  });
  it('lands once the head arrives', () => {
    expect(restoreAttempt(full, { path: ['u2', 'u3'] }, none, false)).toEqual([ROOT_THREAD_KEY, threadKeyOf(a), threadKeyOf(b)]);
    expect(restoreAttempt(full, { leaf: 'u3' }, none, true)).toEqual([ROOT_THREAD_KEY, threadKeyOf(a), threadKeyOf(b)]);
  });
  it('gives up (root, no toast) once the full history is loaded and the head is still missing', () => {
    expect(restoreAttempt(partial, { path: ['u2', 'u3'] }, none, true)).toBeNull();
  });
  it('nothing asked, the root asked, or a hidden page: the root, no waiting', () => {
    expect(restoreAttempt(partial, null, none, false)).toBeNull();
    expect(restoreAttempt(full, { path: [] }, none, false)).toBeNull();
    expect(restoreAttempt(full, { path: ['u2'] }, new Set([threadKeyOf(a)]), false)).toBeNull();
  });
});
