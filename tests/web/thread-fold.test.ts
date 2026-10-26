/**
 * Conversation Mode's fold (utils/thread-fold.ts): a question's turns fold to
 * their label line, also while it is the target, its card is open or its answer
 * is on the way (2026-10-23: the card is where those turns are read). Only the
 * question holding a follow-up's passage stays open for it; a follow-up folds
 * with its question; the user's chevron wins over the rule. Over the map fixture the
 * browser specs load (Q1 with follow-ups Q1a and Q1b, Q4 with Q4a).
 */
import { describe, it, expect } from 'vitest';
import { buildThreadTree, ROOT_THREAD_KEY, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';
import { foldGroupOf, foldOpenKeys, foldParts, isFolded } from '@/utils/thread-fold';
import { buildMapSession } from '../e2e/browser/threads-fixture';

function map() {
  const s = buildMapSession(Date.parse('2026-10-15T12:00:00Z'));
  const messages: ThreadTreeMessage[] = s.rows.map((r) => ({ role: r.role, msgId: r.uuid, text: r.text }));
  const tree = buildThreadTree(messages, s.threadAnchors as SessionThreadAnchor[]);
  const k = (q: keyof typeof s.ids) => tree.byRow.get(s.ids[q].u)!.key;
  return { tree, k };
}

const NO_LIVE: string[] = [];
const NO_OVERRIDES: ReadonlyMap<string, boolean> = new Map();

describe('foldOpenKeys / isFolded', () => {
  it('folds every question while the composer is on the main conversation', () => {
    const { tree, k } = map();
    const open = foldOpenKeys(tree, { target: ROOT_THREAD_KEY, card: null, live: NO_LIVE });
    expect(open.size).toBe(0);
    for (const q of ['Q1', 'Q2', 'Q3', 'Q4'] as const) expect(isFolded(k(q), open, NO_OVERRIDES)).toBe(true);
    expect(isFolded(ROOT_THREAD_KEY, open, NO_OVERRIDES)).toBe(false);
  });

  it('folds the target itself; a follow-up target keeps the question holding its passage open', () => {
    const { tree, k } = map();
    const top = foldOpenKeys(tree, { target: k('Q1'), card: null, live: NO_LIVE });
    expect(isFolded(k('Q1'), top, NO_OVERRIDES)).toBe(true);
    const follow = foldOpenKeys(tree, { target: k('Q1a'), card: null, live: NO_LIVE });
    expect(isFolded(k('Q1'), follow, NO_OVERRIDES)).toBe(false);
    expect(isFolded(k('Q1a'), follow, NO_OVERRIDES)).toBe(true);
    expect(isFolded(k('Q4'), follow, NO_OVERRIDES)).toBe(true);
    expect(follow.has(ROOT_THREAD_KEY)).toBe(false);
  });

  it('folds the open card and a live question too; a live follow-up lifts only its question', () => {
    const { tree, k } = map();
    const live = [k('Q4a'), k('Q3')];
    const open = foldOpenKeys(tree, { target: ROOT_THREAD_KEY, card: k('Q2'), live });
    expect(isFolded(k('Q2'), open, NO_OVERRIDES)).toBe(true);
    expect(isFolded(k('Q3'), open, NO_OVERRIDES)).toBe(true);
    expect(isFolded(k('Q4'), open, NO_OVERRIDES)).toBe(false);
    expect(isFolded(k('Q1'), open, NO_OVERRIDES)).toBe(true);
  });

  it('keeps open the question holding a pending page\'s passage (an Ask on its answer)', () => {
    const { tree, k } = map();
    // The pending page is not in the tree: its key alone keeps nothing open.
    const bare = foldOpenKeys(tree, { target: 'pending-page', card: 'pending-page', live: NO_LIVE });
    expect(bare.size).toBe(0);
    const open = foldOpenKeys(tree, { target: 'pending-page', card: 'pending-page', live: NO_LIVE, holders: [k('Q1')] });
    expect(isFolded(k('Q1'), open, NO_OVERRIDES)).toBe(false);
    expect(isFolded(k('Q4'), open, NO_OVERRIDES)).toBe(true);
    // Asked on a follow-up's answer: the follow-up and its question stay open.
    const deep = foldOpenKeys(tree, { target: ROOT_THREAD_KEY, card: 'pending-page', live: NO_LIVE, holders: [k('Q1a')] });
    expect(deep.has(k('Q1a'))).toBe(true);
    expect(isFolded(k('Q1'), deep, NO_OVERRIDES)).toBe(false);
    expect(deep.has(ROOT_THREAD_KEY)).toBe(false);
  });

  it('lets the chevron win either way', () => {
    const { tree, k } = map();
    const open = foldOpenKeys(tree, { target: k('Q1a'), card: null, live: NO_LIVE });
    const overrides = new Map([[k('Q1'), false], [k('Q4'), true]]);
    expect(isFolded(k('Q1'), open, overrides)).toBe(true);
    expect(isFolded(k('Q4'), open, overrides)).toBe(false);
  });
});

describe('foldGroupOf', () => {
  it('names the top-level question for a follow-up, itself for a question, and the key for an unknown one', () => {
    const { tree, k } = map();
    expect(foldGroupOf(tree, k('Q1a'))).toBe(k('Q1'));
    expect(foldGroupOf(tree, k('Q1b'))).toBe(k('Q1'));
    expect(foldGroupOf(tree, k('Q4'))).toBe(k('Q4'));
    expect(foldGroupOf(tree, ROOT_THREAD_KEY)).toBe(ROOT_THREAD_KEY);
    expect(foldGroupOf(tree, 'not-in-the-tree')).toBe('not-in-the-tree');
  });
});

describe('foldParts', () => {
  const parts = ['r0', 'a1', 'a2', 'b1', 'r1', 'a3', 'c1'];
  const keyOf = (p: string) => (p.startsWith('r') ? ROOT_THREAD_KEY : p[0]);

  it('makes one line per run of a folded question, and leaves the rest alone', () => {
    const out = foldParts(parts, keyOf, (key) => key === 'a' || key === 'b');
    expect(out.map((o) => (o.kind === 'fold' ? `fold:${o.key}:${o.hidden}` : o.part))).toEqual([
      'r0', 'fold:a:2', 'fold:b:1', 'r1', 'fold:a:1', 'c1',
    ]);
    // The line carries the run's first part and its index (its row ids and key).
    const first = out[1];
    expect(first.kind === 'fold' && first.part === 'a1' && first.index === 1).toBe(true);
  });

  it('is the timeline itself when nothing is folded', () => {
    const out = foldParts(parts, keyOf, () => false);
    expect(out.every((o) => o.kind === 'part')).toBe(true);
    expect(out.map((o) => o.part)).toEqual(parts);
  });

  it('never folds the main conversation', () => {
    const out = foldParts(parts, keyOf, () => true);
    expect(out.filter((o) => o.kind === 'part').map((o) => o.part)).toEqual(['r0', 'r1']);
  });
});
