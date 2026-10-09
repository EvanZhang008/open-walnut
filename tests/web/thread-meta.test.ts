/**
 * Per-question meta (web/src/utils/thread-meta.ts + thread-meta-counts.ts).
 *
 * The counts case runs on the SAME dense fixture the browser specs load, so the
 * header, the drawer summary and the chips (which all read `counts`) are pinned
 * to one set of numbers (C72). The adoption cases are the two measured stale-GET
 * shapes: an older GET landing after a Done (C15), and a server-pruned entry that
 * must not block adoption forever (C84).
 */
import { describe, it, expect } from 'vitest';
import { buildThreadTree, ROOT_THREAD_KEY, threadKeyOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import {
  counts, deriveThreadLiveStates, descendantsOf, displayTitleOf, fallbackTakeaway, fallbackTitle, hiddenKeysOf,
  indexMeta, mergeMetaPatch, normalizeForSearch, openBelow, shouldAdoptServerMeta, statusOf, summaryText,
  toggleLabel, viewStatusOf, TAKEAWAY_PREAMBLE_PATTERNS, META_PRUNE_AGE_MS, NAMING_TIMEOUT_MS, pluralFollowUps,
} from '@/utils/thread-meta';
import { chipCounts, openChipTitle, toggleTitle } from '@/utils/thread-meta-counts';
import type { SessionThreadMeta } from '@/types/session';
import {
  buildDenseSession, DENSE_EXPECTED_COUNTS, DENSE_PREAMBLE_QUESTION, DENSE_PREAMBLE_TAKEAWAY, densePassage,
} from '../e2e/browser/threads-fixture';

const NOW = Date.parse('2026-09-26T12:00:00Z');

function dense() {
  const s = buildDenseSession(NOW);
  const messages: ThreadTreeMessage[] = s.rows.map((r) => ({ role: r.role, msgId: r.uuid, text: r.text }));
  const tree = buildThreadTree(messages, s.threadAnchors);
  const index = indexMeta(s.threadMeta as SessionThreadMeta[]);
  const keyOf = (q: string) => tree.byRow.get(s.ids.head[q])!.key;
  return { s, tree, index, keyOf, messages };
}

const meta = (headId: string, status: SessionThreadMeta['status'], updatedAt: string, extra: Partial<SessionThreadMeta> = {}): SessionThreadMeta =>
  ({ headId, status, updatedAt, ...extra });

describe('dense fixture shape', () => {
  it('has 30 questions over 5 levels', () => {
    const { tree } = dense();
    const questions = tree.threads.filter((t) => t.key !== ROOT_THREAD_KEY);
    expect(questions).toHaveLength(30);
    expect(Math.max(...questions.map((t) => t.depth))).toBe(5);
  });
});

describe('counts (the one count function, spec 7.3)', () => {
  it('matches the dense fixture expectation exactly (C72)', () => {
    const { s, tree, index } = dense();
    expect(counts(tree, index, s.pinnedMessages)).toEqual(DENSE_EXPECTED_COUNTS);
  });

  it('header, summary and chips read the same numbers', () => {
    const { s, tree, index } = dense();
    const c = counts(tree, index, s.pinnedMessages);
    expect(toggleLabel(c)).toBe(`${c.open} open · ${c.suggested} to check`);
    expect(toggleLabel(c, { narrow: true })).toBe(`${c.open} open`);
    expect(toggleLabel({ ...c, open: 0 }, { narrow: true })).toBe(`${c.suggested} to check`);
    // N29: the tooltip is the spec text; only a narrow label that dropped a count leads with the full text.
    expect(toggleTitle(c, { mac: true })).toBe('All questions (Cmd+Shift+E)');
    expect(toggleTitle(c, { mac: true, narrow: true })).toBe(`${c.open} open · ${c.suggested} to check. All questions (Cmd+Shift+E)`);
    expect(summaryText(c)).toBe(`${c.open} open · ${c.suggested} to check · ${c.done} archived · ${c.pinned} pinned`);
    // N43: the Open chip counts the same `open` as the toggle and the summary;
    // its tooltip names both numbers.
    expect(chipCounts(c)).toEqual({ all: c.all, open: c.open, pinned: c.pinned });
    expect(openChipTitle(c)).toBe(`${c.open} open, ${c.suggested} to check`);
    expect(openChipTitle({ ...c, suggested: 0 })).toBeUndefined();
  });

  it('pins inside hidden questions are not counted; pending rows never exist in the tree', () => {
    const { s, tree, index } = dense();
    const c = counts(tree, index, s.pinnedMessages);
    expect(s.pinnedMessages).toHaveLength(10);
    expect(c.pinned).toBe(8);
  });

  it('older is never open, and a live state does not move buckets', () => {
    const { s, tree, index, keyOf } = dense();
    const live = new Map([[keyOf('Q4'), 'answering' as const], [keyOf('Q1'), 'failed' as const]]);
    const c = counts(tree, index, s.pinnedMessages, live);
    expect(c).toEqual(DENSE_EXPECTED_COUNTS);
    expect(statusOf(tree.byKey.get(keyOf('Q4')), index)).toBe('older');
  });

  it('labels: None open, zero segments omitted, shortcut spelled out', () => {
    const zero = { open: 0, suggested: 0, done: 3, older: 1, all: 4, pinned: 0 };
    expect(toggleLabel(zero)).toBe('None open');
    expect(summaryText(zero)).toBe('3 archived');
    expect(toggleLabel({ ...zero, open: 2 })).toBe('2 open');
    expect(toggleTitle(zero, { mac: true })).toBe('All questions (Cmd+Shift+E)');
    expect(toggleTitle(zero, { mac: false })).toBe('All questions (Ctrl+Shift+E)');
    expect(pluralFollowUps(1)).toBe('1 follow-up');
    expect(pluralFollowUps(3)).toBe('3 follow-ups');
  });
});

describe('hidden subtree (derived, one field)', () => {
  it('a hidden head hides its whole subtree; its children are never written hidden', () => {
    const { s, tree, index, keyOf } = dense();
    const hidden = hiddenKeysOf(tree, index);
    for (const q of ['Q8', 'Q18', 'Q23', 'Q27', 'Q30', 'Q29']) expect(hidden.has(keyOf(q))).toBe(true);
    expect(hidden.size).toBe(6);
    const q27 = s.threadMeta.find((m) => m.headId === s.ids.head.Q27)!;
    expect(q27.hidden).toBeUndefined();
    expect(hidden.has(ROOT_THREAD_KEY)).toBe(false);
  });

  it('descendants: visibleOnly drops hidden subtrees; openBelow counts open + suggested', () => {
    const { tree, index, keyOf } = dense();
    expect(descendantsOf(tree, keyOf('Q5')).length).toBe(5);
    expect(descendantsOf(tree, keyOf('Q5'), { visibleOnly: true, index }).length).toBe(2);
    expect(openBelow(tree, keyOf('Q5'), index)).toBe(1);
    expect(openBelow(tree, keyOf('Q6'), index)).toBe(3);
  });
});

describe('mergeMetaPatch (client mirror of the server upsert)', () => {
  const base = [meta('h1', 'open', '2026-09-26T10:00:00.000Z', { title: 'Alpha', titleSource: 'ai' }), meta('h2', 'older', '2026-09-26T10:00:00.000Z')];
  it('listed fields overwrite, null clears, unlisted entries and fields stay', () => {
    const out = mergeMetaPatch(base, [{ headId: 'h1', status: 'resolved', title: null }], '2026-09-26T11:00:00.000Z');
    expect(out[0]).toEqual({ headId: 'h1', status: 'resolved', titleSource: 'ai', updatedAt: '2026-09-26T11:00:00.000Z' });
    expect(out[1]).toBe(base[1]);
  });
  it('a new entry is appended, defaults to older and is capped', () => {
    const out = mergeMetaPatch(base, [{ headId: 'h3', hidden: true, title: 'x'.repeat(200) }], '2026-09-26T11:00:00.000Z');
    expect(out).toHaveLength(3);
    expect(out[2].status).toBe('older');
    expect(out[2].title).toHaveLength(120);
  });
});

describe('shouldAdoptServerMeta', () => {
  const T1 = '2026-09-26T11:00:00.000Z';
  const T2 = '2026-09-26T11:00:05.000Z';
  const confirmed = [meta('h1', 'resolved', T2), meta('h2', 'open', T1)];
  const nowMs = Date.parse(T2) + 1000;
  it('without a local write, always adopts', () => {
    expect(shouldAdoptServerMeta([], confirmed, false, [], nowMs)).toBe(true);
  });
  it('an OLDER GET landing after the Done PATCH is ignored (C15)', () => {
    const staleGet = [meta('h1', 'open', T1), meta('h2', 'open', T1)];
    expect(shouldAdoptServerMeta(staleGet, confirmed, true, [{ msgId: 'h1' }, { msgId: 'h2' }], nowMs)).toBe(false);
  });
  it('a newer list, or one with another device\'s new entry, is adopted', () => {
    const newer = [meta('h1', 'resolved', T2, { title: 'AI name' }), meta('h2', 'open', T1), meta('h9', 'open', T2)];
    expect(shouldAdoptServerMeta(newer, confirmed, true, [], nowMs)).toBe(true);
  });
  it('a fresh entry missing from the server blocks adoption (stale GET before the write)', () => {
    expect(shouldAdoptServerMeta([meta('h1', 'resolved', T2)], confirmed, true, [{ msgId: 'h1' }], nowMs)).toBe(false);
  });
  it('a PRUNED entry (no anchor, older than the prune age) does not block adoption (C84)', () => {
    const later = Date.parse(T1) + META_PRUNE_AGE_MS + 1;
    const server = [meta('h1', 'resolved', T2), meta('h7', 'open', T2)];
    expect(shouldAdoptServerMeta(server, confirmed, true, [{ msgId: 'h1' }, { msgId: 'h7' }], later)).toBe(true);
    // Its anchor is still there: not pruned, so the list is behind ours.
    expect(shouldAdoptServerMeta(server, confirmed, true, [{ msgId: 'h1' }, { msgId: 'h2' }], later)).toBe(false);
  });
});

describe('titles', () => {
  it('fallbackTitle: passage first line, word boundary at 48 chars, then the question, then Untitled', () => {
    expect(fallbackTitle('Short passage')).toBe('Short passage');
    const long = 'The compaction step merges many small pages into one larger page every minute';
    const t = fallbackTitle(long);
    expect(t.endsWith('…')).toBe(true);
    expect(t.length).toBeLessThanOrEqual(49);
    expect(long.startsWith(t.slice(0, -1))).toBe(true);
    expect(fallbackTitle(undefined, '\nWhy is the flush late?\nmore')).toBe('Why is the flush late?');
    expect(fallbackTitle('', '')).toBe('Untitled question');
  });

  it('displayTitleOf: meta title wins, Naming stops 90s after the first answer', () => {
    const { tree, index, keyOf } = dense();
    expect(displayTitleOf(tree.byKey.get(keyOf('Q1')), index).title).toBe('Buffer flush order');
    expect(displayTitleOf(tree.byKey.get(keyOf('Q4')), index).title).toBe(fallbackTitle(densePassage('Q4')));
    expect(displayTitleOf(tree.byKey.get(ROOT_THREAD_KEY), index).title).toBe('Main conversation');
    const node = tree.byKey.get(keyOf('Q11'))!;
    const pending = indexMeta([meta(node.headId, 'open', 'x', { titleState: 'pending' })]);
    expect(displayTitleOf(node, pending, { nowMs: 1000, firstAnswerAtMs: 0 }).naming).toBe(true);
    expect(displayTitleOf(node, pending, { nowMs: NAMING_TIMEOUT_MS + 1, firstAnswerAtMs: 0 }).naming).toBe(false);
    // N2: without an answer time the entry's last write starts the clock, so a
    // lost name job stops saying Naming after 90s instead of forever.
    const staleAt = Date.parse('2026-01-01T00:00:00.000Z');
    const stale = indexMeta([{ ...meta(node.headId, 'open', 'x', { titleState: 'pending' }), updatedAt: new Date(staleAt).toISOString() }]);
    expect(displayTitleOf(node, stale, { nowMs: staleAt + 5_000 }).naming).toBe(true);
    expect(displayTitleOf(node, stale, { nowMs: staleAt + NAMING_TIMEOUT_MS + 1 }).naming).toBe(false);
    const user = indexMeta([meta(node.headId, 'open', 'x', { titleState: 'pending', titleSource: 'user', title: 'Mine' })]);
    expect(displayTitleOf(node, user)).toEqual({ title: 'Mine', naming: false });
  });
});

describe('fallbackTakeaway (spec 7.5)', () => {
  it('skips the preamble sentence of the dense fixture answer', () => {
    const { s } = dense();
    const answer = s.rows[s.rows.findIndex((r) => r.uuid === s.ids.head[DENSE_PREAMBLE_QUESTION]) + 1].text;
    expect(answer.startsWith('Good question.')).toBe(true);
    expect(fallbackTakeaway(answer)).toBe(DENSE_PREAMBLE_TAKEAWAY);
  });
  it('reads the LAST paragraph, skips short sentences, strips markdown and caps at 160', () => {
    const md = 'First paragraph is ignored here entirely.\n\nOK. **Short** one. The last paragraph carries the real finding about `flush` order today.';
    expect(fallbackTakeaway(md)).toBe('The last paragraph carries the real finding about flush order today.');
    const long = `Sure, ${'word '.repeat(60)}end.`;
    expect(fallbackTakeaway(long).length).toBeLessThanOrEqual(160);
    expect(fallbackTakeaway('Tiny. Also tiny.')).toBe('Tiny.');
    expect(fallbackTakeaway('')).toBe('');
  });
  it('the preamble table covers every listed opener', () => {
    for (const s of ['Good question, really', 'great question here', 'Short answer: yes', 'Sure, fine', "I'll check", 'Let me see', 'OK, then']) {
      expect(TAKEAWAY_PREAMBLE_PATTERNS.some((re) => re.test(s)), s).toBe(true);
    }
  });
});

describe('live states (queued / answering / failed)', () => {
  it('answering beats queued beats failed; root never gets one', () => {
    const { tree, keyOf, s } = dense();
    const q1Last = tree.byKey.get(keyOf('Q1'))!.turnIds.at(-1)!;
    const live = deriveThreadLiveStates({
      tree,
      queued: [{ rowId: s.ids.head.Q2, status: 'pending' }, { rowId: s.ids.head.Q3, status: 'processing' }],
      streamingKey: keyOf('Q5'),
      turnEnds: new Map([[q1Last, 'error' as const], [s.ids.head.Q2, 'error' as const], [s.ids.head.Q6, 'interrupted' as const]]),
      hasAnswerAfter: (id) => id === s.ids.head.Q6,
    });
    expect(live.get(keyOf('Q1'))).toBe('failed');
    expect(live.get(keyOf('Q2'))).toBe('queued');
    expect(live.get(keyOf('Q3'))).toBe('answering');
    expect(live.get(keyOf('Q5'))).toBe('answering');
    expect(live.has(keyOf('Q6'))).toBe(false);
    expect(live.has(ROOT_THREAD_KEY)).toBe(false);
  });
  it('viewStatusOf overlays a live state on anything but resolved', () => {
    const { tree, index, keyOf } = dense();
    const live = new Map([[keyOf('Q1'), 'answering' as const], [keyOf('Q2'), 'queued' as const]]);
    expect(viewStatusOf(tree.byKey.get(keyOf('Q1'))!, index, live)).toBe('answering');
    expect(viewStatusOf(tree.byKey.get(keyOf('Q2'))!, index, live)).toBe('resolved');
  });
});

describe('normalizeForSearch', () => {
  it('folds case and full / half width (test data as escapes)', () => {
    expect(normalizeForSearch('\uFF26\uFF4C\uFF55\uFF53\uFF48 Order')).toBe('flush order');
    expect(threadKeyOf({ parent: 'p' })).not.toBe(ROOT_THREAD_KEY);
  });
});
