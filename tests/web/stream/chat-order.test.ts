/**
 * web/src/stream/chat-order.ts: where a sent message sits in a live chat, and
 * which question the words after it answer.
 *
 * 2026-10-31 (the user, Ask here card): "my own input jumped above the answer".
 * A background agent kept one turn open across several CLI turns, so every
 * follow-up bubble was drawn before the live answer; and the answer to a line
 * typed in the main conversation opened with the `[Q6]` tag the model saw last,
 * so every main-chat answer was filed under question 6.
 */
import { describe, it, expect } from 'vitest';
import { bubbleIndexOf, cardLiveRounds, liveLineOwners, splitQueuedTail, takenLinesOf } from '@/stream/chat-order';
import { appendUserLineBlock, lastMainLaneText, type StreamingBlock, type StreamingUserLineBlock } from '@/stream/stream-reducer';
import { computeAbsorbedIndices } from '@/cache/promote-blocks';
import type { SessionHistoryMessage } from '@/types/session';

const text = (content: string, extra: Partial<Extract<StreamingBlock, { type: 'text' }>> = {}): StreamingBlock => ({ type: 'text', content, ...extra });
const line = (uuid: string, rowIds?: string[]): StreamingBlock => ({ type: 'user_line', uuid, ...(rowIds ? { rowIds } : {}) });
const tool = (id: string): StreamingBlock => ({ type: 'tool_call', toolUseId: id, name: 'Bash', input: {}, status: 'done' });
const notice = (): StreamingBlock => ({ type: 'system', variant: 'info', message: 'note' });

describe('bubbleIndexOf: a bubble sits where its line was taken', () => {
  const blocks = [text('A1 part'), line('uF'), text('A2')];
  const lines = takenLinesOf(blocks);

  it('a taken line: at its marker, by the uuid it was sent under', () => {
    expect(bubbleIndexOf({ userUuid: 'uF', status: 'delivered' }, lines, blocks.length, 0)).toBe(1);
  });

  it('a send with no uuid of its own: at the marker that lists its queue row', () => {
    const b2 = [text('A1'), line('derived-1', ['qm-7']), text('reply to the main line')];
    expect(bubbleIndexOf({ queueId: 'qm-7', status: 'delivered' }, takenLinesOf(b2), b2.length, 0)).toBe(1);
  });

  it('not taken yet: after all live output, never at the block count it was sent at', () => {
    expect(bubbleIndexOf({ userUuid: 'uG', status: 'delivered' }, lines, blocks.length, 1)).toBe(3);
    expect(bubbleIndexOf({ status: 'pending' }, lines, blocks.length, 0)).toBe(3);
  });

  it('a stream that reports no taken lines keeps the send-time place (older CLI, ACP)', () => {
    const plain = [text('a'), text('b')];
    expect(bubbleIndexOf({ userUuid: 'x', status: 'delivered' }, takenLinesOf(plain), 2, 1)).toBe(1);
    expect(bubbleIndexOf({ userUuid: 'x', status: 'delivered' }, takenLinesOf(plain), 2, undefined)).toBe(2);
    expect(bubbleIndexOf({ status: 'received' }, takenLinesOf(plain), 2, 0)).toBe(2);
  });
});

describe('liveLineOwners: the question the words after a taken line answer', () => {
  // q6 = question 6 asked in the card; main = a line typed in the main conversation.
  const known: Record<string, { key: string; seqs: number[] }> = {
    q6: { key: 'K6', seqs: [6] },
    q7: { key: 'K7', seqs: [7] },
    main: { key: '', seqs: [] },
  };
  const keyOf = (l: StreamingUserLineBlock) => known[l.uuid]?.key ?? null;
  const seqsOf = (l: StreamingUserLineBlock) => known[l.uuid]?.seqs ?? null;
  const keyBySeq: Record<number, string> = { 6: 'K6', 7: 'K7' };
  const tagOf = (b: StreamingBlock) => {
    const m = b.type === 'text' ? /^\[Q(\d+)\]/.exec(b.content) : null;
    return m && keyBySeq[Number(m[1])] ? { key: keyBySeq[Number(m[1])], seq: Number(m[1]) } : null;
  };
  const owners = (blocks: StreamingBlock[]) => liveLineOwners(blocks, takenLinesOf(blocks), keyOf, seqsOf, tagOf);

  it('the 2026-10-31 shape: a main-chat line answered with an echoed [Q6] stays in the main conversation', () => {
    const blocks = [line('q6'), text('[Q6] the answer'), line('main'), text('[Q6] right, in short')];
    expect(owners(blocks)).toEqual(['K6', 'K6', '', '']);
  });

  it('after a question line, the tag files the words (the model may answer an earlier question too)', () => {
    const blocks = [line('q6'), tool('t1'), line('q7'), text('ROOT-DONE'), text('[Q6] six'), text('[Q7] seven')];
    expect(owners(blocks)).toEqual(['K6', 'K6', 'K7', 'K7', 'K6', 'K7']);
  });

  it('lines drained together are one run: a main line in it does not close its own question', () => {
    const blocks = [line('main'), notice(), line('q7'), text('[Q7] answer')];
    expect(owners(blocks)).toEqual(['', '', 'K7', 'K7']);
  });

  it('a line this view knows nothing of: its tag is the best word there is', () => {
    const blocks = [line('other-device'), text('[Q7] answer'), text('more')];
    expect(owners(blocks)).toEqual([null, 'K7', 'K7']);
  });

  it('blocks before the first marker and a stream without markers are left to the older rules', () => {
    expect(owners([text('before'), line('q6'), text('x')])).toEqual([null, 'K6', 'K6']);
    expect(owners([text('[Q6] x')])).toEqual([null]);
  });

  it('a turn with no taken line of its own (a follow-up for background work) answers no line', () => {
    const blocks = [line('q6'), text('[Q6] answer'), text('the background agent finished')];
    const ends = [2]; // the first turn ended after its answer
    expect(liveLineOwners(blocks, takenLinesOf(blocks), keyOf, seqsOf, tagOf, ends)).toEqual(['K6', 'K6', null]);
  });

  it('subagent-lane text never moves the owner', () => {
    const blocks = [line('main'), text('[Q6] lane words', { parentToolUseId: 'agent-1' }), text('main answer')];
    expect(owners(blocks)).toEqual(['', '', '']);
  });
});

describe('cardLiveRounds: a question card\'s live part in the chat\'s order', () => {
  it('a follow-up sent while the answer streams sits below that answer (the screenshot)', () => {
    // Timeline: live answer to the persisted question, then two follow-ups not taken yet.
    const r = cardLiveRounds<string, string>([{ block: 'A1' }, { user: 'FU1' }, { user: 'FU2' }]);
    expect(r.lead).toBe('A1');
    expect(r.rounds).toEqual([{ bubble: 'FU1' }, { bubble: 'FU2' }]);
  });

  it('each follow-up takes the newest live text after it and before the next one', () => {
    const r = cardLiveRounds<string, string>([{ user: 'FU1' }, { block: 'step' }, { block: 'A(FU1)' }, { user: 'FU2' }, { block: 'A(FU2)' }]);
    expect(r.lead).toBeUndefined();
    expect(r.rounds).toEqual([{ bubble: 'FU1', live: 'A(FU1)' }, { bubble: 'FU2', live: 'A(FU2)' }]);
  });
});

describe('the taken-line marker in the stream', () => {
  it('is appended once per uuid with its row ids, and ends the text the model was writing', () => {
    let blocks: StreamingBlock[] = [text('before')];
    blocks = appendUserLineBlock(blocks, 'u1', ['qm-1']);
    expect(appendUserLineBlock(blocks, 'u1', ['qm-1'])).toBe(blocks);
    expect(blocks[1]).toEqual({ type: 'user_line', uuid: 'u1', rowIds: ['qm-1'] });
    // Words after the marker are a new message, never merged into the one before it.
    expect(lastMainLaneText(blocks, 0)).toBeUndefined();
  });

  it('is absorbed by the persisted user row of its line (its uuid, or the sent uuid of a queue row)', () => {
    const blocks: StreamingBlock[] = [line('u1'), text('reply'), line('src-1'), line('not-yet')];
    const delta = [
      { role: 'user', text: 'one', msgId: 'u1', timestamp: '' },
      { role: 'assistant', text: 'reply', msgId: 'a1', timestamp: '' },
      { role: 'user', text: 'two', msgId: 'queue-1', sourceUuid: 'src-1', timestamp: '' },
    ] as SessionHistoryMessage[];
    const { absorbed } = computeAbsorbedIndices(blocks, delta, 3);
    expect(absorbed.has(0)).toBe(true);
    expect(absorbed.has(2)).toBe(true);
    expect(absorbed.has(3)).toBe(false);
  });
});

describe('splitQueuedTail', () => {
  it('splits the trailing still-queued rows off and keeps the array when there are none', () => {
    const rows = [{ t: 'a' }, { t: 'b', queued: true }, { t: 'c', queued: true }];
    const out = splitQueuedTail(rows);
    expect(out.rows.map((r) => r.t)).toEqual(['a']);
    expect(out.queued.map((r) => r.t)).toEqual(['b', 'c']);
    const none = [{ t: 'a' }];
    expect(splitQueuedTail(none).rows).toBe(none);
  });
});
