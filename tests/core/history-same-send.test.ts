import { describe, it, expect } from 'vitest';
import { isSameSend, withoutHeldSends, SAME_SEND_SKEW_MS } from '../../src/core/history-same-send.js';

const at = (ms: number) => new Date(Date.UTC(2026, 10, 17, 22, 2, 45) + ms).toISOString();
const send = (ms: number, text = 'show me the summary') => ({ msgId: `queue-${at(ms)}`, role: 'user', text, timestamp: at(ms) });

describe('isSameSend', () => {
  it('one send: queue rows of the same text within the skew', () => {
    expect(isSameSend(send(0), send(-3))).toBe(true);
    expect(isSameSend(send(0), send(SAME_SEND_SKEW_MS))).toBe(true);
  });
  it('not one send: another text, too far apart, not a queue row, not a user row', () => {
    expect(isSameSend(send(0), send(0, 'other'))).toBe(false);
    expect(isSameSend(send(0), send(SAME_SEND_SKEW_MS + 1))).toBe(false);
    expect(isSameSend(send(0), { ...send(0), msgId: 'u-1' })).toBe(false);
    expect(isSameSend(send(0), { ...send(0), role: 'assistant' })).toBe(false);
  });
});

describe('withoutHeldSends', () => {
  it('drops the older read\'s copy of a send the newer one holds, and nothing else', () => {
    const older = [{ msgId: 'a', role: 'assistant', text: 'x', timestamp: at(-9_000) }, send(0)];
    expect(withoutHeldSends(older, [send(-2)]).map((m) => m.msgId)).toEqual(['a']);
    expect(withoutHeldSends(older, [])).toBe(older);
  });
});
