/**
 * The conversation map's row arithmetic (web/src/utils/thread-map-rows.ts).
 *
 * Three rules that are invisible until they are wrong: the root row's branch count,
 * a thread row's size, and whether a branch announces that it grew. The last one is
 * shared with the child cards at the end of a thread, so a drift here shows up as a
 * badge in one place and not the other.
 */
import { describe, it, expect } from 'vitest';
import { branchCountLabel, hasNewRows, turnCountLabel } from '@/utils/thread-map-rows';
import { buildThreadTree, threadKeyOf } from '@/utils/thread-tree';
import type { ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';

describe('branchCountLabel', () => {
  it('counts the root row\'s branches, and says nothing when there are none', () => {
    expect(branchCountLabel(0)).toBe('');
    // Never a negative count in practice; a map row is not the place to show one.
    expect(branchCountLabel(-1)).toBe('');
    expect(branchCountLabel(1)).toBe('1 branch');
    expect(branchCountLabel(3)).toBe('3 branches');
  });
});

describe('turnCountLabel', () => {
  it('reads a thread\'s size in turns', () => {
    expect(turnCountLabel(1)).toBe('1 turn');
    expect(turnCountLabel(2)).toBe('2 turns');
    expect(turnCountLabel(0)).toBe('0 turns');
  });

  it('counts what the tree calls a turn: one entry per question in the thread', () => {
    const anchor = (msgId: string, parent: string): SessionThreadAnchor =>
      ({ msgId, parent, source: 'selection', at: '2026-09-04T10:00:00Z' });
    const messages: ThreadTreeMessage[] = [
      { role: 'user', msgId: 'u1', text: 'why not read-only' },
      { role: 'assistant', msgId: 'r1', text: 'because the pipe closes' },
      // Two follow-ups anchored on the same reply: one thread, two turns.
      { role: 'user', msgId: 'u2', text: 'what happens after the last writer' },
      { role: 'assistant', msgId: 'r2', text: 'the reader sees end of file' },
      { role: 'user', msgId: 'u3', text: 'and who reopens it' },
    ];
    const tree = buildThreadTree(messages, [anchor('u2', 'r1'), anchor('u3', 'r1')]);
    const node = tree.byKey.get(threadKeyOf({ parent: 'r1' }));
    expect(node?.turnIds).toEqual(['u2', 'u3']);
    expect(turnCountLabel(node!.turnIds.length)).toBe('2 turns');
    // One branch off the top level, which is what the root row reports.
    expect(branchCountLabel(tree.topCount)).toBe('1 branch');
  });
});

describe('hasNewRows', () => {
  const rows = new Map([['a', 5], ['b', 2]]);

  it('a thread never looked at has nothing to announce', () => {
    expect(hasNewRows('a', rows, new Map())).toBe(false);
  });

  it('announces growth since the baseline, and only growth', () => {
    expect(hasNewRows('a', rows, new Map([['a', 3]]))).toBe(true);
    expect(hasNewRows('a', rows, new Map([['a', 5]]))).toBe(false);
    // A rewritten transcript (/compact) shrinks a thread; that is not news.
    expect(hasNewRows('a', rows, new Map([['a', 9]]))).toBe(false);
  });

  it('reads a thread with a baseline but no rows as empty rather than throwing', () => {
    expect(hasNewRows('gone', rows, new Map([['gone', 2]]))).toBe(false);
    expect(hasNewRows('gone', rows, new Map([['gone', 0]]))).toBe(false);
  });

  it('is per thread: a sibling\'s growth is not this row\'s badge', () => {
    const seen = new Map([['a', 5], ['b', 1]]);
    expect(hasNewRows('a', rows, seen)).toBe(false);
    expect(hasNewRows('b', rows, seen)).toBe(true);
  });
});
