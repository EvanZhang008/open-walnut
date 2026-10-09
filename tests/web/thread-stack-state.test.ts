/**
 * The question stack's pure rules (web/src/utils/thread-stack-state.ts): path,
 * cross-branch navigation, page and draft keys, the Esc decision, landing
 * arithmetic, sliver bars and the quote head's context.
 */
import { describe, it, expect } from 'vitest';
import {
  composerDraftKey, deriveThreadStats, escapeDecision, hashText, isPendingKey, isStillClick, landingCorrection,
  contextSide, needsFallbackJump, pageLeave, pendingPageKey, planNavigation, quoteHeadParts, samePath, sliverBarWidth,
  sliverBars, stackPathOf, wordCount,
} from '@/utils/thread-stack-state';
import { ROOT_THREAD_KEY, buildThreadTree, threadKeyOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';

const user = (msgId: string): ThreadTreeMessage => ({ role: 'user', msgId, text: `q ${msgId}` });
const reply = (msgId: string): ThreadTreeMessage => ({ role: 'assistant', msgId, text: `a ${msgId}` });
const anchor = (msgId: string, parent: string, exact: string): SessionThreadAnchor =>
  ({ msgId, parent, source: 'selection', at: '2026-09-03T10:00:00Z', quote: { exact } });

// root: u1 r1 | A (about r1): u2 r2 | B (about r2): u3 r3 | C (about r1, other passage): u4 r4
function fixture() {
  const messages = [user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3'), user('u4'), reply('r4')];
  const anchors = [anchor('u2', 'r1', 'alpha passage here'), anchor('u3', 'r2', 'beta passage here'), anchor('u4', 'r1', 'gamma passage here')];
  const tree = buildThreadTree(messages, anchors);
  const A = threadKeyOf(anchors[0]);
  const B = threadKeyOf(anchors[1]);
  const C = threadKeyOf(anchors[2]);
  return { tree, A, B, C };
}

describe('page keys', () => {
  it('builds a stable pending key from the parent and the normalized passage', () => {
    const a = pendingPageKey('r1', 'the  limiter\nkeys');
    expect(a).toBe(pendingPageKey('r1', 'the limiter keys'));
    expect(a.startsWith('pending:r1:')).toBe(true);
    expect(isPendingKey(a)).toBe(true);
    expect(isPendingKey(ROOT_THREAD_KEY)).toBe(false);
    expect(pendingPageKey('r1', 'x')).not.toBe(pendingPageKey('r2', 'x'));
    expect(hashText('abc')).toBe(hashText('abc'));
  });

  it('keeps the root draft key and keys pages by head id or pending key', () => {
    const { tree, A } = fixture();
    expect(composerDraftKey('s1', ROOT_THREAD_KEY, tree)).toBe('draft:session:s1');
    expect(composerDraftKey('s1', A, tree)).toBe('draft:session:s1:u2');
    const p = pendingPageKey('r2', 'x y');
    expect(composerDraftKey('s1', p, tree)).toBe(`draft:session:s1:${p}`);
  });
});

describe('stackPathOf and planNavigation', () => {
  it('walks root to leaf and puts a pending page on its parent', () => {
    const { tree, A, B } = fixture();
    expect(stackPathOf(tree, B)).toEqual([ROOT_THREAD_KEY, A, B]);
    expect(stackPathOf(tree, ROOT_THREAD_KEY)).toEqual([ROOT_THREAD_KEY]);
    expect(stackPathOf(tree, 'unknown')).toEqual([ROOT_THREAD_KEY]);
    const pending = { pageKey: 'pending:r3:1', parentKey: B };
    expect(stackPathOf(tree, pending.pageKey, pending)).toEqual([ROOT_THREAD_KEY, A, B, 'pending:r3:1']);
  });

  it('decomposes a cross-branch jump into pops to the common ancestor then pushes', () => {
    const { tree, A, B, C } = fixture();
    const plan = planNavigation(stackPathOf(tree, B), stackPathOf(tree, C));
    expect(plan.common).toBe(ROOT_THREAD_KEY);
    expect(plan.popped).toEqual([B, A]);
    expect(plan.pushed).toEqual([C]);
    expect(plan.direction).toBe('push');
    const back = planNavigation(stackPathOf(tree, B), [ROOT_THREAD_KEY]);
    expect(back.direction).toBe('pop');
    expect(back.popped).toEqual([B, A]);
    expect(planNavigation([ROOT_THREAD_KEY, A], [ROOT_THREAD_KEY, A]).direction).toBe('none');
    expect(samePath([ROOT_THREAD_KEY, A], [ROOT_THREAD_KEY, A])).toBe(true);
    expect(samePath([ROOT_THREAD_KEY], [ROOT_THREAD_KEY, A])).toBe(false);
  });
});

describe('escapeDecision', () => {
  it('pops unless at the root or the focused composer holds text', () => {
    expect(escapeDecision({ depth: 0, composerFocused: false, composerText: '' })).toBe('ignore');
    expect(escapeDecision({ depth: 2, composerFocused: true, composerText: 'half a thought' })).toBe('ignore');
    expect(escapeDecision({ depth: 2, composerFocused: true, composerText: '   ' })).toBe('pop');
    expect(escapeDecision({ depth: 1, composerFocused: false, composerText: 'kept draft' })).toBe('pop');
  });
});

describe('landing arithmetic', () => {
  it('corrects by the passage drift and falls back past 8px or an unloaded row', () => {
    expect(landingCorrection({ scrollTop: 100, sentenceTop: 40 }, 52)).toBe(12);
    expect(landingCorrection({ scrollTop: 100 }, 52)).toBeNull();
    expect(landingCorrection(undefined, 1)).toBeNull();
    expect(needsFallbackJump(3, true)).toBe(false);
    expect(needsFallbackJump(-9, true)).toBe(true);
    expect(needsFallbackJump(null, true)).toBe(false);
    expect(needsFallbackJump(0, false)).toBe(true);
  });
});

describe('sliverBars', () => {
  const anc = (n: number) => Array.from({ length: n }, (_, i) => ({
    key: i === 0 ? ROOT_THREAD_KEY : `k${i}`, hue: 152, title: `T${i}`,
  }));

  it('draws one bar per ancestor up to four, root first and muted', () => {
    const bars = sliverBars(anc(3));
    expect(bars).toHaveLength(3);
    expect(bars[0]).toMatchObject({ key: ROOT_THREAD_KEY, level: 0, label: 'Back to Main conversation' });
    expect(bars[0].hue).toBeUndefined();
    expect(bars.map((b) => b.level)).toEqual([0, 1, 2]);
    expect(bars[2].label).toBe('Back to T2');
    expect(sliverBars([])).toEqual([]);
  });

  it('folds levels past depth 4 into the leftmost bar', () => {
    const bars = sliverBars(anc(6));
    expect(bars).toHaveLength(4);
    expect(bars[0]).toMatchObject({ key: ROOT_THREAD_KEY, collapsed: 2, label: 'Main + 2 more levels' });
    expect(bars.slice(1).map((b) => b.key)).toEqual(['k3', 'k4', 'k5']);
    // Every bar in one branch gets its own lightness level.
    expect(new Set(bars.map((b) => b.level)).size).toBe(4);
  });

  it('narrows under 600px and pops only on a click that did not travel', () => {
    expect(sliverBarWidth(480)).toBe(8);
    expect(sliverBarWidth(900)).toBe(10);
    expect(isStillClick({ x: 0, y: 0 }, { x: 3, y: 2 })).toBe(true);
    expect(isStillClick({ x: 0, y: 0 }, { x: 10, y: 0 })).toBe(false);
    expect(isStillClick(null, { x: 0, y: 0 })).toBe(false);
  });
});

describe('quoteHeadParts', () => {
  it('adds prefix and suffix only for a passage under four words', () => {
    expect(wordCount('keys on tenant')).toBe(3);
    expect(quoteHeadParts({ exact: 'keys on tenant', prefix: 'The limiter ', suffix: ', not the route.' }))
      .toEqual({ prefix: 'The limiter ', exact: 'keys on tenant', suffix: ', not the route.' });
    expect(quoteHeadParts({ exact: 'the limiter keys on tenant', prefix: 'x', suffix: 'y' }))
      .toEqual({ exact: 'the limiter keys on tenant' });
    expect(quoteHeadParts(undefined)).toBeNull();
    expect(quoteHeadParts({ exact: '  ' })).toBeNull();
  });

  it('a full context window loses its outer word fragment, marked by an ellipsis (N31)', () => {
    // 32-char windows cut mid-word on both sides, as the pin capture stores them.
    const prefix = 'r page slot because update. The '
    const suffix = ' step merges small pages into on'
    expect(prefix).toHaveLength(32)
    expect(suffix).toHaveLength(32)
    const parts = quoteHeadParts({ exact: 'compaction', prefix, suffix })
    expect(parts).toEqual({ prefix: '… page slot because update. The ', exact: 'compaction', suffix: ' step merges small pages into …' })
    expect(contextSide('abcdefghijklmnopqrstuvwxyzabcdefgh', 'before')).toBe('… abcdefghijklmnopqrstuvwxyzabcdefgh')
  });
});

describe('deriveThreadStats', () => {
  it('tracks answers, questions and failed turn ends per question', () => {
    const key = (id?: string) => (id === 'u2' || id === 'e2' ? 'A' : id === 'u3' ? 'B' : '');
    const stats = deriveThreadStats([
      { role: 'user', msgId: 'u1', text: 'root q' },
      { role: 'assistant', msgId: 'r1', text: 'root answer', timestamp: '2026-09-01T10:00:00Z' },
      { role: 'user', msgId: 'u2', text: '> passage\n\nwhy?' },
      { role: 'system', msgId: 'e2', text: 'boom', systemVariant: 'error' },
      { role: 'user', msgId: 'u3', text: 'other' },
      { role: 'assistant', msgId: 'r3', text: 'API Error: 500' },
    ], key);
    expect(stats.lastAnswer.get('')).toBe('root answer');
    expect(stats.answeredAt.get('')).toBe(Date.parse('2026-09-01T10:00:00Z'));
    expect(stats.lastQuestion.get('A')).toBe('> passage\n\nwhy?');
    expect(stats.turnEnds.get('u2')).toBe('error');
    expect(stats.turnEnds.get('u3')).toBe('error');
    expect(stats.answered.has('u1')).toBe(true);
    expect(stats.answered.has('u2')).toBe(false);
  });

  it('marks an interrupted turn with no answer, and an answer clears a failure', () => {
    const stats = deriveThreadStats([
      { role: 'user', msgId: 'u1', text: 'q' },
      { role: 'user', msgId: 'i', text: '[Request interrupted by user]' },
      { role: 'user', msgId: 'u2', text: 'q2' },
      { role: 'system', msgId: 'e', text: 'x', systemVariant: 'error' },
      { role: 'assistant', msgId: 'r2', text: 'recovered' },
    ], () => '');
    expect(stats.turnEnds.get('u1')).toBe('interrupted');
    expect(stats.turnEnds.has('u2')).toBe(false);
  });

  it('a reply of the [Qn] tag and tool calls answered nothing (silent); words later in the turn do', () => {
    const stats = deriveThreadStats([
      { role: 'user', msgId: 'queue-1', sourceUuid: 'q3', text: '[Question Q3]\n…\n[/Question Q3]\n\nthird?' },
      { role: 'assistant', msgId: 't1', text: '[Q3]' },
      { role: 'assistant', msgId: 't2', text: '' },
      { role: 'user', msgId: 'u4', text: 'fourth?' },
      { role: 'assistant', msgId: 't3', text: '**[Q4]**' },
      { role: 'assistant', msgId: 't4', text: 'Here is the answer.' },
    ], (id) => (id === 'q3' ? 'Q3' : id === 'u4' ? 'Q4' : ''));
    // The queued row is known by the uuid it was sent under.
    expect(stats.turnEnds.get('q3')).toBe('silent');
    expect(stats.answered.has('q3')).toBe(false);
    expect(stats.lastAnswer.has('Q3')).toBe(false);
    expect(stats.lastQuestion.has('Q3')).toBe(true);
    expect(stats.turnEnds.has('u4')).toBe(false);
    expect(stats.answered.has('u4')).toBe(true);
    expect(stats.lastAnswer.get('Q4')).toBe('Here is the answer.');
  });
});

describe('live blocks keep the page of the turn that wrote them', () => {
  it('a finished turn stays on its page while the next turn streams elsewhere', async () => {
    const { recordTurnSegments, blockPageKey } = await import('@/utils/thread-stack-state');
    // Mount mid-stream: blocks already finished have no known owner (follow live).
    let segs = recordTurnSegments([], 2, 2, null);
    expect(segs).toEqual([{ end: 2, key: null }]);
    // The root turn (live on main) writes blocks 2..5 and ends.
    segs = recordTurnSegments(segs, 5, 5, 'main');
    expect(segs).toEqual([{ end: 2, key: null }, { end: 5, key: 'main' }]);
    // Idempotent on a re-render with the same inputs.
    expect(recordTurnSegments(segs, 5, 5, 'q1')).toBe(segs);
    // q1 now streams blocks 5..7: the root answer stays on main.
    expect(blockPageKey(segs, 3, 'q1')).toBe('main');
    expect(blockPageKey(segs, 6, 'q1')).toBe('q1');
    expect(blockPageKey(segs, 0, 'q1')).toBe('q1');
    segs = recordTurnSegments(segs, 7, 7, 'q1');
    expect(blockPageKey(segs, 6, 'q2')).toBe('q1');
  });

  it('the main conversation (key "") is a real owner, not "unknown"', async () => {
    const { recordTurnSegments, blockPageKey } = await import('@/utils/thread-stack-state');
    const segs = recordTurnSegments([], 3, 3, ROOT_THREAD_KEY);
    expect(blockPageKey(segs, 1, 'q3')).toBe(ROOT_THREAD_KEY);
  });

  it('a reset stream drops every segment', async () => {
    const { recordTurnSegments } = await import('@/utils/thread-stack-state');
    const segs = recordTurnSegments(recordTurnSegments([], 0, 0, null), 4, 4, 'main');
    expect(recordTurnSegments(segs, 0, 0, 'main')).toEqual([]);
    expect(recordTurnSegments(segs, 1, 1, 'main')).toEqual([{ end: 1, key: 'main' }]);
  });
});

describe('a finished turn is matched to the delivery that started it', () => {
  const load = () => import('@/utils/thread-stack-state');
  const mounted = async () => { const { newTurnBook } = await load(); const b = newTurnBook(); b.mounted = true; return b };

  it('question rows are one turn each; plain rows delivered together are one batch', async () => {
    const { deliveryEntries } = await load();
    expect(deliveryEntries([{ key: 'q1', uuid: true }, { key: 'q2', uuid: true }])).toEqual(['q1', 'q2']);
    expect(deliveryEntries([{ key: '', uuid: false }, { key: '', uuid: false }])).toEqual(['']);
  });

  it('separate renders: deliver, start, end, for each question in turn', async () => {
    const { trackTurn } = await load();
    const b = await mounted();
    expect(trackTurn(b, ['q1'], false, false)).toBeUndefined();
    trackTurn(b, [], true, false);
    expect(trackTurn(b, [], false, true)).toBe('q1');
    trackTurn(b, ['q2'], false, false);
    trackTurn(b, [], true, false);
    expect(trackTurn(b, [], false, true)).toBe('q2');
    expect(b.queue).toEqual([]);
  });

  it('the next delivery in the render a turn ends goes to the NEXT turn', async () => {
    const { trackTurn } = await load();
    const b = await mounted();
    trackTurn(b, ['q1'], false, false);
    trackTurn(b, [], true, false);
    expect(trackTurn(b, ['q2'], false, true)).toBe('q1');
    trackTurn(b, [], true, false);
    expect(trackTurn(b, [], false, true)).toBe('q2');
  });

  it('an end and the next start in one render: the new turn claims the new delivery', async () => {
    const { trackTurn } = await load();
    const b = await mounted();
    trackTurn(b, ['q1'], true, false);
    expect(trackTurn(b, ['q2'], true, true)).toBe('q1');
    expect(trackTurn(b, [], false, true)).toBe('q2');
  });

  it('a whole turn inside one render claims its own delivery', async () => {
    const { trackTurn } = await load();
    const b = await mounted();
    expect(trackTurn(b, ['q1', 'q2'], false, true)).toBe('q1');
    expect(b.queue).toEqual(['q2']);
  });

  it('mounted mid-turn: the newest delivery seen at mount owns it; nothing earlier is queued', async () => {
    const { newTurnBook, trackTurn } = await load();
    const b = newTurnBook();
    trackTurn(b, ['main'], true, false);
    expect(b.queue).toEqual([]);
    trackTurn(b, ['q1'], true, false);
    expect(trackTurn(b, [], false, true)).toBe('main');
    trackTurn(b, [], true, false);
    expect(trackTurn(b, [], false, true)).toBe('q1');
  });

  it('a start with no known owner claims a delivery reported while it runs', async () => {
    const { newTurnBook, trackTurn } = await load();
    const b = newTurnBook();
    trackTurn(b, [], true, false);
    trackTurn(b, ['main'], true, false);
    trackTurn(b, ['q1'], true, false);
    expect(trackTurn(b, [], false, true)).toBe('main');
    trackTurn(b, [], true, false);
    expect(trackTurn(b, [], false, true)).toBe('q1');
  });

  it('nothing known: null, and the caller asks the transcript', async () => {
    const { newTurnBook, trackTurn } = await load();
    const b = newTurnBook();
    expect(trackTurn(b, [], false, true)).toBeNull();
  });
});

describe('pageLeave: what leaving a page keeps', () => {
  const base = { leavingPending: true, leavingRoot: false, composerText: '', rootDraft: '' };
  it('an Ask left with no words keeps nothing (no draft row, no stored text)', () => {
    expect(pageLeave(base)).toEqual({ fromDraft: '', keepPendingDraft: false });
    expect(pageLeave({ ...base, cardText: '   ' })).toEqual({ fromDraft: '   ', keepPendingDraft: false });
    // A reopened draft emptied in the card goes, whatever its stale copy in the composer says.
    expect(pageLeave({ ...base, cardText: '', composerText: 'old words' })).toEqual({ fromDraft: '', keepPendingDraft: false });
  });
  it('words typed in the card (while open) or the composer keep the Ask as a draft', () => {
    expect(pageLeave({ ...base, cardText: 'why?' })).toEqual({ fromDraft: 'why?', keepPendingDraft: true });
    expect(pageLeave({ ...base, composerText: 'how?' })).toEqual({ fromDraft: 'how?', keepPendingDraft: true });
    expect(pageLeave({ ...base, cardText: 'why?', composerText: 'how?' }).fromDraft).toBe('why?');
  });
  it("the card's words count only for a pending page", () => {
    expect(pageLeave({ ...base, leavingPending: false, cardText: 'why?', composerText: 'how?' }))
      .toEqual({ fromDraft: 'how?', keepPendingDraft: false });
  });
  it('carryToRoot moves the words to the main draft after what it holds, and drops the Ask', () => {
    expect(pageLeave({ ...base, composerText: 'how?', carryToRoot: true }))
      .toEqual({ fromDraft: '', rootDraft: 'how?', keepPendingDraft: false });
    expect(pageLeave({ ...base, leavingPending: false, composerText: 'how?', carryToRoot: true, rootDraft: 'earlier\n' }))
      .toEqual({ fromDraft: '', rootDraft: 'earlier\n\nhow?', keepPendingDraft: false });
    expect(pageLeave({ ...base, carryToRoot: true, rootDraft: 'earlier' }).rootDraft).toBe('earlier');
  });
});
