/**
 * A question taken mid-turn claims only the words under its own tag
 * (2026-11-03, the user: "this is not answer question of this thread somehow
 * consider as result of the thread").
 *
 * The main conversation's turn was running when the user asked a question on a
 * passage. Claude Code took the question at a tool boundary and the turn went on
 * with its own work; its final reply (no `[Qn]` tag) was filed under the
 * question: live (web/src/stream/chat-order.ts liveLineOwners gave every block
 * after the question's line to the question) and once the transcript landed
 * (tagged-reply-split.ts left an untagged stretch as the transcript has it, so
 * every row reader filed the turn's rest under the question's row).
 *
 * The rule, the same live and stored: a line taken mid-turn that asked a
 * question never owns the turn by position. A text block (a reply row) opening
 * with its tag is its answer; the turn's own words before and after stay with the
 * turn. A question asked while idle starts its own turn and owns it whole.
 */
import { describe, it, expect } from 'vitest';
import { liveLineOwners, takenLinesOf } from '@/stream/chat-order';
import type { StreamingBlock, StreamingUserLineBlock } from '@/stream/stream-reducer';
import { splitTaggedReplies, type SplitRow } from '@/utils/tagged-reply-split';
import { buildThreadTree, threadKeyOf, ROOT_THREAD_KEY } from '@/utils/thread-tree';
import { blockTagKeys, withTagAnchors } from '@/utils/question-tag';
import { deriveThreadStats } from '@/utils/thread-stack-state';
import { cardTurnsOf } from '@/utils/thread-card';
import { deriveThreadLiveStates } from '@/utils/thread-meta';
import type { SessionThreadAnchor } from '@/types/session';

// ── Live: the owners of the blocks of a running turn ──

const text = (content: string): StreamingBlock => ({ type: 'text', content });
const line = (uuid: string): StreamingBlock => ({ type: 'user_line', uuid });
const tool = (id: string): StreamingBlock => ({ type: 'tool_call', toolUseId: id, name: 'Bash', input: {}, status: 'done' });

const known: Record<string, { key: string; seqs: number[] }> = {
  main: { key: '', seqs: [] },
  q3: { key: 'K3', seqs: [3] },
  q4: { key: 'K4', seqs: [4] },
};
const keyOf = (l: StreamingUserLineBlock) => known[l.uuid]?.key ?? null;
const seqsOf = (l: StreamingUserLineBlock) => known[l.uuid]?.seqs ?? null;
const keyBySeq = new Map<number, string>([[3, 'K3'], [4, 'K4']]);
const tagOf = (b: StreamingBlock) => {
  const m = b.type === 'text' ? /^\[Q(\d+)\]/.exec(b.content) : null;
  const key = m ? keyBySeq.get(Number(m[1])) : undefined;
  return m && key ? { key, seq: Number(m[1]) } : null;
};
const owners = (blocks: StreamingBlock[], ends: number[] = []) => liveLineOwners(blocks, takenLinesOf(blocks), keyOf, seqsOf, tagOf, ends);

describe('live: a question taken while the main turn runs', () => {
  it('the screenshot: the turn\'s reply after the question\'s line, with no tag, is the main conversation\'s', () => {
    const blocks = [line('main'), text('Building the page.'), tool('t1'), line('q3'), tool('t2'), text('Revision 4 is built: 25 sections.')];
    expect(owners(blocks)).toEqual(['', '', '', '', '', '']);
  });

  it('the part under its own tag is the question\'s; the turn\'s work and reply after it are not', () => {
    const blocks = [line('main'), tool('t1'), line('q3'), text('[Q3]\nYes, through the pod spec.'), tool('t2'), text('Revision 4 is built.')];
    expect(owners(blocks)).toEqual(['', '', '', 'K3', '', '']);
  });

  it('two questions taken in one turn: each tag files its own block', () => {
    const blocks = [line('main'), tool('t1'), line('q3'), line('q4'), text('[Q4]\nfour'), text('[Q3]\nthree'), text('ROOT-DONE')];
    expect(owners(blocks)).toEqual(['', '', '', '', 'K4', 'K3', '']);
  });

  it('a question asked while idle starts its own turn and owns it, tag or not', () => {
    const blocks = [line('q3'), tool('t1'), text('An answer without its tag.')];
    expect(owners(blocks)).toEqual(['K3', 'K3', 'K3']);
    // The finished main turn before it ends at 2: the question's line opens the next one.
    const after = [line('main'), text('Done.'), line('q3'), text('The answer.')];
    expect(owners(after, [2])).toEqual(['', '', 'K3', 'K3']);
  });

  it('a question taken in the turn ANOTHER question started: untagged words stay with that question', () => {
    const blocks = [line('q4'), tool('t1'), line('q3'), text('Still on question four.'), text('[Q3]\nthree')];
    expect(owners(blocks)).toEqual(['K4', 'K4', 'K4', 'K4', 'K3']);
  });

  it('a turn whose start this view never saw: the question claims only its tagged block', () => {
    const blocks = [text('earlier words of the turn'), line('q3'), text('more of the turn'), text('[Q3]\nthree'), text('the end of the turn')];
    expect(owners(blocks)).toEqual([null, null, null, 'K3', null]);
  });

  it('the older rules (no taken line) stop a tag at the next words without one', () => {
    const blocks = [tool('t0'), text('[Q3]\nthree'), tool('t1'), text('Back to the turn.')];
    // Before any words: the first words' tag; after words, none: the turn's own work.
    expect(blockTagKeys(blocks, [], keyBySeq)).toEqual(['K3', 'K3', null, null]);
  });
});

// ── Stored: the rows once the transcript holds the turn ──

type Row = SplitRow & { timestamp?: string };
const user = (msgId: string, t: string): Row => ({ role: 'user', msgId, text: t });
const midTurn = (msgId: string, sourceUuid: string, t: string, seq: number): Row =>
  ({ role: 'user', msgId, sourceUuid, text: t, hints: [{ kind: 'question', arg: String(seq) }] });
const reply = (msgId: string, t: string, extra: Partial<Row> = {}): Row => ({ role: 'assistant', msgId, text: t, ...extra });
const anchor = (msgId: string, parent: string, exact: string): SessionThreadAnchor =>
  ({ msgId, parent, quote: { exact }, source: 'selection', at: '2026-11-03T00:00:00Z' });

function read(rows: Row[], more: SessionThreadAnchor[] = []) {
  const split = splitTaggedReplies(rows);
  const anchors = [anchor('src-q3', 'a0', 'Alpha line.'), ...more];
  const tree = buildThreadTree(split as never, withTagAnchors(split as never, anchors, new Map([[3, 'src-q3']])));
  const key = threadKeyOf(anchors[0]);
  const stats = deriveThreadStats(split as never, (id) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY);
  return { split, tree, key, stats, card: cardTurnsOf(split, tree.byKey.get(key)) };
}

const HEAD = [user('u0', 'Explain the plan.'), reply('a0', 'Alpha line.\nBeta line.')];

describe('stored: a question the CLI took mid-turn', () => {
  it('no tag: the turn keeps its reply, the question reads No answer', () => {
    const { split, tree, key, stats, card } = read([
      ...HEAD,
      user('u1', 'Build the page.'),
      reply('a1', '', { tools: [{ name: 'Bash' }] }),
      midTurn('queue-1', 'src-q3', 'Can a pod use another namespace\'s account?', 3),
      reply('a2', '', { tools: [{ name: 'Bash' }] }),
      reply('a3', 'Revision 4 is built.'),
    ]);
    expect(split.map((r) => r.msgId)).toEqual(['u0', 'a0', 'u1', 'a1', 'a2', 'a3', 'queue-1']);
    expect(tree.byRow.get('a3')?.key).toBe(ROOT_THREAD_KEY);
    expect(tree.byRow.get('queue-1')?.key).toBe(key);
    expect(stats.answered.has('u1')).toBe(true);
    expect(stats.answered.has('src-q3')).toBe(false);
    expect(stats.lastAnswer.get(key)).toBeUndefined();
    expect(stats.turnEnds.get('src-q3')).toBe('silent');
    // Still the newest turn: while it runs, the question waits on it (it may yet write the tag).
    expect([...stats.openMidTurn]).toEqual(['src-q3']);
    expect(card).toHaveLength(1);
    expect(card[0].replies).toEqual([]);
    const live = deriveThreadLiveStates({ tree, queued: [], streamingKey: null, turnEnds: stats.turnEnds, hasAnswerAfter: (id) => stats.answered.has(id) });
    expect(live.get(key)).toBe('failed');
  });

  it('its tag: the tagged part is its answer, the turn\'s reply after it stays the turn\'s', () => {
    const { split, tree, key, stats, card } = read([
      ...HEAD,
      user('u1', 'Build the page.'),
      reply('a1', '', { tools: [{ name: 'Bash' }] }),
      midTurn('queue-1', 'src-q3', 'Can a pod use another namespace\'s account?', 3),
      reply('a2', '[Q3]\nYes, through the pod spec.'),
      reply('a3', '', { tools: [{ name: 'Bash' }] }),
      reply('a4', 'Revision 4 is built.'),
    ]);
    expect(split.map((r) => r.msgId)).toEqual(['u0', 'a0', 'u1', 'a1', 'a3', 'a4', 'queue-1', 'a2']);
    expect(tree.byRow.get('a4')?.key).toBe(ROOT_THREAD_KEY);
    expect(tree.byRow.get('a2')?.key).toBe(key);
    expect(stats.answered.has('src-q3')).toBe(true);
    expect(stats.turnEnds.has('src-q3')).toBe(false);
    expect(card[0].replies.map((r) => r.text)).toEqual(['[Q3]\nYes, through the pod spec.']);
  });

  it('a question asked while idle is its own turn: an untagged reply is still its answer', () => {
    const rows = [...HEAD, { ...user('u2', 'Can a pod use another namespace\'s account?'), hints: [{ kind: 'question', arg: '3' }] }, reply('a2', 'Yes, through the pod spec.')];
    const anchors = [anchor('u2', 'a0', 'Alpha line.')];
    const split = splitTaggedReplies(rows);
    expect(split).toBe(rows);
    const tree = buildThreadTree(split as never, anchors);
    const key = threadKeyOf(anchors[0]);
    expect(tree.byRow.get('a2')?.key).toBe(key);
    const stats = deriveThreadStats(split as never, (id) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY);
    expect(stats.answered.has('u2')).toBe(true);
    expect(stats.turnEnds.has('u2')).toBe(false);
  });

  it('two lines of one question taken in one main turn, untagged: both wait, neither takes the reply', () => {
    const { split, tree, key, stats } = read([
      ...HEAD,
      user('u1', 'Build the page.'),
      reply('a1', '', { tools: [{ name: 'Bash' }] }),
      midTurn('queue-1', 'src-q3', 'Can a pod use another namespace\'s account?', 3),
      reply('a2', '', { tools: [{ name: 'Bash' }] }),
      midTurn('queue-2', 'src-q3b', 'And a job?', 3),
      reply('a3', 'Revision 4 is built.'),
    ], [anchor('src-q3b', 'a0', 'Alpha line.')]);
    expect(split.map((r) => r.msgId)).toEqual(['u0', 'a0', 'u1', 'a1', 'a2', 'a3', 'queue-1', 'queue-2']);
    expect(tree.byRow.get('queue-2')?.key).toBe(key);
    expect(tree.byRow.get('a3')?.key).toBe(ROOT_THREAD_KEY);
    expect(tree.byRow.get('queue-1')?.key).toBe(key);
    expect(stats.turnEnds.get('src-q3')).toBe('silent');
    expect(stats.turnEnds.get('src-q3b')).toBe('silent');
    // A later turn of the main conversation: no longer open.
    const later = deriveThreadStats([...split, user('u9', 'Next.'), reply('a9', 'ok')] as never, (id) => tree.byRow.get(id ?? '')?.key ?? ROOT_THREAD_KEY);
    expect(later.openMidTurn.size).toBe(0);
  });

  it('a follow-up of the question the turn answers, taken mid-turn, stays in that turn', () => {
    const rows = [
      ...HEAD,
      { ...user('u2', 'Can a pod use another namespace\'s account?'), hints: [{ kind: 'question', arg: '3' }] },
      reply('a2', '', { tools: [{ name: 'Bash' }] }),
      midTurn('queue-2', 'src-f3', 'And a job?', 3),
      reply('a3', 'Yes for both.'),
    ];
    expect(splitTaggedReplies(rows)).toBe(rows);
  });
});
