/**
 * A question's anchor write is retried and, when it still fails, kept as unsaved
 * until a later write stores it (utils/question-write-retry.ts).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readUnsavedQuestions, retryWrite, unsavedMeta, unsavedQuestionsKey, withUnsaved, withoutSaved, writeUnsavedQuestions,
  type UnsavedQuestion,
} from '@/utils/question-write-retry';
import { withUnsavedAnchors } from '@/hooks/useSessionThreads';
import type { SessionThreadAnchor } from '@/types/session';

const anchor = (msgId: string): SessionThreadAnchor => ({ msgId, parent: 'p1', source: 'selection', at: '2026-10-27T00:00:00Z' });
const q = (msgId: string, at = Date.now()): UnsavedQuestion => ({ anchor: anchor(msgId), meta: [{ headId: msgId, status: 'open', seq: 2 }], at });

describe('retryWrite', () => {
  it('tries again after each wait and returns the first success', async () => {
    const waits: number[] = [];
    let calls = 0;
    const out = await retryWrite(async () => { calls += 1; if (calls < 3) throw new Error('Load failed'); return 'ok'; },
      { delays: [1000, 3000], sleep: async (ms) => { waits.push(ms); } });
    expect(out).toBe('ok');
    expect(calls).toBe(3);
    expect(waits).toEqual([1000, 3000]);
  });

  it('throws the last error after the last try', async () => {
    let calls = 0;
    await expect(retryWrite(async () => { calls += 1; throw new Error(`fail ${calls}`); }, { delays: [1, 1], sleep: async () => {} }))
      .rejects.toThrow('fail 3');
  });

  it('stops early when the panel left the session', async () => {
    let calls = 0;
    await expect(retryWrite(async () => { calls += 1; throw new Error('x'); }, { delays: [1, 1], sleep: async () => {}, stop: () => true }))
      .rejects.toThrow('x');
    expect(calls).toBe(1);
  });
});

describe('the unsaved list', () => {
  // The node test environment has no localStorage: a small in-memory one.
  beforeEach(() => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => { data.set(k, String(v)); },
      removeItem: (k: string) => { data.delete(k); },
      clear: () => data.clear(),
    });
  });

  it('round-trips through localStorage, one entry per question', () => {
    const list = withUnsaved(withUnsaved([], q('h1')), q('h1'));
    expect(list).toHaveLength(1);
    writeUnsavedQuestions('s1', withUnsaved(list, q('h2')));
    expect(readUnsavedQuestions('s1').map((x) => x.anchor.msgId)).toEqual(['h1', 'h2']);
    writeUnsavedQuestions('s1', []);
    expect(localStorage.getItem(unsavedQuestionsKey('s1'))).toBeNull();
  });

  it('drops malformed and week-old entries on read', () => {
    localStorage.setItem(unsavedQuestionsKey('s1'), JSON.stringify([q('h1', Date.now() - 8 * 24 * 3600 * 1000), { nope: 1 }, q('h2')]));
    expect(readUnsavedQuestions('s1').map((x) => x.anchor.msgId)).toEqual(['h2']);
    localStorage.setItem(unsavedQuestionsKey('s1'), '{not json');
    expect(readUnsavedQuestions('s1')).toEqual([]);
  });

  it('an entry the record holds is saved; the rest ride along', () => {
    const list = [q('h1'), q('h2')];
    expect(withoutSaved(list, [{ msgId: 'h2' }]).map((x) => x.anchor.msgId)).toEqual(['h1']);
    expect(withoutSaved(list, undefined)).toHaveLength(2);
    expect(unsavedMeta(list).map((m) => m.headId)).toEqual(['h1', 'h2']);
  });
});

describe('withUnsavedAnchors', () => {
  it('a record without the unsaved anchor still shows it; one with it is unchanged', () => {
    const unsaved = new Map([['h9', anchor('h9')]]);
    const server = [anchor('h1')];
    expect(withUnsavedAnchors(server, unsaved).map((a) => a.msgId)).toEqual(['h1', 'h9']);
    const holding = [anchor('h1'), anchor('h9')];
    expect(withUnsavedAnchors(holding, unsaved)).toBe(holding);
    expect(withUnsavedAnchors(server, new Map())).toBe(server);
  });
});
