/**
 * The quick bar's receipts (web/src/components/quickbar/useQuickReceipts.ts): each answer line of
 * a send moves its receipt on, a failure before the send answered means nothing went out, a
 * failure after it only lost the reply, and nothing moves a finished receipt again.
 *
 * 2026-11-22 (the user, of a receipt that said "Not sent · Walnut could not be reached" and
 * stayed: "why there is no x so that i cna close"): a send that never reached Walnut waits for
 * it and goes out by itself under the same user line; its × only hides the card.
 */
import { describe, it, expect } from 'vitest';
import {
  applyLine, endStream, expireWaiting, KEPT_RECEIPTS_KEY, keptOverReload, keptSignature, mayHaveGoneOut, nextCheckDelay, resentNow, restoreKeptReceipts,
  settleHidden, settleReceipts, staysUntilDismissed, writeKeptReceipts, type Receipt,
} from '../../web/src/components/quickbar/useQuickReceipts';
import { receiptStatus, receiptTone } from '../../web/src/components/quickbar/QuickBarReceipts';
import { AUTO_RETRY_MAX, AUTO_RETRY_MAX_AGE_MS } from '../../web/src/hooks/send-auto-retry';

const base: Receipt = { id: 'r1', person: { id: 'v1', title: 'Walnut VP', kind: 'vp' }, text: 'ship it', images: [], state: 'sending', reply: '' };

describe('applyLine', () => {
  it('a line sent out of a focus space ends at Sent, its reply left in its chat', () => {
    let r = applyLine(base, { type: 'sent', taskId: 'v1', sessionId: 's1', started: false });
    r = applyLine(r, { type: 'kept', reason: 'outside_focus' }, 1000);
    expect(r).toMatchObject({ state: 'lost', error: 'its reply waits outside your focus', endedAt: 1000 });
    expect(receiptStatus(r)).toBe('Sent · its reply waits outside your focus');
  });

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
    const failed = applyLine(base, { type: 'error', code: 'network', message: 'Walnut could not be reached.' });
    expect(failed.state).toBe('failed');
    expect(receiptStatus(failed)).toBe('Not sent · Walnut could not be reached.');
    const lost = applyLine({ ...base, state: 'sent', taskId: 'v1' }, { type: 'error', code: 'follow_lost', message: 'Lost the reply on the way. It is in the chat.' });
    expect(lost.state).toBe('lost');
    expect(receiptStatus(lost)).toMatch(/^Sent · Lost the reply/);
    expect(endStream({ ...base, state: 'thinking' }).state).toBe('lost');
  });

  it('an answer that broke off or ended before its sent line never claims nothing was sent', () => {
    // A send with no user line of its own (an older page) cannot go out by itself: it fails, unconfirmed.
    const broke = applyLine(base, { type: 'error', code: 'follow_lost', message: 'Lost the reply on the way. It is in the chat.' }, 7);
    expect(broke).toMatchObject({ state: 'failed', failCode: 'follow_lost', endedAt: 7 });
    expect(mayHaveGoneOut(broke)).toBe(true);
    expect(receiptStatus(broke)).toBe('Not confirmed · its answer broke off before Walnut said it was sent');
    const ended = endStream(base, 9);
    expect(ended).toMatchObject({ state: 'failed', failCode: 'no_answer', endedAt: 9 });
    expect(receiptStatus(ended)).toBe('Not confirmed · Walnut ended its answer before saying it was sent');
    expect(receiptStatus(ended)).not.toMatch(/Nothing was sent/);
    // An answer Walnut gave is what it says.
    expect(mayHaveGoneOut(applyLine(base, { type: 'error', code: 'send_failed', message: 'spawn failed' }))).toBe(false);
  });

  it('a held send says it waits on the answer in its chat', () => {
    const r = applyLine(base, { type: 'held', taskId: 'v1', sessionId: 's1', started: false });
    expect([r.state, r.taskId]).toEqual(['held', 'v1']);
    expect(receiptStatus(r)).toMatch(/waits on your answer/);
  });

  it('words that never went out stay until put back or dismissed; every other end leaves', () => {
    // Every state a receipt can end in, named here so a new one must say which side it is on.
    const ends: Record<string, boolean> = { failed: true, held: true, waiting: true, replied: false, lost: false }
    for (const [state, stays] of Object.entries(ends)) expect(staysUntilDismissed({ state: state as Receipt['state'] }), state).toBe(stays)
    // A stream that ended before the send answered: nothing went out, so it stays.
    expect(staysUntilDismissed(endStream(base))).toBe(true)
  });
});

describe('a send that never reached Walnut waits for it and goes out by itself', () => {
  const T0 = 1_795_000_000_000;
  const net = { type: 'error' as const, code: 'network', message: 'Walnut could not be reached.' };
  const mine: Receipt = { ...base, userUuid: '2d0e9f8a-3b4c-4d5e-9f0a-1b2c3d4e5f60', sentAt: T0, autoTries: 0 };

  it('waits, in words that say it sends when Walnut is back, on the live dot, never timed out of sight', () => {
    const r = applyLine(mine, net, T0 + 100);
    expect(r).toMatchObject({ state: 'waiting', failCode: 'network' });
    expect(r.endedAt).toBeUndefined();
    expect(receiptStatus(r)).toBe('Waiting for Walnut · sends when it is back');
    expect(receiptTone(r)).toBe('live');
    // No answer is open while it waits: a late line of the old try or its end changes nothing.
    expect(applyLine(r, { type: 'sent', taskId: 'v1', sessionId: 's1', started: false })).toBe(r);
    expect(endStream(r)).toBe(r);
  });

  it('a try sent by itself counts; past AUTO_RETRY_MAX tries it is an ordinary failure with Send again', () => {
    let r = applyLine(mine, net, T0);
    for (let i = 1; i <= AUTO_RETRY_MAX; i++) {
      r = resentNow(r, true);
      expect([r.state, r.autoTries]).toEqual(['sending', i]);
      r = applyLine(r, net, T0 + i * 1000);
    }
    expect(r.state).toBe('failed');
    expect(receiptStatus(r)).toBe('Not sent · Walnut could not be reached.');
    // The person's Send again is not one of the tries.
    expect(resentNow(applyLine(mine, net, T0), false).autoTries).toBe(0);
  });

  it('then it goes out: Sent, Delivered, Replied, and leaves as any receipt does', () => {
    let r = resentNow(applyLine(mine, net, T0), true);
    r = applyLine(r, { type: 'sent', taskId: 'v1', sessionId: 's1', started: false });
    r = applyLine(r, { type: 'delivered' });
    r = applyLine(r, { type: 'result', text: 'Done.' }, T0 + 5000);
    expect([r.state, r.endedAt]).toEqual(['replied', T0 + 5000]);
    expect(staysUntilDismissed(r)).toBe(false);
  });

  it('older than ten minutes it is no longer sent by itself: an ordinary failure, shown', () => {
    const r = applyLine(mine, net, T0);
    expect(expireWaiting(r, T0 + AUTO_RETRY_MAX_AGE_MS - 1)).toBe(r);
    const old = expireWaiting({ ...r, hidden: true }, T0 + AUTO_RETRY_MAX_AGE_MS);
    expect(old).toMatchObject({ state: 'failed', hidden: false });
    // A failure that comes after the ten minutes never waits either.
    expect(applyLine(mine, net, T0 + AUTO_RETRY_MAX_AGE_MS).state).toBe('failed');
  });

  it('only a connection failure waits, and only a send with its own user line', () => {
    expect(applyLine(mine, { type: 'error', code: 'http_409', message: 'A test run never writes into a VP or router chat' }).state).toBe('failed');
    expect(applyLine(base, net).state).toBe('failed');
  });

  it('its × hides it while it waits or sends; it comes back only when the words did not go out', () => {
    const waiting = { ...applyLine(mine, net, T0), hidden: true };
    expect(settleHidden(waiting)).toBe(waiting);
    expect(settleHidden({ ...resentNow(waiting, true) })?.hidden).toBe(true);
    // Went out: gone, nothing to show.
    expect(settleHidden(applyLine(resentNow(waiting, true), { type: 'sent', taskId: 'v1', sessionId: 's1', started: false }))).toBeNull();
    // Failed for good, or held behind a prompt: back on screen, with its words.
    const back = settleHidden({ ...waiting, state: 'failed', endedAt: T0 });
    expect(back).toMatchObject({ state: 'failed', hidden: false, text: 'ship it' });
    expect(settleHidden({ ...waiting, state: 'held' })?.hidden).toBe(false);
  });

  it('the list never drops a send still on its way to make room', () => {
    const done = (id: string): Receipt => ({ ...base, id, state: 'replied', endedAt: T0 });
    const waiting = { ...applyLine({ ...mine, id: 'w' }, net, T0), hidden: true };
    const list = settleReceipts([done('a'), done('b'), done('c'), done('d'), done('e'), waiting]);
    expect(list.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'w']);
  });

  it('every answer Walnut never confirmed waits the same way: fetch failed, broke off, ended before sent', () => {
    const broke = { type: 'error' as const, code: 'follow_lost', message: 'Lost the reply on the way. It is in the chat.' };
    for (const r of [applyLine(mine, net, T0), applyLine(mine, broke, T0), endStream(mine, T0)]) {
      expect(r.state, r.failCode).toBe('waiting');
      expect(r.endedAt).toBeUndefined();
      expect(receiptStatus(r)).toBe('Waiting for Walnut · sends when it is back');
    }
    // Out of tries, the last one's words: unconfirmed, never "Not sent".
    let r = applyLine(mine, broke, T0);
    for (let i = 1; i <= AUTO_RETRY_MAX; i++) r = endStream(resentNow(r, true), T0 + i);
    expect(r).toMatchObject({ state: 'failed', failCode: 'no_answer' });
    expect(receiptStatus(r)).toMatch(/^Not confirmed · /);
    // A refusal Walnut answered never waits.
    expect(applyLine(mine, { type: 'error', code: 'send_failed', message: 'spawn failed' }, T0).state).toBe('failed');
  });

  it('asks whether Walnut answers again at 2 s, 4 s, 8 s, then every 15 s', () => {
    expect([0, 1, 2, 3, 4, 10].map(nextCheckDelay)).toEqual([2_000, 4_000, 8_000, 15_000, 15_000, 15_000]);
  });
});

describe('words that have not gone out come back after a reload of the page', () => {
  const T0 = 1_795_000_000_000;
  const uuid = '2d0e9f8a-3b4c-4d5e-9f0a-1b2c3d4e5f60';
  const mine: Receipt = { ...base, userUuid: uuid, sentAt: T0, autoTries: 1 };
  const store = () => {
    const m = new Map<string, string>();
    return { m, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  };

  it('keeps every send not known to have gone out, and nothing else', () => {
    const ends: Record<Receipt['state'], boolean> = {
      sending: true, waiting: true, failed: true, held: true, sent: false, delivered: false, thinking: false, replied: false, lost: false,
    };
    for (const [state, kept] of Object.entries(ends)) expect(keptOverReload({ state: state as Receipt['state'] }), state).toBe(kept);
  });

  it('a waiting one comes back waiting, with its line, its tries and its first try, so the ten minutes still count', () => {
    const s = store();
    const waiting: Receipt = { ...mine, state: 'waiting', failCode: 'network', error: 'Walnut could not be reached.', hidden: true };
    writeKeptReceipts([waiting, { ...base, id: 'done', state: 'replied', endedAt: T0 }], s);
    const back = restoreKeptReceipts(s.m.get(KEPT_RECEIPTS_KEY) ?? null, T0 + 60_000);
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ id: 'r1', state: 'waiting', userUuid: uuid, sentAt: T0, autoTries: 1, hidden: true, text: 'ship it' });
    expect(expireWaiting(back[0], T0 + AUTO_RETRY_MAX_AGE_MS)).toMatchObject({ state: 'failed', hidden: false });
  });

  it('one the reload cut off while sending is not confirmed: it waits under its own line', () => {
    const s = store();
    writeKeptReceipts([mine], s);
    const [back] = restoreKeptReceipts(s.m.get(KEPT_RECEIPTS_KEY) ?? null, T0 + 1_000);
    expect(back).toMatchObject({ state: 'waiting', userUuid: uuid, failCode: 'no_answer' });
    // Too old to go out by itself: an ordinary failure, unconfirmed, with its words.
    const [old] = restoreKeptReceipts(s.m.get(KEPT_RECEIPTS_KEY) ?? null, T0 + AUTO_RETRY_MAX_AGE_MS);
    expect(old).toMatchObject({ state: 'failed', text: 'ship it' });
    expect(receiptStatus(old)).toMatch(/^Not confirmed · the page reloaded/);
  });

  it('a failed one comes back as it was; nothing left to keep clears the key', () => {
    const s = store();
    const failed: Receipt = { ...mine, state: 'failed', failCode: 'http_409', error: 'Refused', endedAt: T0, open: true };
    writeKeptReceipts([failed], s);
    const { open: _open, ...stored } = failed;
    expect(restoreKeptReceipts(s.m.get(KEPT_RECEIPTS_KEY) ?? null)).toEqual([stored]);
    writeKeptReceipts([], s);
    expect(s.m.has(KEPT_RECEIPTS_KEY)).toBe(false);
  });

  it('over the storage quota the words are kept without their pictures, and never go out by themselves', () => {
    const m = new Map<string, string>();
    const tight = { setItem: (k: string, v: string) => { if (v.includes('data:big')) throw new Error('QuotaExceededError'); m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
    writeKeptReceipts([{ ...mine, state: 'waiting', images: [{ data: 'data:big', mediaType: 'image/png' }] }], tight);
    const [back] = restoreKeptReceipts(m.get(KEPT_RECEIPTS_KEY) ?? null, T0 + 1_000);
    expect(back).toMatchObject({ state: 'failed', images: [], text: 'ship it', error: 'its pictures were not kept over the reload' });
  });

  it('garbage in storage restores nothing; the signature moves only with what a reload would lose', () => {
    expect(restoreKeptReceipts('not json')).toEqual([]);
    expect(restoreKeptReceipts('{"a":1}')).toEqual([]);
    expect(restoreKeptReceipts('[null,{"id":3}]')).toEqual([]);
    const thinking: Receipt = { ...base, id: 't', state: 'thinking', reply: 'a' };
    expect(keptSignature([mine, thinking])).toBe(keptSignature([mine, { ...thinking, reply: 'ab' }]));
    expect(keptSignature([mine])).not.toBe(keptSignature([{ ...mine, state: 'waiting' }]));
  });
});
