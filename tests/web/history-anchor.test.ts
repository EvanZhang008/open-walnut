/**
 * The client half of the identity-anchored history delta (inc-1785993576822).
 *
 * The anchor must be the NEWEST message whose msgId is unique in the client's own
 * array. Uniqueness matters on both sides: the server rebuilds when an anchor id
 * appears twice in its parse, so proposing a duplicate would force a full payload
 * every single turn on any session that has tool rows (i.e. all of them).
 */
import { describe, it, expect } from 'vitest';
import { computeHistoryAnchor, applyRevisedMessages, collectUnsettledIds } from '@/hooks/history-anchor';

const m = (msgId?: string) => ({ msgId });

describe('computeHistoryAnchor', () => {
  it('picks the newest message and reports zero trailing rows', () => {
    expect(computeHistoryAnchor([m('a'), m('b'), m('c')]))
      .toEqual({ anchorMsgId: 'c', anchorTail: 0 });
  });

  it('skips id-less trailing rows and counts them', () => {
    // Pattern-B synthetic user rows and compact boundaries can lack an id.
    expect(computeHistoryAnchor([m('a'), m('b'), m(undefined), m(undefined)]))
      .toEqual({ anchorMsgId: 'b', anchorTail: 2 });
  });

  it('skips a DUPLICATED newest id — it would force a rebuild every turn', () => {
    // 'c' tags two rows (an assistant message and its tool row), so the server
    // would call it ambiguous. Fall back to the newest unique id instead.
    expect(computeHistoryAnchor([m('a'), m('b'), m('c'), m('c')]))
      .toEqual({ anchorMsgId: 'b', anchorTail: 2 });
  });

  it('returns no anchor when nothing is uniquely identified', () => {
    expect(computeHistoryAnchor([m('d'), m('d'), m(undefined)]))
      .toEqual({ anchorTail: 0 });
    expect(computeHistoryAnchor([])).toEqual({ anchorTail: 0 });
  });

  it('anchor + tail always reconstructs the client length', () => {
    // (assertion body below)
    // The server computes start = index(anchor) + 1 + anchorTail. That only lines up
    // if tail counts EVERY row after the anchor — assert the arithmetic directly.
    const msgs = [m('a'), m('b'), m('c'), m(undefined), m('c')];
    const { anchorMsgId, anchorTail } = computeHistoryAnchor(msgs);
    expect(anchorMsgId).toBe('b');
    const idx = msgs.findIndex(x => x.msgId === anchorMsgId);
    expect(idx + 1 + anchorTail).toBe(msgs.length);
  });
});

describe('collectUnsettledIds', () => {
  it('collects the ids the server flagged, newest first', () => {
    const msgs = [
      { msgId: 'a' },
      { msgId: 'b', unsettled: true },
      { msgId: 'c' },
      { msgId: 'd', unsettled: true },
    ];
    expect(collectUnsettledIds(msgs)).toEqual(['d', 'b']);
  });

  it('is empty once every row is settled — the request self-terminates', () => {
    // This is what stops the client re-asking forever: the flag disappears with the
    // corrected row, so the next delta carries no revise= at all.
    expect(collectUnsettledIds([{ msgId: 'a' }, { msgId: 'b' }])).toEqual([]);
  });

  it('skips a flagged row with no msgId (unaddressable)', () => {
    expect(collectUnsettledIds([{ unsettled: true }, { msgId: 'b', unsettled: true }])).toEqual(['b']);
  });

  it('caps the request — the server refuses larger ones', () => {
    const msgs = Array.from({ length: 50 }, (_, i) => ({ msgId: `m${i}`, unsettled: true }));
    expect(collectUnsettledIds(msgs, 20)).toHaveLength(20);
    // Newest first, so we keep asking about the rows most likely to still matter.
    expect(collectUnsettledIds(msgs, 20)[0]).toBe('m49');
  });
});

describe('applyRevisedMessages', () => {
  it('THE FIX: a late bgTaskFinished reaches the row the client already holds', () => {
    // The row was synced while the agent still ran; the flag landed 74s later. Under
    // the old append-only contract this row was never re-read, so its lane blocks
    // had no absorption proof and a phantom Agent box sat at the bottom forever.
    const base = [
      { msgId: 'm0', tools: [{ toolUseId: 't0', bgTaskFinished: true }] },
      { msgId: 'm1', tools: [{ toolUseId: 't1' }] },
      { msgId: 'm2' },
    ];
    const out = applyRevisedMessages(base, [
      { msgId: 'm1', tools: [{ toolUseId: 't1', bgTaskFinished: true }] },
    ]);
    expect(out[1].tools?.[0].bgTaskFinished).toBe(true);
    // Replacement is IN PLACE — position and length must not move, or every
    // index-keyed consumer (and the cursor) breaks.
    expect(out).toHaveLength(3);
    expect(out.map(m => m.msgId)).toEqual(['m0', 'm1', 'm2']);
  });

  it('returns the SAME array reference when nothing applies (no re-render)', () => {
    const base = [{ msgId: 'a' }];
    expect(applyRevisedMessages(base, undefined)).toBe(base);
    expect(applyRevisedMessages(base, [])).toBe(base);
    expect(applyRevisedMessages(base, [{ msgId: 'nope' }])).toBe(base);
  });

  it('ignores a revision for an msgId we hold more than once', () => {
    // Applying it to both rows would corrupt one of them; applying to "the right
    // one" would be a guess. The server already refuses to send these.
    const base = [{ msgId: 'dup', tools: [] }, { msgId: 'dup', tools: [] }];
    expect(applyRevisedMessages(base, [{ msgId: 'dup', tools: [{ toolUseId: 'x' }] }])).toBe(base);
  });

  it('never appends — a revision cannot add rows', () => {
    const base = [{ msgId: 'a' }, { msgId: 'b' }];
    const out = applyRevisedMessages(base, [{ msgId: 'a' }, { msgId: 'zzz' }, { msgId: 'b' }]);
    expect(out).toHaveLength(2);
  });

  it('ignores a revision identical to what we hold (no pointless re-render)', () => {
    // A tool whose result never lands (session killed mid-call) stays unsettled
    // forever, so we keep asking and the server keeps answering with the same row.
    // Adopting it every turn would hand React a fresh array and re-render the whole
    // history for nothing.
    const base = [{ msgId: 'a', unsettled: true, tools: [{ toolUseId: 't', result: undefined }] }];
    expect(applyRevisedMessages(base, [
      { msgId: 'a', unsettled: true, tools: [{ toolUseId: 't', result: undefined }] },
    ])).toBe(base);
  });

  it('still adopts a revision whose result finally landed', () => {
    const base = [{ msgId: 'a', unsettled: true, tools: [{ toolUseId: 't' }] }];
    const out = applyRevisedMessages(base, [
      { msgId: 'a', tools: [{ toolUseId: 't', result: 'done' }] },
    ]);
    expect(out).not.toBe(base);
    expect(out[0].tools?.[0].result).toBe('done');
  });
});
