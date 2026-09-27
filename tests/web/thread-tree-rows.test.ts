/**
 * Tree drawer rows (spec 6.4 to 6.7): flatten, filters, search, done groups,
 * placeholders and the keyboard movement helpers, over the SAME dense fixture
 * the browser specs load (30 questions, 5 levels, 10 pins).
 */
import { describe, it, expect } from 'vitest';
import { buildThreadTree, ROOT_THREAD_KEY, type ThreadTreeMessage } from '@/utils/thread-tree';
import { counts, indexMeta, openBelow, type ThreadMetaIndex } from '@/utils/thread-meta';
import type { SessionPinnedMessage, SessionThreadAnchor, SessionThreadMeta } from '@/types/session';
import {
  arrowLeft, arrowRight, defaultDrawerFilter, firstMatchRowId, flattenTree, matchRanges, noResultsText,
  stepRowId, survivorAfterRemove, clipPinText, isTypeToSearchKey, ancestorKeysOf,
  type FlattenOptions, type TreeRow,
} from '@/utils/thread-tree-rows';
import { buildDenseSession, DENSE_EXPECTED_COUNTS } from '../e2e/browser/threads-fixture';
import { shouldArmEdge } from '@/hooks/useDrawerEdgePeek';
import { insidePeekRegion } from '@/hooks/useDrawerPeekClose';
import { foldCrumbs, pathItems } from '@/components/sessions/ThreadStackCrumbs';
import { toggleTier } from '@/components/sessions/ThreadDrawerToggle';
import { answeredAgo } from '@/components/sessions/ThreadTreeRows';
import { lazyNameCandidates } from '@/components/sessions/ThreadTreeDrawer';
import { pathToRoot } from '@/utils/thread-tree';

const NOW = Date.parse('2026-09-26T12:00:00Z');

function dense() {
  const s = buildDenseSession(NOW);
  const messages: ThreadTreeMessage[] = s.rows.map((r) => ({ role: r.role, msgId: r.uuid, text: r.text }));
  const tree = buildThreadTree(messages, s.threadAnchors as SessionThreadAnchor[]);
  const index = indexMeta(s.threadMeta as SessionThreadMeta[]);
  const pins = s.pinnedMessages as SessionPinnedMessage[];
  const keyOf = (q: string) => tree.byRow.get(s.ids.head[q])!.key;
  return { s, tree, index, pins, keyOf };
}

const base = (over: Partial<FlattenOptions> = {}): FlattenOptions => ({
  filter: 'all', query: '', collapsed: new Set(), doneGroupsOpen: new Set(), showHidden: false,
  currentKey: ROOT_THREAD_KEY, ...over,
});

const rowOf = (rows: TreeRow[], key: string) => rows.find((r) => r.kind === 'thread' && r.key === key);

describe('flattenTree: All', () => {
  it('starts with Main conversation and nests questions by depth', () => {
    const { tree, index, pins, keyOf } = dense();
    const { rows, filtering } = flattenTree(tree, index, pins, undefined, base());
    expect(filtering).toBe(false);
    expect(rows[0]).toMatchObject({ kind: 'root', title: 'Main conversation', depth: 0 });
    expect(rowOf(rows, keyOf('Q1'))).toMatchObject({ depth: 1, title: 'Buffer flush order', parentRowId: 'root' });
    expect(rowOf(rows, keyOf('Q11'))).toMatchObject({ depth: 2, parentRowId: `t:${keyOf('Q1')}` });
    expect(rowOf(rows, keyOf('Q26'))?.depth).toBe(4);
  });

  it('leaves hidden subtrees and their pins out', () => {
    const { tree, index, pins, keyOf } = dense();
    const { rows } = flattenTree(tree, index, pins, undefined, base());
    for (const q of ['Q8', 'Q18', 'Q23', 'Q27', 'Q30', 'Q29']) expect(rowOf(rows, keyOf(q))).toBeUndefined();
    expect(rows.some((r) => r.pinKey === 'pin-q18')).toBe(false);
    expect(rows.some((r) => r.pinKey === 'pin-q27-q')).toBe(false);
  });

  it('shows pins as single rows under their question, clipped to 80 chars', () => {
    const { tree, index, pins, keyOf } = dense();
    const { rows } = flattenTree(tree, index, pins, undefined, base());
    const pin = rows.find((r) => r.pinKey === 'pin-q1-q')!;
    expect(pin).toMatchObject({ kind: 'pin', key: keyOf('Q1'), depth: 2, parentRowId: `t:${keyOf('Q1')}` });
    expect(pin.title.length).toBeLessThanOrEqual(81);
    expect(pin.tooltip!.length).toBeGreaterThanOrEqual(pin.title.length - 1);
    expect(clipPinText('x'.repeat(100))).toBe(`${'x'.repeat(80)}…`);
  });

  it('folds resolved children into one `<n> done` row per parent', () => {
    const { tree, index, pins, keyOf } = dense();
    const { rows } = flattenTree(tree, index, pins, undefined, base());
    const rootGroup = rows.find((r) => r.id === 'g:')!;
    expect(rootGroup).toMatchObject({ kind: 'done-group', title: '3 done', expanded: false, depth: 1 });
    for (const q of ['Q2', 'Q3', 'Q10', 'Q12']) expect(rowOf(rows, keyOf(q))).toBeUndefined();
    expect(rows.find((r) => r.id === `g:${keyOf('Q1')}`)?.title).toBe('1 done');
  });

  it('opens a group on request and when the current page is inside it', () => {
    const { tree, index, pins, keyOf } = dense();
    const opened = flattenTree(tree, index, pins, undefined, base({ doneGroupsOpen: new Set([ROOT_THREAD_KEY]) })).rows;
    expect(rowOf(opened, keyOf('Q2'))).toBeDefined();
    // Q14 is a resolved child of the resolved Q3: it folds into Q3's own group.
    expect(rowOf(opened, keyOf('Q14'))).toBeUndefined();
    expect(opened.find((r) => r.id === `g:${keyOf('Q3')}`)?.title).toBe('1 done');
    const auto = flattenTree(tree, index, pins, undefined, base({ currentKey: keyOf('Q12') })).rows;
    expect(auto.find((r) => r.id === `g:${keyOf('Q1')}`)?.expanded).toBe(true);
    expect(rowOf(auto, keyOf('Q12'))).toMatchObject({ current: true, status: 'resolved' });
    const deep = flattenTree(tree, index, pins, undefined, base({ currentKey: keyOf('Q14') })).rows;
    expect(rowOf(deep, keyOf('Q14'))?.current).toBe(true);
  });
});

describe('flattenTree: filters and search', () => {
  it('Open lists open and suggested questions with faded ancestors, all expanded', () => {
    const { tree, index, pins, keyOf } = dense();
    const res = flattenTree(tree, index, pins, undefined, base({ filter: 'open', collapsed: new Set([keyOf('Q1')]) }));
    expect(res.filtering).toBe(true);
    const threads = res.rows.filter((r) => r.kind === 'thread');
    for (const r of threads) {
      if (r.matched) expect(['open', 'suggested']).toContain(r.status);
      else expect(r.ancestorOnly).toBe(true);
      expect(r.disclosureDisabled).toBe(true);
    }
    expect(threads.filter((r) => r.matched)).toHaveLength(DENSE_EXPECTED_COUNTS.open + DENSE_EXPECTED_COUNTS.suggested);
    expect(res.rows.some((r) => r.kind === 'pin' || r.kind === 'done-group')).toBe(false);
    // A collapsed parent is expanded while filtering.
    expect(rowOf(res.rows, keyOf('Q11'))).toBeDefined();
  });

  it('Open counts queued, answering and failed questions as open', () => {
    const { tree, index, pins, keyOf } = dense();
    const live = new Map([[keyOf('Q1'), 'answering' as const], [keyOf('Q5'), 'failed' as const]]);
    const rows = flattenTree(tree, index, pins, live, base({ filter: 'open' })).rows;
    expect(rowOf(rows, keyOf('Q1'))).toMatchObject({ status: 'answering', secondary: 'Answering…', matched: true });
    expect(rowOf(rows, keyOf('Q5'))).toMatchObject({ status: 'failed', secondary: 'No answer · Retry' });
  });

  it('Pinned lists pins with their question chain', () => {
    const { tree, index, pins } = dense();
    const res = flattenTree(tree, index, pins, undefined, base({ filter: 'pinned' }));
    expect(res.rows.filter((r) => r.kind === 'pin')).toHaveLength(DENSE_EXPECTED_COUNTS.pinned);
    expect(res.rows.filter((r) => r.kind === 'thread').every((r) => r.ancestorOnly)).toBe(true);
    expect(res.matchCount).toBe(DENSE_EXPECTED_COUNTS.pinned);
  });

  it('search matches title, question, passage, takeaway and pin text; bold ranges on the shown text', () => {
    const { tree, index, pins, keyOf } = dense();
    const byTitle = flattenTree(tree, index, pins, undefined, base({ query: 'flush ORDER' })).rows;
    const q1 = rowOf(byTitle, keyOf('Q1'))!;
    expect(q1.matched).toBe(true);
    expect(q1.titleMatches).toEqual([[7, 18]]);
    const byQuestion = flattenTree(tree, index, pins, undefined, base({ query: 'point 22 change' })).rows;
    expect(rowOf(byQuestion, keyOf('Q22'))?.matched).toBe(true);
    const byTakeaway = flattenTree(tree, index, pins, undefined, base({ query: 'Point 14 keeps reads' })).rows;
    // Searching never folds done rows: the resolved Q14 shows under its resolved parent.
    expect(rowOf(byTakeaway, keyOf('Q14'))?.matched).toBe(true);
    expect(rowOf(byTakeaway, keyOf('Q3'))?.ancestorOnly).toBe(true);
    expect(byTakeaway.some((r) => r.kind === 'done-group')).toBe(false);
  });

  it('search is case and full/half width insensitive', () => {
    const { tree, index, pins, keyOf } = dense();
    const rows = flattenTree(tree, index, pins, undefined, base({ query: 'Ｂｕｆｆｅｒ flush' })).rows;
    expect(rowOf(rows, keyOf('Q1'))?.matched).toBe(true);
  });

  it('a search with no match reports no results', () => {
    const { tree, index, pins } = dense();
    const res = flattenTree(tree, index, pins, undefined, base({ query: 'zebra crossing' }));
    expect(res.noResults).toBe(true);
    expect(res.matchCount).toBe(0);
    expect(noResultsText('zebra crossing')).toBe('No questions match “zebra crossing”.');
  });

  it('chip counts come from counts() and ignore the search', () => {
    const { tree, index, pins } = dense();
    const c = counts(tree, index, pins);
    expect(c).toMatchObject(DENSE_EXPECTED_COUNTS);
    expect(defaultDrawerFilter(c)).toBe('open');
    expect(defaultDrawerFilter({ ...c, open: 0, suggested: 0 })).toBe('all');
  });

  it('matchRanges finds every occurrence and skips length-changing normalization', () => {
    expect(matchRanges('Ab ab AB', 'ab')).toEqual([[0, 2], [3, 5], [6, 8]]);
    expect(matchRanges('x', '')).toEqual([]);
  });
});

describe('flattenTree: in-drawer state', () => {
  it('keeps a question resolved in the drawer in place (settled) under Open and All', () => {
    const { tree, index, pins, keyOf, s } = dense();
    const q1 = keyOf('Q1');
    const resolved = new Map(index) as ThreadMetaIndex;
    resolved.set(s.ids.head.Q1, { ...index.get(s.ids.head.Q1)!, status: 'resolved' });
    const sticky = new Set([q1]);
    const open = flattenTree(tree, resolved, pins, undefined, base({ filter: 'open', sticky })).rows;
    expect(rowOf(open, q1)).toMatchObject({ status: 'resolved', settled: true, matched: true });
    const all = flattenTree(tree, resolved, pins, undefined, base({ sticky })).rows;
    expect(rowOf(all, q1)?.settled).toBe(true);
    const gone = flattenTree(tree, resolved, pins, undefined, base({ filter: 'open' })).rows;
    expect(rowOf(gone, q1)?.matched).toBe(false);
  });

  it('puts a `Removed` placeholder where a removed question or pin was', () => {
    const { tree, index, pins, keyOf, s } = dense();
    const q5 = keyOf('Q5');
    const removed = new Map(index) as ThreadMetaIndex;
    removed.set(s.ids.head.Q5, { ...index.get(s.ids.head.Q5)!, hidden: true });
    const before = flattenTree(tree, index, pins, undefined, base()).rows;
    const at = before.findIndex((r) => r.key === q5 && r.kind === 'thread');
    const after = flattenTree(tree, removed, pins.filter((p) => p.id !== 'pin-q1-q'), undefined, base({
      removedThreads: new Set([q5]), removedPins: [{ pinKey: 'pin-q1-q', threadKey: keyOf('Q1') }],
    })).rows;
    const ph = after.find((r) => r.id === `removed:t:${q5}`)!;
    expect(ph).toMatchObject({ kind: 'removed', removedOf: 'thread', depth: 1 });
    // Everything before the removed row keeps its index: nothing above it moves.
    expect(after.slice(0, at).map((r) => r.id).filter((id) => !id.startsWith('removed:'))).toEqual(
      before.slice(0, at).map((r) => r.id).filter((id) => id !== 'p:pin-q1-q'),
    );
    expect(after.some((r) => r.id === 'removed:p:pin-q1-q')).toBe(true);
    expect(rowOf(after, keyOf('Q15'))).toBeUndefined();
  });

  it('lists the pending page and drafts as `New question` rows under their parent', () => {
    const { tree, index, pins, keyOf } = dense();
    const q1 = keyOf('Q1');
    const rows = flattenTree(tree, index, pins, undefined, base({
      pending: { pageKey: 'pending:a:1', parentKey: q1, parentMsgId: 'a', title: 'x' },
      drafts: [{ pageKey: 'pending:b:2', parentKey: ROOT_THREAD_KEY, label: 'New question (draft)' }],
      currentKey: 'pending:a:1',
    })).rows;
    expect(rows.find((r) => r.kind === 'pending')).toMatchObject({ title: 'New question', parentRowId: `t:${q1}`, current: true });
    expect(rows.find((r) => r.kind === 'draft')).toMatchObject({ title: 'New question (draft)', parentRowId: 'root' });
  });

  it('shows the Hidden group only when asked, one row per hidden head', () => {
    const { tree, index, pins, keyOf } = dense();
    expect(flattenTree(tree, index, pins, undefined, base()).rows.some((r) => r.kind === 'hidden')).toBe(false);
    const rows = flattenTree(tree, index, pins, undefined, base({ showHidden: true })).rows;
    expect(rows.find((r) => r.kind === 'hidden-header')?.title).toBe('Hidden');
    expect(rows.filter((r) => r.kind === 'hidden').map((r) => r.key).sort())
      .toEqual([keyOf('Q8'), keyOf('Q23'), keyOf('Q29')].sort());
  });

  it('row pills equal openBelow() for every visible question', () => {
    const { tree, index, pins } = dense();
    for (const r of flattenTree(tree, index, pins, undefined, base({ doneGroupsOpen: new Set(tree.threads.map((t) => t.key)) })).rows) {
      if (r.kind === 'thread' || r.kind === 'root') expect(r.openBelow).toBe(openBelow(tree, r.key, index));
    }
  });

  it('only rows with visible children get a disclosure', () => {
    const { tree, index, pins, keyOf } = dense();
    const rows = flattenTree(tree, index, pins, undefined, base()).rows;
    expect(rowOf(rows, keyOf('Q1'))?.hasChildren).toBe(true);
    expect(rowOf(rows, keyOf('Q22'))?.hasChildren).toBe(false);
    // Q15's only child (Q23) is hidden and Q15 holds no pin.
    expect(rowOf(rows, keyOf('Q15'))?.hasChildren).toBe(false);
  });
});

describe('keyboard movement (spec 6.7)', () => {
  it('ArrowDown / ArrowUp step over navigable rows; ArrowUp on the first row returns null (search box)', () => {
    const { tree, index, pins } = dense();
    const rows = flattenTree(tree, index, pins, undefined, base()).rows;
    expect(stepRowId(rows, 'root', -1)).toBeNull();
    expect(stepRowId(rows, 'root', 1)).toBe(rows[1].id);
    expect(stepRowId(rows, rows[rows.length - 1].id, 1)).toBe(rows[rows.length - 1].id);
    expect(stepRowId(rows, 'nope', 1)).toBe('root');
  });

  it('ArrowRight expands a collapsed row, then moves to its first child', () => {
    const { tree, index, pins, keyOf } = dense();
    const q1 = keyOf('Q1');
    const collapsed = flattenTree(tree, index, pins, undefined, base({ collapsed: new Set([q1]) })).rows;
    expect(arrowRight(collapsed, `t:${q1}`)).toMatchObject({ type: 'expand' });
    const open = flattenTree(tree, index, pins, undefined, base()).rows;
    const r = arrowRight(open, `t:${q1}`);
    expect(r).toEqual({ type: 'move', id: open[open.findIndex((x) => x.id === `t:${q1}`) + 1].id });
    expect(arrowRight(open, `t:${keyOf('Q22')}`)).toEqual({ type: 'none' });
  });

  it('ArrowLeft collapses an expanded row, else moves to the parent', () => {
    const { tree, index, pins, keyOf } = dense();
    const rows = flattenTree(tree, index, pins, undefined, base()).rows;
    expect(arrowLeft(rows, `t:${keyOf('Q1')}`)).toMatchObject({ type: 'collapse' });
    expect(arrowLeft(rows, `t:${keyOf('Q22')}`)).toEqual({ type: 'move', id: `t:${keyOf('Q11')}` });
    const filtered = flattenTree(tree, index, pins, undefined, base({ filter: 'open' })).rows;
    // Filtering disables the disclosure: Left goes to the parent instead of collapsing.
    expect(arrowLeft(filtered, `t:${keyOf('Q1')}`)).toEqual({ type: 'move', id: 'root' });
  });

  it('after a remove the cursor takes the next sibling, else the previous one, else the parent', () => {
    const { tree, index, pins, keyOf } = dense();
    const rows = flattenTree(tree, index, pins, undefined, base()).rows;
    expect(survivorAfterRemove(rows, `t:${keyOf('Q21')}`)).toBe(`t:${keyOf('Q22')}`);
    expect(survivorAfterRemove(rows, `t:${keyOf('Q22')}`)).toBe(`t:${keyOf('Q21')}`);
    expect(survivorAfterRemove(rows, `t:${keyOf('Q22')}`, new Set([`t:${keyOf('Q21')}`]))).not.toBe(`t:${keyOf('Q21')}`);
    expect(survivorAfterRemove(rows, `t:${keyOf('Q24')}`)).toBe(`t:${keyOf('Q17')}`);
  });

  it('Enter in the search opens the first real match, not an ancestor', () => {
    const { tree, index, pins, keyOf } = dense();
    const rows = flattenTree(tree, index, pins, undefined, base({ query: 'point 26 change' })).rows;
    expect(firstMatchRowId(rows)).toBe(`t:${keyOf('Q26')}`);
  });

  it('type-to-search takes printable keys without Cmd / Ctrl / Alt', () => {
    const k = (key: string, mods: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean }> = {}) =>
      ({ key, metaKey: false, ctrlKey: false, altKey: false, ...mods });
    expect(isTypeToSearchKey(k('a'))).toBe(true);
    expect(isTypeToSearchKey(k('A'))).toBe(true);
    expect(isTypeToSearchKey(k('a', { metaKey: true }))).toBe(false);
    expect(isTypeToSearchKey(k('e', { ctrlKey: true }))).toBe(false);
    expect(isTypeToSearchKey(k(' '))).toBe(false);
    expect(isTypeToSearchKey(k('ArrowDown'))).toBe(false);
  });

  it('ancestorKeysOf lists every ancestor through root', () => {
    const { tree, keyOf } = dense();
    expect(ancestorKeysOf(tree, keyOf('Q21'))).toEqual([ROOT_THREAD_KEY, keyOf('Q1'), keyOf('Q11')]);
  });
});

describe('performance (C38)', () => {
  function synthetic(n: number) {
    const messages: ThreadTreeMessage[] = [];
    const anchors: SessionThreadAnchor[] = [];
    const answerOf: string[] = [];
    for (let r = 0; r < 20; r++) {
      messages.push({ role: 'user', msgId: `ru${r}`, text: `root ${r}` }, { role: 'assistant', msgId: `ra${r}`, text: `answer ${r}` });
    }
    for (let i = 0; i < n; i++) {
      const parent = i < 40 ? `ra${i % 20}` : answerOf[Math.floor(i / 3)];
      messages.push({ role: 'user', msgId: `qu${i}`, text: `> passage ${i}\n\nquestion ${i} about lantern ${i % 7}` },
        { role: 'assistant', msgId: `qa${i}`, text: `reply ${i}` });
      answerOf.push(`qa${i}`);
      anchors.push({ msgId: `qu${i}`, parent, quote: { exact: `passage ${i}` }, source: 'selection', at: '2026-09-26T00:00:00Z' });
    }
    const tree = buildThreadTree(messages, anchors);
    const meta: SessionThreadMeta[] = tree.threads.filter((t) => t.key !== ROOT_THREAD_KEY).map((t, i) => ({
      headId: t.headId, status: i % 3 === 0 ? 'resolved' : 'open', title: `Title ${i} kettle`, question: `question ${i}`,
      updatedAt: '2026-09-26T00:00:00Z',
    }));
    return { tree, index: indexMeta(meta) };
  }

  it('flattens and searches 500 questions in under a frame', () => {
    const { tree, index } = synthetic(500);
    expect(tree.threads.length).toBeGreaterThan(500);
    // Each keystroke's BEST of five runs: a busy machine only makes some runs
    // slower (a median failed at 47ms under load 400), while real extra work, an
    // accidental O(n^2), makes every run slower, the best one included.
    const best: number[] = [];
    for (const query of ['', 'k', 'ke', 'ket', 'kettle 4', 'lantern 3']) {
      let fastest = Infinity;
      for (let run = 0; run < 5; run++) {
        const t0 = performance.now();
        flattenTree(tree, index, [], undefined, base({ query }));
        fastest = Math.min(fastest, performance.now() - t0);
      }
      best.push(fastest);
    }
    expect(Math.max(...best)).toBeLessThan(16);
  });
});

describe('drawer and stack chrome rules', () => {
  const panel = { left: 400, top: 0, right: 900, bottom: 800 };
  const band = { left: 400, top: 0, right: 408, bottom: 800 };
  const arm = (prev: { x: number; y: number } | null, extra: Partial<Parameters<typeof shouldArmEdge>[0]> = {}) =>
    shouldArmEdge({ prev, now: { x: 403, y: 300 }, panel, band, buttons: 0, selectionPill: false, ...extra });

  it('the edge arms only on an entry from this panel content (C63)', () => {
    expect(arm({ x: 520, y: 300 })).toBe(true);
    expect(arm({ x: 380, y: 300 })).toBe(false);
    expect(arm(null)).toBe(false);
    expect(arm({ x: 520, y: 300 }, { buttons: 1 })).toBe(false);
    expect(arm({ x: 520, y: 300 }, { selectionPill: true })).toBe(false);
    expect(arm({ x: 520, y: 300 }, { rail: { left: 400, top: 200, right: 430, bottom: 500 } })).toBe(false);
  });

  it('peek stays open inside [panel.left - 40, drawer.right + 18] x [top - 18, bottom + 18] (C28)', () => {
    const r = { panelLeft: 400, drawer: { top: 50, right: 706, bottom: 750 } };
    expect(insidePeekRegion(365, 100, r)).toBe(true);
    expect(insidePeekRegion(355, 100, r)).toBe(false);
    expect(insidePeekRegion(720, 100, r)).toBe(true);
    expect(insidePeekRegion(730, 100, r)).toBe(false);
    expect(insidePeekRegion(500, 33, r)).toBe(true);
    expect(insidePeekRegion(500, 770, r)).toBe(false);
  });

  it('the path folds its middle under 720px or past 3 segments (C22)', () => {
    const items = ['Main', 'a', 'b', 'c'].map((label, i) => ({ key: String(i), label }));
    expect(foldCrumbs(items.slice(0, 3), 900).folded).toEqual([]);
    expect(foldCrumbs(items.slice(0, 3), 700).folded.map((i) => i.label)).toEqual(['a']);
    expect(foldCrumbs(items, 1400).shown.map((i) => i.label)).toEqual(['Main', 'c']);
    expect(foldCrumbs(items.slice(0, 2), 500).folded).toEqual([]);
  });

  it('path items name root Main and exclude the page itself (C21)', () => {
    const { tree, index, keyOf } = dense();
    const items = pathItems(pathToRoot(tree, keyOf('Q21')), index);
    expect(items.map((i) => i.label)).toEqual(['Main', 'Buffer flush order', expect.stringMatching(/^Point 11:/)]);
  });

  it('the toggle width tier never changes between `1 open` and `All done` (C75)', () => {
    const c = { open: 1, suggested: 0, done: 3, older: 0, all: 4, pinned: 0 };
    expect(toggleTier(c, false)).toBe('base');
    expect(toggleTier({ ...c, open: 0 }, false)).toBe('base');
    expect(toggleTier({ ...c, suggested: 2 }, false)).toBe('answered');
    // N47: narrow shows `<n> open` while any is open, in the base width; only
    // `<n> to check` takes the wider narrow slot.
    expect(toggleTier({ ...c, suggested: 2 }, true)).toBe('base');
    expect(toggleTier({ ...c, open: 0, suggested: 2 }, true)).toBe('narrow-answered');
  });

  it('unread tooltips read `Answered <relative time>`', () => {
    const now = Date.parse('2026-09-26T12:00:00Z');
    expect(answeredAgo(now - 12 * 60_000, now)).toBe('Answered 12 min ago');
    expect(answeredAgo(now - 3 * 3_600_000, now)).toBe('Answered 3 h ago');
    expect(answeredAgo(now - 5_000, now)).toBe('Answered just now');
    expect(answeredAgo(undefined, now)).toBeUndefined();
  });

  it('lazy naming asks for up to 10 visible questions without meta, as older + pending (C56)', () => {
    const { tree, index } = dense();
    const c = lazyNameCandidates(tree, index);
    expect(c).toHaveLength(5);
    for (const e of c) expect(e).toMatchObject({ status: 'older', titleState: 'pending' });
    expect(lazyNameCandidates(tree, index, 2)).toHaveLength(2);
  });
});
