/**
 * The quick bar's receipts (web/src/components/quickbar/useQuickReceipts.ts): each answer line of
 * a send moves its receipt on, a failure before the send answered means nothing went out, a
 * failure after it only lost the reply, and nothing moves a finished receipt again.
 */
import { describe, it, expect } from 'vitest';
import { applyLine, endStream, staysUntilDismissed, type Receipt } from '../../web/src/components/quickbar/useQuickReceipts';
import { receiptStatus } from '../../web/src/components/quickbar/QuickBarReceipts';

const base: Receipt = { id: 'r1', person: { id: 'v1', title: 'Walnut VP', kind: 'vp' }, text: 'ship it', images: [], state: 'sending', reply: '' };

describe('applyLine', () => {
  it('walks sending, delivered, thinking, replied', () => {
    let r = applyLine(base, { type: 'sent', taskId: 'v1', sessionId: 's1', started: false });
    expect([r.state, r.taskId, receiptStatus(r)]).toEqual(['sent', 'v1', 'Sent · in its queue']);
    r = applyLine(r, { type: 'delivered' });
    expect([r.state, receiptStatus(r)]).toEqual(['delivered', 'Delivered']);
    r = applyLine(r, { type: 'activity', detail: 'Read notes.md' });
    expect(receiptStatus(r)).toBe('Working · Read notes.md');
    r = applyLine(r, { type: 'text', delta: 'On it, ' });
    r = applyLine(r, { type: 'text', delta: 'shipping now.' });
    expect([r.state, r.reply, receiptStatus(r)]).toEqual(['thinking', 'On it, shipping now.', 'Replying…']);
    r = applyLine(r, { type: 'result', text: '' }, 5);
    expect([r.state, r.reply, r.endedAt]).toEqual(['replied', 'On it, shipping now.', 5]);
    // Finished: later lines and the stream's end change nothing.
    expect(applyLine(r, { type: 'text', delta: 'more' })).toBe(r);
    expect(endStream(r)).toBe(r);
  });

  it('a reset drops the words shown so far (the reply came in the next turn)', () => {
    const r = applyLine(applyLine({ ...base, state: 'sent' }, { type: 'text', delta: 'earlier turn' }), { type: 'reset' });
    expect(r.reply).toBe('');
  });

  it('tells a send that never went out from a reply lost after it went', () => {
    const failed = applyLine(base, { type: 'error', code: 'network', message: 'Walnut could not be reached. Nothing was sent.' });
    expect(failed.state).toBe('failed');
    expect(receiptStatus(failed)).toMatch(/^Not sent/);
    const lost = applyLine({ ...base, state: 'sent', taskId: 'v1' }, { type: 'error', code: 'follow_lost', message: 'Lost the reply on the way. It is in the chat.' });
    expect(lost.state).toBe('lost');
    expect(receiptStatus(lost)).toMatch(/^Sent · Lost the reply/);
    expect(endStream(base).state).toBe('failed');
    expect(endStream({ ...base, state: 'thinking' }).state).toBe('lost');
  });

  it('a held send says it waits on the answer in its chat', () => {
    const r = applyLine(base, { type: 'held', taskId: 'v1', sessionId: 's1', started: false });
    expect([r.state, r.taskId]).toEqual(['held', 'v1']);
    expect(receiptStatus(r)).toMatch(/waits on your answer/);
  });

  it('words that never went out stay until put back or dismissed; every other end leaves', () => {
    // Every state a receipt can end in, named here so a new one must say which side it is on.
    const ends: Record<string, boolean> = { failed: true, held: true, replied: false, lost: false }
    for (const [state, stays] of Object.entries(ends)) expect(staysUntilDismissed({ state: state as Receipt['state'] }), state).toBe(stays)
    // A stream that ended before the send answered: nothing went out, so it stays.
    expect(staysUntilDismissed(endStream(base))).toBe(true)
  });
});
