/**
 * What a question's passage mark paints in Conversation Mode and on files
 * (web/src/utils/thread-mark-state.ts): waiting, answering, unread, failed,
 * read, resolved; the overlap order; and how a state maps to a highlight name,
 * a priority, the pulse or scan, and the tooltip (web/src/hooks/useThreadMarks.ts).
 */
import { describe, expect, it } from 'vitest';
import {
  MARK_STATE_ORDER, markStateOf, markStateRank, markStatesOf, sameMarkStates, type ThreadMarkState,
} from '@/utils/thread-mark-state';
import {
  MARK_PRIORITY, byUrgency, markFlagsOf, markHighlightName, markPriority, markTipText,
} from '@/hooks/useThreadMarks';
import { buildThreadTree, threadKeyOf, type ThreadTreeMessage } from '@/utils/thread-tree';
import type { SessionThreadAnchor } from '@/types/session';
import type { ThreadLiveState } from '@/utils/thread-meta';

describe('markStateOf', () => {
  it('asked and nothing back yet: waiting, whether queued, started without words, or not started', () => {
    expect(markStateOf({ live: 'queued' })).toBe('waiting');
    expect(markStateOf({ live: 'answering', spoke: false })).toBe('waiting');
    expect(markStateOf({ pending: true })).toBe('waiting');
    // A follow-up on an answered question starts over.
    expect(markStateOf({ live: 'queued', answeredAt: 100, lastViewedAt: 50 })).toBe('waiting');
    expect(markStateOf({ pending: true, answeredAt: 100, lastViewedAt: 200 })).toBe('waiting');
  });

  it('the first answer words: answering', () => {
    expect(markStateOf({ live: 'answering', spoke: true })).toBe('answering');
    expect(markStateOf({ live: 'answering', spoke: true, answeredAt: 300, lastViewedAt: 10 })).toBe('answering');
  });

  it('finished after the last view, and not on screen: unread', () => {
    expect(markStateOf({ answeredAt: 200, lastViewedAt: 100 })).toBe('unread');
  });

  it('finished while on screen, or viewed since: read', () => {
    expect(markStateOf({ answeredAt: 200, lastViewedAt: 100, viewing: true })).toBe('read');
    expect(markStateOf({ answeredAt: 200, lastViewedAt: 200 })).toBe('read');
    expect(markStateOf({ answeredAt: 200, lastViewedAt: 300 })).toBe('read');
  });

  it('never viewed here (asked in another place): read, not announced', () => {
    expect(markStateOf({ answeredAt: 200 })).toBe('read');
    expect(markStateOf({})).toBe('read');
  });

  it('a failed last turn: failed, until a retry is queued or sent', () => {
    expect(markStateOf({ live: 'failed', answeredAt: 200, lastViewedAt: 100 })).toBe('failed');
    expect(markStateOf({ live: 'failed', pending: true })).toBe('failed');
  });

  it('resolved wins over everything', () => {
    for (const live of ['queued', 'answering', 'failed'] as ThreadLiveState[]) {
      expect(markStateOf({ live, spoke: true, resolved: true })).toBe('resolved');
    }
    expect(markStateOf({ answeredAt: 200, lastViewedAt: 100, resolved: true })).toBe('resolved');
  });
});

describe('the overlap order', () => {
  it('waiting > answering > unread > failed > read > resolved', () => {
    expect(MARK_STATE_ORDER).toEqual(['waiting', 'answering', 'unread', 'failed', 'read', 'resolved']);
    const ranks = MARK_STATE_ORDER.map(markStateRank);
    expect(ranks).toEqual([5, 4, 3, 2, 1, 0]);
  });

  it('priorities sit above the pin highlight (0) and rise with urgency', () => {
    expect(markPriority('resolved')).toBe(MARK_PRIORITY);
    expect(markPriority(undefined)).toBe(MARK_PRIORITY);
    const ps = MARK_STATE_ORDER.map((s) => markPriority(s));
    for (let i = 1; i < ps.length; i++) expect(ps[i - 1]).toBeGreaterThan(ps[i]);
    expect(Math.min(...ps)).toBeGreaterThan(0);
  });

  it('byUrgency puts the most urgent first and keeps order within a state', () => {
    const marks: Array<{ id: string; state?: ThreadMarkState }> = [
      { id: 'a', state: 'read' }, { id: 'b', state: 'waiting' }, { id: 'c', state: 'unread' },
      { id: 'd', state: 'read' }, { id: 'e' }, { id: 'f', state: 'answering' },
    ];
    expect(byUrgency(marks).map((m) => m.id)).toEqual(['b', 'f', 'c', 'a', 'd', 'e']);
  });
});

describe('a state on the page', () => {
  it('neutral names per state; the old names stay for marks without a state', () => {
    const name = (s: ThreadMarkState) => markHighlightName(214, s === 'resolved', true, s === 'answering', s);
    expect(MARK_STATE_ORDER.map(name)).toEqual([
      'thread-mark-waiting-neutral', 'thread-mark-live-neutral', 'thread-mark-unread-neutral',
      'thread-mark-failed-neutral', 'thread-mark-neutral', 'thread-mark-done-neutral',
    ]);
    expect(markHighlightName(214, false, true)).toBe('thread-mark-neutral');
    // Tree Mode's hue marks ignore a state.
    expect(markHighlightName(214, false, false, false, 'unread')).toBe('thread-mark-214');
    expect(markHighlightName(214, false, false, true, 'waiting')).toBe('thread-mark-live-214');
  });

  it('waiting pulses, answering scans, nothing else moves; a draft never pulses', () => {
    const none = new Set<string>();
    expect(markFlagsOf({ key: 'k', neutral: true, state: 'waiting' }, none)).toEqual({ live: false, wait: true });
    expect(markFlagsOf({ key: 'k', neutral: true, state: 'waiting', draft: true }, none)).toEqual({ live: false, wait: false });
    expect(markFlagsOf({ key: 'k', neutral: true, state: 'answering' }, none)).toEqual({ live: true, wait: false });
    for (const s of ['unread', 'failed', 'read', 'resolved'] as ThreadMarkState[]) {
      expect(markFlagsOf({ key: 'k', neutral: true, state: s }, new Set(['k']))).toEqual({ live: false, wait: false });
    }
    // Hue marks (and neutral ones without a state) scan by the live keys, as before.
    expect(markFlagsOf({ key: 'k' }, new Set(['k']))).toEqual({ live: true, wait: false });
    expect(markFlagsOf({ key: 'k', neutral: true }, new Set(['k']))).toEqual({ live: true, wait: false });
  });

  it('the tooltip says what the state needs said', () => {
    expect(markTipText({ title: 'Late flush', state: 'waiting' })).toBe('Waiting for an answer · Open “Late flush”');
    expect(markTipText({ title: 'Late flush', state: 'unread' })).toBe('New answer · Open “Late flush”');
    expect(markTipText({ title: 'Late flush', state: 'read' })).toBe('Open “Late flush”');
    expect(markTipText({ title: 'Late flush' })).toBe('Open “Late flush”');
  });
});

describe('markStatesOf', () => {
  const user = (msgId: string): ThreadTreeMessage => ({ role: 'user', msgId, text: `q ${msgId}` });
  const reply = (msgId: string): ThreadTreeMessage => ({ role: 'assistant', msgId, text: `a ${msgId}` });
  const anchor = (msgId: string, parent: string, exact: string): SessionThreadAnchor =>
    ({ msgId, parent, quote: { exact }, source: 'selection', at: '2026-10-01T10:00:00Z' });
  const a1 = anchor('u2', 'r1', 'a r1');
  const a2 = anchor('u3', 'r1', 'r1');
  const tree = buildThreadTree([user('u1'), reply('r1'), user('u2'), reply('r2'), user('u3'), reply('r3')], [a1, a2]);
  const k1 = threadKeyOf(a1);
  const k2 = threadKeyOf(a2);
  const base = {
    tree, live: new Map<string, ThreadLiveState>(), spoke: new Set<string>(), answeredAt: new Map<string, number>(),
    datedAt: new Map<string, number>(), sentKeys: new Set<string>(), queuedKeys: new Set<string>(), unsentKeys: new Set<string>(),
    lastViewedAt: new Map<string, number>(), viewingKey: '', askedAt: new Map<string, number>(), isResolved: () => false,
  };

  it('walks one question through the cycle, a follow-up included', () => {
    const at = (over: Partial<typeof base>) => markStatesOf({ ...base, ...over }).get(k1);
    // Asked at 100 (viewed at ask time), on its way, nothing back yet.
    const asked = { askedAt: new Map([[k1, 100]]), lastViewedAt: new Map([['u2', 100]]), sentKeys: new Set([k1]) };
    expect(at(asked)).toBe('waiting');
    expect(at({ ...asked, live: new Map([[k1, 'answering' as const]]) })).toBe('waiting');
    expect(at({ ...asked, live: new Map([[k1, 'answering' as const]]), spoke: new Set([k1]) })).toBe('answering');
    // Done at 200 with its card closed: unread; open it: read.
    const done = { ...asked, answeredAt: new Map([[k1, 200]]), datedAt: new Map([[k1, 200]]) };
    expect(at(done)).toBe('unread');
    expect(at({ ...done, viewingKey: k1 })).toBe('read');
    expect(at({ ...done, lastViewedAt: new Map([['u2', 250]]) })).toBe('read');
    // A follow-up at 300: waiting again, whatever was read before.
    expect(at({ ...done, lastViewedAt: new Map([['u2', 300]]), askedAt: new Map([[k1, 300]]) })).toBe('waiting');
  });

  it('keys only the questions, each by its own facts', () => {
    const states = markStatesOf({
      ...base, live: new Map([[k2, 'failed' as const]]), isResolved: (n) => n.key === k1,
    });
    expect([...states.keys()].sort()).toEqual([k1, k2].sort());
    expect(states.get(k1)).toBe('resolved');
    expect(states.get(k2)).toBe('failed');
  });

  it('a follow-up queued behind its own streaming answer is waiting, not answering', () => {
    const at = (over: Partial<typeof base>) => markStatesOf({ ...base, ...over }).get(k1);
    const streaming = { live: new Map([[k1, 'answering' as const]]), spoke: new Set([k1]) };
    expect(at(streaming)).toBe('answering');
    expect(at({ ...streaming, queuedKeys: new Set([k1]), sentKeys: new Set([k1]), askedAt: new Map([[k1, 300]]) })).toBe('waiting');
  });

  it('a send that never went out, or was withdrawn, waits for nothing', () => {
    const at = (over: Partial<typeof base>) => markStatesOf({ ...base, ...over }).get(k1);
    const asked = { askedAt: new Map([[k1, 100]]), lastViewedAt: new Map([['u2', 100]]) };
    // Failed to deliver: failed, not a pulse forever.
    expect(at({ ...asked, unsentKeys: new Set([k1]) })).toBe('failed');
    // Withdrawn from the queue (no row left, not live): back to read.
    expect(at(asked)).toBe('read');
  });

  it('pending compares this tab\'s own clock: a host clock ahead does not hide a fresh ask', () => {
    const at = (over: Partial<typeof base>) => markStatesOf({ ...base, ...over }).get(k1);
    // The transcript dates the old answer at 500 (host clock), this tab asked at 300
    // and saw the old answer land at 120.
    expect(at({
      askedAt: new Map([[k1, 300]]), sentKeys: new Set([k1]), lastViewedAt: new Map([['u2', 300]]),
      answeredAt: new Map([[k1, 500]]), datedAt: new Map([[k1, 120]]),
    })).toBe('waiting');
  });

  it('sameMarkStates compares entries', () => {
    expect(sameMarkStates(new Map([['a', 'read']]), new Map([['a', 'read']]))).toBe(true);
    expect(sameMarkStates(new Map([['a', 'read']]), new Map([['a', 'unread']]))).toBe(false);
    expect(sameMarkStates(new Map([['a', 'read']]), new Map())).toBe(false);
  });
});
