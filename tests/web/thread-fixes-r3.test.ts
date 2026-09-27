/**
 * Pure rules behind the slice 1 round 3 fixes: the same-passage note stays on
 * its page while the page is on the stack (C4), a question mark claims the
 * press before the pin popover sees it (N38), and the toast clock survives a
 * pointerenter that lands before it started (N39), the composer names the
 * question (N35), and a late search match gets a window (N23).
 */
import { describe, expect, it } from 'vitest';
import { nextSamePassageKeys } from '@/utils/thread-same-passage';
import { claimPress, isPressClaimed } from '@/utils/thread-mark-hit';
import { toastClock } from '@/components/sessions/ThreadPanelToast';
import { FOLLOW_UP_PLACEHOLDER, followUpPlaceholder } from '@/hooks/useSessionThreads';
import { windowOnMatch } from '@/utils/thread-search-window';
import { flattenTree, hitSnippet, matchRanges } from '@/utils/thread-tree-rows';
import { buildThreadTree, ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { indexMeta } from '@/utils/thread-meta';

const plan = (to: string, pushed: string[]) => ({ to, pushed });

describe('same-passage note (C4)', () => {
  it('stays on every page of the path that an already asked Ask opened', () => {
    let keys = nextSamePassageKeys([], ['root', 'a'], plan('a', ['a']), 'same-passage');
    expect(keys).toEqual(['a']);
    keys = nextSamePassageKeys(keys, ['root', 'a', 'b'], plan('b', ['b']), 'same-passage');
    expect(keys).toEqual(['a', 'b']);
    keys = nextSamePassageKeys(keys, ['root', 'a', 'b', 'c'], plan('c', ['c']), 'mark');
    expect(keys).toEqual(['a', 'b']);
    // Pops: the page returned to keeps its note; a page off the path drops it.
    keys = nextSamePassageKeys(keys, ['root', 'a', 'b'], plan('b', []), 'escape');
    expect(keys).toEqual(['a', 'b']);
    keys = nextSamePassageKeys(keys, ['root', 'a'], plan('a', []), 'escape');
    expect(keys).toEqual(['a']);
    keys = nextSamePassageKeys(keys, ['root'], plan('root', []), 'escape');
    expect(keys).toEqual([]);
  });

  it('a page entered again any other way loses its note', () => {
    const keys = nextSamePassageKeys(['a'], ['root', 'x', 'a'], plan('a', ['x', 'a']), 'drawer');
    expect(keys).toEqual([]);
  });
});

describe('press claim (N38)', () => {
  it('marks one event, not the next', () => {
    const a = new Event('pointerup');
    const b = new Event('pointerup');
    expect(isPressClaimed(a)).toBe(false);
    claimPress(a);
    expect(isPressClaimed(a)).toBe(true);
    expect(isPressClaimed(b)).toBe(false);
  });
});

describe('toast clock (N39)', () => {
  it('a pause before the first start does not end the toast', () => {
    const c = toastClock(8000);
    c.pause(1_790_000_000_000);
    expect(c.start(1_790_000_000_100)).toBe(8000);
  });

  it('hover pauses once; a second enter counts nothing twice', () => {
    const c = toastClock(8000);
    expect(c.start(1000)).toBe(8000);
    c.pause(3000);
    c.pause(5000);
    expect(c.start(9000)).toBe(6000);
  });
});

describe('composer names the question (N35)', () => {
  it('reads Reply in <title>, cut to 40 characters', () => {
    expect(followUpPlaceholder('Buffer flush order')).toBe('Reply in “Buffer flush order”…');
    const long = 'Point 21: the island pass reads the quarry before it writes';
    const p = followUpPlaceholder(long);
    expect(p.startsWith('Reply in “Point 21: the island pass reads')).toBe(true);
    expect(p.length).toBeLessThanOrEqual('Reply in “”…'.length + 40);
    expect(followUpPlaceholder('')).toBe(FOLLOW_UP_PLACEHOLDER);
  });
});

describe('search window (N23)', () => {
  it('an early match keeps the line whole; a late one gets a window that starts before it', () => {
    expect(windowOnMatch('Lantern pass reads the cellar', 'lantern', 44)).toBe('Lantern pass reads the cellar');
    const late = 'Point 24: the lattice pass reads the lantern before it writes.';
    const w = windowOnMatch(late, 'lantern', 44);
    expect(w.startsWith('…')).toBe(true);
    expect(w.toLowerCase().indexOf('lantern')).toBeLessThan(24);
  });
});

describe('match ranges through an ellipsis (N23)', () => {
  it('finds the match in a title that ends or starts with an ellipsis', () => {
    const t = '…pass reads the lantern…';
    const r = matchRanges(t, 'lantern');
    expect(r).toHaveLength(1);
    expect(t.slice(r[0][0], r[0][1])).toBe('lantern');
    expect(matchRanges('Point 24: the lantern pass', 'lantern').map(([a, b]) => [a, b])).toEqual([[14, 21]]);
  });
});

describe('drawer rows: pending order and the Hidden group (N44, N45)', () => {
  const msg = (role: 'user' | 'assistant', msgId: string) => ({ role, msgId, text: `${role} ${msgId}` });
  // Root turns u1/r1 and u3/r3; A asked about r1, B asked about r3.
  const messages = [msg('user', 'u1'), msg('assistant', 'r1'), msg('user', 'u3'), msg('assistant', 'r3'),
    msg('user', 'u2'), msg('assistant', 'r2'), msg('user', 'u4'), msg('assistant', 'r4')];
  const at = '2026-09-27T10:00:00Z';
  const tree = buildThreadTree(messages, [
    { msgId: 'u2', parent: 'r1', source: 'manual', at },
    { msgId: 'u4', parent: 'r3', source: 'manual', at },
  ]);
  const base = {
    filter: 'all' as const, query: '', collapsed: new Set<string>(), doneGroupsOpen: new Set<string>(), showHidden: false,
    currentKey: ROOT_THREAD_KEY,
  };

  it('a pending question asked from the first answer sits before the question from the second', () => {
    const rows = flattenTree(tree, indexMeta([]), [], undefined, {
      ...base, pending: { pageKey: 'pending:r1:1', parentKey: ROOT_THREAD_KEY, parentMsgId: 'r1', title: 'x' },
    }).rows.filter((r) => r.kind === 'thread' || r.kind === 'pending');
    expect(rows.map((r) => (r.kind === 'pending' ? 'pending' : tree.byKey.get(r.key)?.headId))).toEqual(['u2', 'pending', 'u4']);
  });

  it('the Hidden group shows under All only', () => {
    const index = indexMeta([{ headId: 'u4', status: 'open', hidden: true, updatedAt: at }]);
    const all = flattenTree(tree, index, [], undefined, { ...base, showHidden: true }).rows;
    expect(all.some((r) => r.kind === 'hidden')).toBe(true);
    const pinned = flattenTree(tree, index, [], undefined, { ...base, filter: 'pinned', showHidden: true }).rows;
    expect(pinned.some((r) => r.kind === 'hidden' || r.kind === 'hidden-header')).toBe(false);
    const open = flattenTree(tree, index, [], undefined, { ...base, filter: 'open', showHidden: true }).rows;
    expect(open.some((r) => r.kind === 'hidden' || r.kind === 'hidden-header')).toBe(false);
  });
});
