/**
 * The conversation-thread model (web/src/utils/thread-tree.ts).
 *
 * Every case here is a rule the three B-mode surfaces (rail indentation, gutter
 * bar, composer chip) read straight off this structure, so a drift shows up as a
 * mis-coloured or mis-indented transcript rather than an exception. The dangling
 * case is the important one: the transcript is a tail window, so an anchor
 * pointing outside it is normal and must be invisible, never an error.
 */
import { describe, it, expect } from 'vitest';
import {
  ROOT_THREAD_KEY, THREAD_HUES, buildThreadTree, composeAnchoredText, hueForAnchor,
  pathToRoot, quoteBlockOf, siblingsOf, threadKeyOf, withPendingUserRows,
  composeOrientedText, findSamePassageThread, normalizePassage, BACK_TO_MAIN_LINE,
  FILE_ABOUT_LINE_RE, fileAboutLineOf, fileOfParent, fileParentOf, shortenFileAboutLine,
} from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';
import type { ThreadTreeMessage } from '@/utils/thread-tree';

const user = (msgId: string, text = `q ${msgId}`): ThreadTreeMessage =>
  ({ role: 'user', msgId, text });
const reply = (msgId: string, text = `a ${msgId}`): ThreadTreeMessage =>
  ({ role: 'assistant', msgId, text });

const anchor = (
  msgId: string, parent: string, extra: Partial<SessionThreadAnchor> = {},
): SessionThreadAnchor => ({ msgId, parent, source: 'selection', at: '2026-09-03T10:00:00Z', ...extra });

describe('threadKeyOf', () => {
  it('keys on the reply plus the anchored passage', () => {
    expect(threadKeyOf({ parent: 'r1' })).toBe(threadKeyOf({ parent: 'r1' }));
    // Two passages of ONE reply are two different threads.
    expect(threadKeyOf({ parent: 'r1', quote: { exact: 'first' } }))
      .not.toBe(threadKeyOf({ parent: 'r1', quote: { exact: 'second' } }));
    // A whole-reply thread is not the same thread as any passage inside it.
    expect(threadKeyOf({ parent: 'r1' }))
      .not.toBe(threadKeyOf({ parent: 'r1', quote: { exact: 'first' } }));
    // No real key can collide with the root thread.
    expect(threadKeyOf({ parent: 'r1' })).not.toBe(ROOT_THREAD_KEY);
  });
});

describe('buildThreadTree — no anchors', () => {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2')];

  // The common case pays nothing: no anchors ⇒ the ONE shared empty tree, with no
  // per-row walk at all. Consumers treat a row missing from byRow as root at
  // depth 0, so "everything is top level" is expressed by absence, not by entries.
  it('returns the shared empty tree: root only, no per-row entries, stable identity', () => {
    const tree = buildThreadTree(messages, []);
    expect(tree.threads).toHaveLength(1);
    expect(tree.threads[0].key).toBe(ROOT_THREAD_KEY);
    expect(tree.rootKey).toBe(ROOT_THREAD_KEY);
    expect(tree.latestKey).toBe(ROOT_THREAD_KEY);
    expect(tree.topCount).toBe(0);
    expect(tree.byRow.size).toBe(0);
    // Same object every time — what makes the timeline's publish effect a no-op.
    expect(buildThreadTree([{ role: 'system', msgId: 's0' }, ...messages], [])).toBe(tree);
    expect(buildThreadTree(messages, undefined)).toBe(tree);
  });

  it('a populated tree still files unanchored rows (and pre-turn rows) at root, depth 0', () => {
    // One real anchor forces the full walk; every OTHER row must read as root.
    const withThread = [{ role: 'system' as const, msgId: 's0' }, ...messages, user('u3'), reply('r3')];
    const tree = buildThreadTree(withThread, [anchor('u3', 'r2')]);
    for (const id of ['s0', 'u1', 'r1', 'u2', 'r2']) {
      const row = tree.byRow.get(id);
      expect(row).toBeDefined();
      expect(row!.depth).toBe(0);
      expect(row!.key).toBe(ROOT_THREAD_KEY);
    }
    expect(tree.byRow.get('u3')!.depth).toBe(1);
  });
});

describe('buildThreadTree — one thread', () => {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2')];
  const anchors = [anchor('u2', 'r1', { quote: { exact: 'the tricky part' } })];

  it('lifts the anchored turn to depth 1 with the first hue', () => {
    const tree = buildThreadTree(messages, anchors);
    const key = threadKeyOf(anchors[0]);
    expect(tree.threads.map((t) => t.key)).toEqual([ROOT_THREAD_KEY, key]);
    const node = tree.byKey.get(key)!;
    expect(node.depth).toBe(1);
    expect(node.hue).toBe(THREAD_HUES[0]);
    expect(node.headId).toBe('u2');
    expect(node.turnIds).toEqual(['u2']);
    expect(node.parentKey).toBe(ROOT_THREAD_KEY);
    expect(node.quoteLabel).toBe('the tricky part');
    expect(node.label).toBe('q u2');
    expect(tree.latestKey).toBe(key);
    expect(tree.topCount).toBe(1);
  });

  it('carries the whole turn, not just the user row', () => {
    const tree = buildThreadTree(messages, anchors);
    const key = threadKeyOf(anchors[0]);
    expect(tree.byRow.get('u2')).toEqual({ key, depth: 1, hue: THREAD_HUES[0], isHead: true });
    // The reply to the anchored question belongs to the same thread…
    expect(tree.byRow.get('r2')).toMatchObject({ key, depth: 1, isHead: false });
    // …and the turn BEFORE it is untouched.
    expect(tree.byRow.get('r1')?.key).toBe(ROOT_THREAD_KEY);
  });
});

describe('buildThreadTree — nesting', () => {
  it('reaches depth 2 and keeps the ancestor hue', () => {
    const messages = [
      user('u1'), reply('r1'),
      user('u2'), reply('r2'),   // thread A (about r1)
      user('u3'), reply('r3'),   // thread B (about r2, which is inside A)
    ];
    const a = anchor('u2', 'r1', { quote: { exact: 'outer' } });
    const b = anchor('u3', 'r2', { quote: { exact: 'inner' } });
    const tree = buildThreadTree(messages, [a, b]);

    const outer = tree.byKey.get(threadKeyOf(a))!;
    const inner = tree.byKey.get(threadKeyOf(b))!;
    expect(outer.depth).toBe(1);
    expect(inner.depth).toBe(2);
    expect(inner.parentKey).toBe(outer.key);
    // A sub-thread is the SAME branch: same hue, rendered lighter.
    expect(inner.hue).toBe(outer.hue);
    expect(inner.topIndex).toBe(outer.topIndex);
    // Only the depth-1 thread counts as a top-level branch.
    expect(tree.topCount).toBe(1);
    // Root first, then depth-first.
    expect(tree.threads.map((t) => t.depth)).toEqual([0, 1, 2]);
    expect(tree.byRow.get('u3')).toMatchObject({ depth: 2, hue: outer.hue, isHead: true });
  });
});

describe('buildThreadTree — sticky follow-up', () => {
  it('joins the same thread when the anchor is copied verbatim', () => {
    const messages = [
      user('u1'), reply('r1'),
      user('u2'), reply('r2'),
      user('u3'), reply('r3'),
    ];
    const quote = { exact: 'the tricky part' };
    const first = anchor('u2', 'r1', { quote });
    const sticky = anchor('u3', 'r1', { quote, source: 'sticky' });
    const tree = buildThreadTree(messages, [first, sticky]);

    expect(threadKeyOf(sticky)).toBe(threadKeyOf(first));
    const node = tree.byKey.get(threadKeyOf(first))!;
    expect(node.turnIds).toEqual(['u2', 'u3']);
    // ONE thread, so ONE rail row: the head stays the first question.
    expect(node.headId).toBe('u2');
    expect(tree.byRow.get('u3')?.isHead).toBe(false);
    expect(tree.threads).toHaveLength(2);
    // The follow-up's reply is in the thread too — it is the same turn's tail.
    expect(tree.byRow.get('r3')?.key).toBe(node.key);
  });
});

describe('buildThreadTree — two passages of one reply', () => {
  it('makes two threads with different hues', () => {
    const messages = [
      user('u1'), reply('r1'),
      user('u2'), reply('r2'),
      user('u3'), reply('r3'),
    ];
    const a = anchor('u2', 'r1', { quote: { exact: 'first passage' } });
    const b = anchor('u3', 'r1', { quote: { exact: 'second passage' } });
    const tree = buildThreadTree(messages, [a, b]);

    const first = tree.byKey.get(threadKeyOf(a))!;
    const second = tree.byKey.get(threadKeyOf(b))!;
    expect(first.key).not.toBe(second.key);
    expect(first.depth).toBe(1);
    expect(second.depth).toBe(1);
    expect(second.hue).not.toBe(first.hue);
    expect([first.hue, second.hue]).toEqual([THREAD_HUES[0], THREAD_HUES[1]]);
    expect(tree.topCount).toBe(2);
    // Numbered in TRANSCRIPT order, so the colours read top-to-bottom.
    expect(tree.threads.map((t) => t.key)).toEqual([ROOT_THREAD_KEY, first.key, second.key]);
  });
});

describe('buildThreadTree — dangling anchors', () => {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2')];

  it('ignores an anchor whose user row is not loaded', () => {
    const tree = buildThreadTree(messages, [anchor('u-not-here', 'r1')]);
    expect(tree.threads).toHaveLength(1);
  });

  it('ignores an anchor whose parent reply is not loaded', () => {
    // The normal case for a tail window: the reply scrolled out of the slice.
    const tree = buildThreadTree(messages, [anchor('u2', 'r-older')]);
    expect(tree.threads).toHaveLength(1);
    expect(tree.byRow.get('u2')?.depth).toBe(0);
  });

  it('ignores an anchor whose parent comes AFTER the question', () => {
    // Not representable by the UI, but a hand-written record could hold it — and
    // a cycle in the depth walk would be an infinite loop, not a wrong colour.
    const tree = buildThreadTree(messages, [anchor('u1', 'r2')]);
    expect(tree.threads).toHaveLength(1);
  });

  it('ignores an anchor whose user row is not a turn head', () => {
    const tree = buildThreadTree(messages, [anchor('r2', 'r1')]);
    expect(tree.threads).toHaveLength(1);
  });
});

describe('buildThreadTree — hue cycle', () => {
  it('wraps after six top-level threads', () => {
    const messages: ThreadTreeMessage[] = [user('u0'), reply('r0')];
    const anchors: SessionThreadAnchor[] = [];
    for (let i = 1; i <= 7; i++) {
      messages.push(user(`u${i}`), reply(`r${i}`));
      anchors.push(anchor(`u${i}`, 'r0', { quote: { exact: `passage ${i}` } }));
    }
    const tree = buildThreadTree(messages, anchors);
    const hues = anchors.map((a) => tree.byKey.get(threadKeyOf(a))!.hue);
    expect(hues.slice(0, 6)).toEqual([...THREAD_HUES]);
    expect(hues[6]).toBe(THREAD_HUES[0]);
    expect(tree.topCount).toBe(7);
  });
});

describe('buildThreadTree — rows without ids', () => {
  it('still segments turns, and skips the unidentifiable rows', () => {
    const messages: ThreadTreeMessage[] = [
      user('u1'), reply('r1'),
      { role: 'user', text: 'typed but not yet persisted' },
      { role: 'assistant', text: 'streaming' },
    ];
    // A dangling anchor keeps the full walk on (an empty list short-circuits to
    // the shared empty tree) without threading anything.
    const tree = buildThreadTree(messages, [anchor('not-loaded', 'r1')]);
    expect(tree.byRow.size).toBe(2);
    expect(tree.latestKey).toBe(ROOT_THREAD_KEY);
  });

  it('matches an optimistic row by walnutMessageId', () => {
    const messages: ThreadTreeMessage[] = [
      user('u1'), reply('r1'),
      { role: 'user', walnutMessageId: 'wm-1', text: 'about that' },
    ];
    const tree = buildThreadTree(messages, [anchor('wm-1', 'r1')]);
    expect(tree.byRow.get('wm-1')?.depth).toBe(1);
  });

  /**
   * The just-sent bubble: the uuid was pre-assigned, the anchor was recorded
   * under it, and nothing has persisted yet. It must already be in its thread —
   * otherwise the row visibly joins the thread a history fetch later (and in the
   * node view it would render in the wrong place first).
   */
  it('matches a row that only carries its pre-assigned userUuid', () => {
    const uuid = '9f1c2f0e-0000-4000-8000-000000000001';
    const messages: ThreadTreeMessage[] = [
      user('u1'), reply('r1'),
      { role: 'user', userUuid: uuid, text: 'about that passage' },
    ];
    const tree = buildThreadTree(messages, [anchor(uuid, 'r1', { quote: { exact: 'that passage' } })]);
    const node = tree.byKey.get(threadKeyOf({ parent: 'r1', quote: { exact: 'that passage' } }))!;
    expect(node.headId).toBe(uuid);
    expect(tree.byRow.get(uuid)).toMatchObject({ key: node.key, depth: 1, isHead: true });
    expect(tree.latestKey).toBe(node.key);
  });

  it('prefers the persisted msgId over both fallbacks', () => {
    // The row absorbed by history carries BOTH ids (same uuid), and a row that
    // carried a different walnutMessageId must not answer to it.
    const uuid = '9f1c2f0e-0000-4000-8000-000000000002';
    const messages: ThreadTreeMessage[] = [
      user('u1'), reply('r1'),
      { role: 'user', msgId: uuid, userUuid: uuid, walnutMessageId: 'qm-7', text: 'about that' },
    ];
    const tree = buildThreadTree(messages, [anchor(uuid, 'r1')]);
    expect(tree.byRow.get(uuid)?.depth).toBe(1);
    expect(tree.byRow.has('qm-7')).toBe(false);
  });
});

describe('pathToRoot / siblingsOf', () => {
  // r0 ─┬─ A (about r0) ─── C (about the reply inside A)
  //     └─ B (about r0, a second passage)
  const messages = [
    user('u0'), reply('r0'),
    user('uA'), reply('rA'),
    user('uB'), reply('rB'),
    user('uC'), reply('rC'),
  ];
  const a = anchor('uA', 'r0', { quote: { exact: 'first passage' } });
  const b = anchor('uB', 'r0', { quote: { exact: 'second passage' } });
  const c = anchor('uC', 'rA', { quote: { exact: 'inner' } });
  const tree = buildThreadTree(messages, [a, b, c]);
  const keyA = threadKeyOf(a);
  const keyB = threadKeyOf(b);
  const keyC = threadKeyOf(c);

  it('reads root first and the thread itself last', () => {
    expect(pathToRoot(tree, keyC).map((n) => n.key)).toEqual([ROOT_THREAD_KEY, keyA, keyC]);
    expect(pathToRoot(tree, keyA).map((n) => n.key)).toEqual([ROOT_THREAD_KEY, keyA]);
    expect(pathToRoot(tree, ROOT_THREAD_KEY).map((n) => n.key)).toEqual([ROOT_THREAD_KEY]);
  });

  it('is empty for a thread the tree does not know', () => {
    expect(pathToRoot(tree, 'no-such-thread')).toEqual([]);
    expect(siblingsOf(tree, 'no-such-thread')).toEqual([]);
  });

  it('lists siblings in transcript order, the thread included', () => {
    expect(siblingsOf(tree, keyA).map((n) => n.key)).toEqual([keyA, keyB]);
    expect(siblingsOf(tree, keyB).map((n) => n.key)).toEqual([keyA, keyB]);
    // An only child is its own sole sibling — ←/→ then have nowhere to go.
    expect(siblingsOf(tree, keyC).map((n) => n.key)).toEqual([keyC]);
    // Root is the only thread at its level.
    expect(siblingsOf(tree, ROOT_THREAD_KEY).map((n) => n.key)).toEqual([ROOT_THREAD_KEY]);
  });
});

describe('hueForAnchor', () => {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2')];

  it('previews the hue a brand-new top-level thread will get', () => {
    const tree = buildThreadTree(messages, []);
    expect(hueForAnchor(tree, { parent: 'r1', source: 'selection', label: 'x' }))
      .toBe(THREAD_HUES[0]);
  });

  it('reuses an existing thread\'s hue', () => {
    const a = anchor('u2', 'r1', { quote: { exact: 'p' } });
    const tree = buildThreadTree(messages, [a]);
    const node = tree.byKey.get(threadKeyOf(a))!;
    expect(hueForAnchor(tree, { parent: 'r1', quote: { exact: 'p' }, source: 'sticky', label: 'x' }))
      .toBe(node.hue);
  });

  it('inherits the branch hue when the reply is already inside a thread', () => {
    const a = anchor('u2', 'r1', { quote: { exact: 'p' } });
    const tree = buildThreadTree(messages, [a]);
    const node = tree.byKey.get(threadKeyOf(a))!;
    // r2 lives inside thread A, so a question about it stays in that branch.
    expect(hueForAnchor(tree, { parent: 'r2', source: 'selection', label: 'x' })).toBe(node.hue);
  });
});

describe('composeAnchoredText', () => {
  const quote = { exact: 'line one\n\nline two' };

  it('quotes the passage for a fresh selection', () => {
    const text = composeAnchoredText('why?', { parent: 'r1', quote, source: 'selection', label: 'line one' }, ROOT_THREAD_KEY);
    expect(text).toBe('> line one\n>\n> line two\n\nwhy?');
  });

  it('adds nothing for a follow-up inside the newest thread', () => {
    const a = { parent: 'r1', quote, source: 'sticky' as const, label: 'line one' };
    expect(composeAnchoredText('and then?', a, threadKeyOf(a))).toBe('and then?');
  });

  it('names the thread when returning to an older one', () => {
    const a = { parent: 'r1', source: 'manual' as const, label: 'the deploy question' };
    const text = composeAnchoredText('still open?', a, 'some-other-thread');
    expect(text).toBe('(Back to the earlier thread about “the deploy question”)\n\nstill open?');
  });

  it('re-quotes the passage when returning to a passage thread', () => {
    const a = { parent: 'r1', quote: { exact: 'the tricky part' }, source: 'manual' as const, label: 'the tricky part' };
    expect(composeAnchoredText('what about this?', a, 'elsewhere')).toBe(
      '(Back to the earlier thread about “the tricky part”)\n\n> the tricky part\n\nwhat about this?',
    );
  });
});

describe('quoteBlockOf', () => {
  it('keeps a multi-paragraph passage inside ONE blockquote', () => {
    expect(quoteBlockOf({ exact: 'a\n\nb' })).toBe('> a\n>\n> b');
  });
});

/**
 * The rows the tree is built from include what this browser has just sent. Getting
 * this wrong is invisible in the transcript and very visible in the UI: the outline,
 * the map and the child cards only learn about a new thread a whole answer late (the
 * bubble's own gutter bar reads the anchor directly, so it looks like only the map is
 * broken).
 */
describe('withPendingUserRows', () => {
  const pending = (uuid: string): ThreadTreeMessage =>
    ({ role: 'user', userUuid: uuid, walnutMessageId: `queue-${uuid}`, text: 'just asked' });

  it('returns the SAME array when there is nothing pending (memo identity)', () => {
    const rows = [user('u1'), reply('r1')];
    expect(withPendingUserRows(rows, [])).toBe(rows);
    expect(withPendingUserRows(rows, undefined)).toBe(rows);
  });

  it('ignores optimistic rows with no pre-assigned uuid — they cannot be anchored', () => {
    const rows = [user('u1')];
    expect(withPendingUserRows(rows, [{ role: 'user', walnutMessageId: 'queue-x' }])).toBe(rows);
  });

  it('appends a sent-but-not-persisted user row, so its thread exists immediately', () => {
    const rows = [user('u1'), reply('r1')];
    const merged = withPendingUserRows(rows, [pending('new-uuid')]);
    expect(merged).toHaveLength(3);
    expect(merged[2].userUuid).toBe('new-uuid');
    // The tree files it under that uuid, so the thread is real before the refetch.
    const tree = buildThreadTree(merged, [
      { msgId: 'new-uuid', parent: 'r1', source: 'selection', at: 't' } as SessionThreadAnchor,
    ]);
    expect(tree.threads).toHaveLength(2);
    expect(tree.byRow.get('new-uuid')?.depth).toBe(1);
  });

  it('drops an optimistic row the transcript has ABSORBED (no double-counted turn)', () => {
    const rows = [user('u1'), reply('r1'), user('new-uuid')];
    expect(withPendingUserRows(rows, [pending('new-uuid')])).toBe(rows);
    const tree = buildThreadTree(withPendingUserRows(rows, [pending('new-uuid')]), [
      { msgId: 'new-uuid', parent: 'r1', source: 'selection', at: 't' } as SessionThreadAnchor,
    ]);
    expect(tree.byKey.get(tree.latestKey)?.turnIds).toEqual(['new-uuid']);
  });
});

describe('the head row leads with its quote block (the page hides it in CSS)', () => {
  it('a composed question starts with the markdown quote of its passage', () => {
    const quote = { exact: 'line one\n\nline two' };
    const sent = composeAnchoredText('What does this mean?', { parent: 'r1', quote, source: 'selection', label: 'x' }, ROOT_THREAD_KEY);
    expect(sent.startsWith(quoteBlockOf(quote))).toBe(true);
  });
});

describe('composeOrientedText (C58)', () => {
  const titleOfKey = (k: string) => (k === 'k-deep' ? 'Cache eviction order' : 'Other');
  it('root send after a deep question leads with the back-to-main line', () => {
    const out = composeOrientedText('Next step?', { latestKey: 'k-deep', currentKey: ROOT_THREAD_KEY, titleOfKey });
    expect(out.startsWith(BACK_TO_MAIN_LINE)).toBe(true);
    expect(out).toBe('(Back to the main conversation)\n\nNext step?');
  });
  it('a page whose question is not the newest names it by display title', () => {
    const out = composeOrientedText('And the tail?', { latestKey: 'k-other', currentKey: 'k-deep', titleOfKey });
    expect(out).toBe('(Back to the earlier question about “Cache eviction order”)\n\nAnd the tail?');
  });
  it('adds nothing when the newest turn is on this page (root or question)', () => {
    expect(composeOrientedText('x', { latestKey: 'k-deep', currentKey: 'k-deep', titleOfKey })).toBe('x');
    expect(composeOrientedText('x', { latestKey: ROOT_THREAD_KEY, currentKey: ROOT_THREAD_KEY, titleOfKey })).toBe('x');
  });
  it('never uses the old thread wording', () => {
    const out = composeOrientedText('x', { latestKey: 'k-other', currentKey: 'k-deep', titleOfKey });
    expect(out).not.toMatch(/thread/i);
  });
});

describe('findSamePassageThread (plan A)', () => {
  const messages = [user('u0'), reply('r0', 'alpha beta gamma delta'), user('u1'), reply('r1'), user('u2'), reply('r2')];
  const anchors = [
    anchor('u1', 'r0', { quote: { exact: 'alpha beta' } }),
    anchor('u2', 'r0', { quote: { exact: 'gamma delta' } }),
  ];
  const tree = buildThreadTree(messages, anchors);
  const k1 = threadKeyOf(anchors[0]);
  it('finds the visible question on the same passage, whitespace-insensitive', () => {
    expect(findSamePassageThread(tree, anchors, new Set(), { parent: 'r0', quote: { exact: '  alpha\nbeta ' } })).toBe(k1);
  });
  it('partial overlap, another reply, or a whole-reply target open a new question', () => {
    expect(findSamePassageThread(tree, anchors, new Set(), { parent: 'r0', quote: { exact: 'alpha' } })).toBeNull();
    expect(findSamePassageThread(tree, anchors, new Set(), { parent: 'r1', quote: { exact: 'alpha beta' } })).toBeNull();
    expect(findSamePassageThread(tree, anchors, new Set(), { parent: 'r0' })).toBeNull();
  });
  it('a hidden question never matches', () => {
    expect(findSamePassageThread(tree, anchors, new Set([k1]), { parent: 'r0', quote: { exact: 'alpha beta' } })).toBeNull();
  });
  it('normalizePassage folds width and whitespace', () => {
    // Full-width A and B (test data as escapes).
    expect(normalizePassage('\uFF21\uFF22  c\n')).toBe('AB c');
  });
});

describe('buildThreadTree: a question about a FILE passage', () => {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3')];
  const fileAnchor = anchor('u2', 'file:/repo/docs/cache.md', { quote: { exact: 'late flush' }, line: 12 });

  it('hangs off root at depth 1 and carries the file place, with no reply row to precede it', () => {
    const tree = buildThreadTree(messages, [fileAnchor]);
    expect(tree.threads).toHaveLength(2);
    const node = tree.byKey.get(threadKeyOf(fileAnchor))!;
    expect(node.depth).toBe(1);
    expect(node.parentKey).toBe(ROOT_THREAD_KEY);
    expect(node.file).toEqual({ path: '/repo/docs/cache.md', line: 12 });
    expect(node.turnIds).toEqual(['u2']);
    expect(tree.byRow.get('r2')?.key).toBe(node.key);
  });

  it('a follow-up copying the anchor joins the file question', () => {
    const tree = buildThreadTree(messages, [fileAnchor, anchor('u3', fileAnchor.parent, { quote: { exact: 'late flush' } })]);
    expect(tree.threads).toHaveLength(2);
    expect(tree.byKey.get(threadKeyOf(fileAnchor))!.turnIds).toEqual(['u2', 'u3']);
  });

  it('two files with the same passage text are two questions', () => {
    const other = anchor('u3', 'file:/repo/docs/other.md', { quote: { exact: 'late flush' } });
    const tree = buildThreadTree(messages, [fileAnchor, other]);
    expect(tree.threads).toHaveLength(3);
    expect(tree.byKey.get(threadKeyOf(other))!.file).toEqual({ path: '/repo/docs/other.md' });
  });

  it('fileOfParent reads the path back; a reply msgId is not a file', () => {
    expect(fileOfParent('file:/a/b.md')).toBe('/a/b.md');
    expect(fileParentOf('/a/b.md')).toBe('file:/a/b.md');
    expect(fileOfParent('r1')).toBeNull();
    expect(fileOfParent('file:')).toBeNull();
    expect(fileOfParent(undefined)).toBeNull();
  });
});

describe('composeAnchoredText: a file passage', () => {
  it('names the file (and line) ahead of the quote on a fresh selection', () => {
    const text = composeAnchoredText('Why?', {
      parent: 'file:/repo/docs/cache.md', quote: { exact: 'late flush' }, line: 12, source: 'selection', label: 'late flush',
    }, ROOT_THREAD_KEY);
    expect(text).toBe('About `/repo/docs/cache.md:12`:\n\n> late flush\n\nWhy?');
    expect(FILE_ABOUT_LINE_RE.test(text.split('\n')[0])).toBe(true);
  });

  it('no line: the path alone', () => {
    expect(fileAboutLineOf('/repo/docs/cache.md')).toBe('About `/repo/docs/cache.md`:');
  });

  it('a return to the file question from elsewhere leads with the thread line, then the file', () => {
    const a = { parent: 'file:/repo/docs/cache.md', quote: { exact: 'late flush' }, source: 'manual' as const, label: 'Late flush' };
    const text = composeAnchoredText('More?', a, 'some-other-key');
    expect(text.split('\n\n')).toEqual(['(Back to the earlier thread about “Late flush”)', 'About `/repo/docs/cache.md`:', '> late flush', 'More?']);
  });
});

describe('shortenFileAboutLine', () => {
  const cwd = '/home/u/repo';
  it('shows the path relative to the session cwd', () => {
    expect(shortenFileAboutLine('About `/home/u/repo/docs/a.md:12`:\n\n> q\n\nwhy?', cwd))
      .toBe('About `docs/a.md:12`:\n\n> q\n\nwhy?');
  });
  it('skips an orientation line ahead of it', () => {
    expect(shortenFileAboutLine('(Back to the main conversation)\n\nAbout `/home/u/repo/a.md`:\n\n> q', cwd))
      .toBe('(Back to the main conversation)\n\nAbout `a.md`:\n\n> q');
  });
  it('leaves a path outside the cwd, a line that is not the opening, and text with no cwd', () => {
    expect(shortenFileAboutLine('About `/etc/hosts`:\n\n> q', cwd)).toBe('About `/etc/hosts`:\n\n> q');
    expect(shortenFileAboutLine('hello\n\nAbout `/home/u/repo/a.md`:', cwd)).toBe('hello\n\nAbout `/home/u/repo/a.md`:');
    expect(shortenFileAboutLine('About `/home/u/repo/a.md`:', undefined)).toBe('About `/home/u/repo/a.md`:');
  });
});
