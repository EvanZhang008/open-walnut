/**
 * REGRESSION: optimistic-message dedup vs /compact history rewrite
 * (inc-1783472776601 — "my message stuck at the bottom even after new input").
 *
 * The dedup scan window is [prevMsgLen, messages.length) — correct while
 * history only grows. /compact REWRITES the JSONL: 4792 messages became 438,
 * so the old window start pointed past the end of the array and the window
 * was empty forever. Delivered optimistic bubbles ("just put all the
 * knowledge…", "/compact") could never match their persisted twins and stayed
 * pinned at the bottom, below newer messages, in the wrong order.
 *
 * Rule pinned here: shrink (messagesLen < prevMsgLen) ⇒ the rewritten array
 * is the new truth ⇒ scan ALL of it.
 */
import { describe, it, expect } from 'vitest';
import { dedupScanStart, dedupeOptimisticMessages } from '@/components/sessions/optimistic-dedup';

const user = (text: string) => ({ role: 'user', text });
const asst = (text: string) => ({ role: 'assistant', text });
const opt = (text: string, status = 'delivered', queueId = `q-${text}`) => ({ text, status, queueId });

describe('dedupScanStart', () => {
  it('growth: scans only newly appeared messages', () => {
    expect(dedupScanStart(5, 8)).toBe(5);
    expect(dedupScanStart(0, 3)).toBe(0);
  });
  it('shrink (/compact rewrite): scans the whole rewritten array', () => {
    expect(dedupScanStart(4792, 438)).toBe(0); // the incident's actual numbers
    expect(dedupScanStart(10, 9)).toBe(0);
  });
});

describe('dedupeOptimisticMessages', () => {
  it('growth: matches only in the new window (old identical text is NOT consumed)', () => {
    const messages = [user('hi'), asst('yo'), user('new msg')]; // prevMsgLen=2 → window = ['new msg']
    const optimistic = [opt('hi'), opt('new msg')];
    const out = dedupeOptimisticMessages(optimistic, messages, 2);
    // Old 'hi' at index 0 is OUTSIDE the window — the new optimistic 'hi' survives.
    expect(out.map(m => m.text)).toEqual(['hi']);
  });

  it('THE incident: /compact shrink still consumes delivered bubbles', () => {
    // Pre-compact the client saw thousands of messages; post-compact the
    // rewritten history contains the summary + the user's recent sends.
    const messages = [
      user('This session is being continued from a previous conversation…'),
      user('/compact'),
      user('just put all the knowledge it need to know'),
      asst('好, 我先把 SKILL.md 读完'),
    ];
    const optimistic = [opt('just put all the knowledge it need to know'), opt('/compact')];
    const out = dedupeOptimisticMessages(optimistic, messages, 4792); // stale huge prevMsgLen
    expect(out).toEqual([]); // both matched — nothing left pinned at the bottom
  });

  it('multiset: two identical sends consume two persisted twins, not one', () => {
    const messages = [user('hi'), user('hi')];
    const optimistic = [opt('hi', 'delivered', 'q1'), opt('hi', 'delivered', 'q2'), opt('hi', 'delivered', 'q3')];
    const out = dedupeOptimisticMessages(optimistic, messages, 0);
    expect(out.map(m => m.queueId)).toEqual(['q3']);
  });

  it('failed messages are never consumed', () => {
    const messages = [user('retry me')];
    const optimistic = [opt('retry me', 'failed')];
    const out = dedupeOptimisticMessages(optimistic, messages, 0);
    expect(out).toHaveLength(1);
  });

  it('assistant text never consumes an optimistic user message', () => {
    const messages = [asst('same words')];
    const optimistic = [opt('same words')];
    const out = dedupeOptimisticMessages(optimistic, messages, 0);
    expect(out).toHaveLength(1);
  });

  // ── Phase 1 (ACP dialect): echo-claim walnutMessageId exact match ──
  describe('walnutMessageId id-first consumption', () => {
    const boundUser = (text: string, wmId: string) => ({ role: 'user', text, walnutMessageId: wmId });

    it('consumes by exact id even OUTSIDE the text scan window', () => {
      // The bound echo sits at index 0 — outside window [2, 3). Text matching
      // would miss it; the id pass scans everything.
      const messages = [boundUser('hi', 'qm-1'), asst('yo'), asst('more')];
      const optimistic = [opt('hi', 'delivered', 'qm-1')];
      const out = dedupeOptimisticMessages(optimistic, messages, 2);
      expect(out).toEqual([]);
    });

    it('id match beats identical-text ambiguity (consumes the RIGHT bubble)', () => {
      // Two bubbles, same text; only qm-2's echo is bound. Text multiset would
      // consume qm-1 (first in list); the id pass consumes exactly qm-2.
      const messages = [boundUser('continue', 'qm-2')];
      const optimistic = [opt('continue', 'delivered', 'qm-1'), opt('continue', 'delivered', 'qm-2')];
      const out = dedupeOptimisticMessages(optimistic, messages, 0);
      // qm-2 gone by id; qm-1 then consumes the same persisted line by text —
      // acceptable (message IS persisted); assert qm-2 was id-consumed.
      expect(out.find(m => m.queueId === 'qm-2')).toBeUndefined();
    });

    it('unbound bubbles still fall back to text matching', () => {
      const messages = [user('plain echo')];
      const optimistic = [opt('plain echo', 'delivered', 'temp-123')];
      const out = dedupeOptimisticMessages(optimistic, messages, 0);
      expect(out).toEqual([]);
    });

    it('failed bubbles survive even when an id-bound echo matches', () => {
      const messages = [boundUser('retry me', 'qm-9')];
      const optimistic = [opt('retry me', 'failed', 'qm-9')];
      const out = dedupeOptimisticMessages(optimistic, messages, 0);
      expect(out).toHaveLength(1);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1 (ACP dialect): id-first batch consumption
// ═══════════════════════════════════════════════════════════════════════════
import { removeBatchMessages, markDeliveredMessages } from '@/components/sessions/optimistic-dedup';

describe('removeBatchMessages', () => {
  it('removes exactly the id-matched bubbles, sparing an identical-text newer one', () => {
    const msgs = [opt('hi', 'delivered', 'qm-1'), opt('hi', 'pending', 'qm-2')];
    const out = removeBatchMessages(msgs, 1, ['qm-1']);
    expect(out).toEqual([opt('hi', 'pending', 'qm-2')]);
  });

  it('id match removes even when the delivered transition was missed (WS drop)', () => {
    const msgs = [opt('a', 'received', 'qm-1')];
    expect(removeBatchMessages(msgs, 1, ['qm-1'])).toEqual([]);
  });

  it('stale event with unknown ids removes NOTHING pending (no-loss), only first-N delivered', () => {
    // ids present but none matched → count fallback → delivered-only guard
    const msgs = [opt('a', 'pending', 'qm-9'), opt('b', 'delivered', 'qm-8')];
    const out = removeBatchMessages(msgs, 1, ['qm-GONE']);
    expect(out).toEqual([opt('a', 'pending', 'qm-9')]);
  });

  it('id-less event keeps historical count semantics (delivered-only, first N)', () => {
    const msgs = [opt('a', 'delivered', 'qm-1'), opt('b', 'delivered', 'qm-2'), opt('c', 'pending', 'qm-3')];
    const out = removeBatchMessages(msgs, 1);
    expect(out).toEqual([opt('b', 'delivered', 'qm-2'), opt('c', 'pending', 'qm-3')]);
  });

  it('failed bubbles survive both paths', () => {
    const msgs = [opt('x', 'failed', 'qm-1')];
    expect(removeBatchMessages(msgs, 5)).toEqual(msgs);
    // id path CAN remove a failed bubble only when the server explicitly names it
    expect(removeBatchMessages(msgs, 1, ['qm-1'])).toEqual([]);
  });
});

describe('markDeliveredMessages', () => {
  it('marks exactly the id-matched bubbles delivered', () => {
    const msgs = [opt('a', 'pending', 'qm-1'), opt('b', 'pending', 'qm-2')];
    const out = markDeliveredMessages(msgs, 1, ['qm-2']);
    expect(out[0].status).toBe('pending');
    expect(out[1].status).toBe('delivered');
  });

  it('tempId race (no id matched) falls back to first-N count marking', () => {
    const msgs = [opt('a', 'pending', 'temp-123')];
    const out = markDeliveredMessages(msgs, 1, ['qm-real']);
    expect(out[0].status).toBe('delivered');
  });

  it('id-less event marks first N pending/received', () => {
    const msgs = [opt('a', 'received', 'qm-1'), opt('b', 'pending', 'qm-2')];
    const out = markDeliveredMessages(msgs, 1);
    expect(out[0].status).toBe('delivered');
    expect(out[1].status).toBe('pending');
  });
});
