/**
 * accumulatorAfterSnapshot (web/src/stream/stream-reducer.ts): the text accumulator a column
 * holds once it adopts a stream snapshot. A column opened mid-reply adopts the snapshot at React's
 * next render; the accumulator must then hold the reply's text so far, or the reply's next delta
 * writes only itself over it (2026-11-10: the head of a reply vanished until its saved row came).
 */
import { describe, it, expect } from 'vitest';
import { accumulatorAfterSnapshot, type StreamingBlock } from '@/stream/stream-reducer';

const head = '## Findings\n\nThe check ra';
const blocks: StreamingBlock[] = [
  { type: 'text', content: 'Let me check.', msgId: 'm1' },
  { type: 'tool_call', toolUseId: 't1', name: 'Bash', input: {}, status: 'done', result: 'ok' },
  { type: 'text', content: head, msgId: 'm2' },
];

describe('accumulatorAfterSnapshot', () => {
  it('a column that opened mid-reply holds the reply so far', () => {
    expect(accumulatorAfterSnapshot({ blocks, completedLen: 0, atSnapshot: { buffer: '' }, now: { buffer: '' }, cut: false }))
      .toEqual({ buffer: head, msgId: 'm2' });
  });

  it('keeps a delta that arrived after the snapshot and before it was adopted', () => {
    expect(accumulatorAfterSnapshot({ blocks, completedLen: 0, atSnapshot: { buffer: '' }, now: { buffer: 'n bun', msgId: 'm2' }, cut: false }))
      .toEqual({ buffer: `${head}n bun`, msgId: 'm2' });
  });

  it('drops text that arrived before the snapshot: the snapshot holds it', () => {
    const at = { buffer: 'The check ra', msgId: 'm2' };
    expect(accumulatorAfterSnapshot({ blocks, completedLen: 0, atSnapshot: at, now: { buffer: 'The check ran', msgId: 'm2' }, cut: false }))
      .toEqual({ buffer: `${head}n`, msgId: 'm2' });
  });

  it('a first delta that names the snapshot\'s message appends to it, counted once', () => {
    expect(accumulatorAfterSnapshot({ blocks, completedLen: 0, atSnapshot: { buffer: 'ra' }, now: { buffer: 'ran', msgId: 'm2' }, cut: false }))
      .toEqual({ buffer: `${head}n`, msgId: 'm2' });
  });

  it('leaves the accumulator alone when a newer message took it over', () => {
    expect(accumulatorAfterSnapshot({ blocks, completedLen: 0, atSnapshot: { buffer: '' }, now: { buffer: 'next', msgId: 'm3' }, cut: false }))
      .toBeNull();
  });

  it('leaves the accumulator alone when a card, a boundary or the turn\'s end cut it after the snapshot', () => {
    expect(accumulatorAfterSnapshot({ blocks, completedLen: 0, atSnapshot: { buffer: '' }, now: { buffer: '' }, cut: true }))
      .toBeNull();
    expect(accumulatorAfterSnapshot({ blocks, completedLen: 0, atSnapshot: { buffer: 'abc', msgId: 'm2' }, now: { buffer: '<', msgId: 'm2' }, cut: false }))
      .toBeNull();
  });

  it('nothing after the snapshot: its live text, whatever message the accumulator named before', () => {
    expect(accumulatorAfterSnapshot({ blocks, completedLen: 0, atSnapshot: { buffer: '', msgId: 'm1' }, now: { buffer: '', msgId: 'm1' }, cut: false }))
      .toEqual({ buffer: head, msgId: 'm2' });
  });

  it('never seeds from a finished turn', () => {
    expect(accumulatorAfterSnapshot({ blocks, completedLen: blocks.length, atSnapshot: { buffer: 'old', msgId: 'm2' }, now: { buffer: 'old', msgId: 'm2' }, cut: false }))
      .toEqual({ buffer: '', msgId: undefined });
  });

  it('an empty snapshot leaves the text the column already received', () => {
    expect(accumulatorAfterSnapshot({ blocks: [], completedLen: 0, atSnapshot: { buffer: 'See the', msgId: 'm9' }, now: { buffer: 'See the plan', msgId: 'm9' }, cut: false }))
      .toBeNull();
  });

  it('events with no ids (legacy) append to the snapshot\'s text', () => {
    const legacy: StreamingBlock[] = [{ type: 'text', content: 'abc' }];
    expect(accumulatorAfterSnapshot({ blocks: legacy, completedLen: 0, atSnapshot: { buffer: '' }, now: { buffer: 'd' }, cut: false }))
      .toEqual({ buffer: 'abcd', msgId: undefined });
  });
});
