/**
 * The inbox as the threads that need him (experiment inbox_needs_threads,
 * src/core/human-inbox/needs-model.ts): which threads need him, how urgent each is and the order,
 * and the count that holds each thing once (a decision letter waiting on its thread is the thread).
 */
import { describe, expect, it } from 'vitest';
import { byUrgency, DUE_SOON_MS, heldLetterOf, inboxNeedsCount, needsThreadsOf, needsUrgency, type UrgencyThread } from '../../../src/core/human-inbox/needs-model.js';

const NOW = Date.parse('2026-11-20T12:00:00.000Z');
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const H = 3600_000;

type T = UrgencyThread & { title: string; state: string; messages: never[]; askedIn?: unknown; heldAsk?: unknown; owner?: unknown; snoozed?: { until: string; at: string } };
let n = 0;
function thread(over: Partial<T> = {}): T {
  n++;
  return { id: `th-${String(n).padStart(6, '0')}`, title: `Thread ${n}`, state: 'needs', messages: [], updatedAt: iso(H), createdAt: iso(2 * H), ...over };
}

describe('which threads need him', () => {
  it('only the needs ones his view lists: never closed, snoozed, asked in a task, a task\'s own ask, or one of a task below', () => {
    const keep = thread();
    const list = [
      keep,
      thread({ state: 'working' }),
      thread({ state: 'answered' }),
      thread({ closed: { by: 'human' } }),
      thread({ snoozed: { until: iso(-H), at: iso(H) } }),
      thread({ askedIn: { task: 't1' } }),
      thread({ heldAsk: { id: 'a1' } }),
      thread({ owner: { task_id: 'below', title: 'Below' } }),
    ];
    expect(needsThreadsOf(list as never, NOW).map((t) => t.id)).toEqual([keep.id]);
  });

  it('a snooze that ran out brings it back', () => {
    const back = thread({ snoozed: { until: iso(H), at: iso(3 * H) } });
    expect(needsThreadsOf([back] as never, NOW)).toHaveLength(1);
  });
});

describe('how urgent', () => {
  it('pinned first: the thread, or the decision letter it holds', () => {
    expect(needsUrgency(thread({ pinned: { at: iso(H) } }), { now: NOW })).toMatchObject({ rank: 0, why: 'pinned' });
    expect(needsUrgency(thread(), { letterPinned: true, now: NOW })).toMatchObject({ rank: 0, why: 'pinned' });
    // A closed thread's pin is no pin (thread-view.ts pinnedNow).
    expect(needsUrgency(thread({ pinned: { at: iso(H) }, closed: { by: 'human' } }), { now: NOW }).why).toBe('waiting');
  });

  it('due: its node or a task it names is due within a day, or overdue; a completed task never counts', () => {
    const soon = new Date(NOW + DUE_SOON_MS - 60_000).toISOString();
    const late = new Date(NOW - H).toISOString();
    const far = new Date(NOW + 3 * DUE_SOON_MS).toISOString();
    expect(needsUrgency(thread(), { node: { id: 'node', due_date: soon }, now: NOW })).toMatchObject({ rank: 1, why: 'due', due: soon });
    expect(needsUrgency(thread({ tasks: ['w'] }), { node: { id: 'node' }, tasks: [{ id: 'w', due_date: late }], now: NOW })).toMatchObject({ rank: 1, why: 'due', due: late });
    expect(needsUrgency(thread({ tasks: ['w'] }), { tasks: [{ id: 'w', due_date: far }], now: NOW }).why).toBe('waiting');
    expect(needsUrgency(thread({ tasks: ['w'] }), { tasks: [{ id: 'w', due_date: soon, phase: 'COMPLETE' }], now: NOW }).why).toBe('waiting');
    // A task the thread does not name is not its deadline.
    expect(needsUrgency(thread(), { tasks: [{ id: 'other', due_date: soon }], now: NOW }).why).toBe('waiting');
  });

  it('immediate: its node or a task it names is marked priority immediate', () => {
    expect(needsUrgency(thread(), { node: { id: 'node', priority: 'immediate' }, now: NOW })).toMatchObject({ rank: 1, why: 'immediate' });
    expect(needsUrgency(thread({ tasks: ['w'] }), { node: { id: 'node' }, tasks: [{ id: 'w', priority: 'immediate' }], now: NOW }).why).toBe('immediate');
    expect(needsUrgency(thread(), { node: { id: 'node', priority: 'important' }, now: NOW }).why).toBe('waiting');
  });

  it('waits since its first post (a letter\'s own time), else since it was made', () => {
    expect(needsUrgency(thread({ opener: { at: iso(9 * H), from: 'letter' } }), { now: NOW }).since).toBe(iso(9 * H));
    expect(needsUrgency(thread({ createdAt: iso(5 * H) }), { now: NOW }).since).toBe(iso(5 * H));
  });

  it('the order: rank, then the one that waited longest, then the id; stable across reads', () => {
    const rows = [
      { id: 'th-c', urgency: needsUrgency(thread({ createdAt: iso(1 * H) }), { now: NOW }) },
      { id: 'th-b', urgency: needsUrgency(thread({ createdAt: iso(8 * H) }), { now: NOW }) },
      { id: 'th-p', urgency: needsUrgency(thread({ createdAt: iso(1 * H), pinned: { at: iso(1) } }), { now: NOW }) },
      { id: 'th-d', urgency: needsUrgency(thread({ createdAt: iso(1 * H) }), { node: { id: 'n', priority: 'immediate' }, now: NOW }) },
      { id: 'th-a', urgency: needsUrgency(thread({ createdAt: iso(1 * H) }), { now: NOW }) },
    ];
    expect([...rows].sort(byUrgency).map((r) => r.id)).toEqual(['th-p', 'th-d', 'th-b', 'th-a', 'th-c']);
    expect([...rows].reverse().sort(byUrgency).map((r) => r.id)).toEqual(['th-p', 'th-d', 'th-b', 'th-a', 'th-c']);
  });
});

describe('the count holds each thing once', () => {
  const held = thread({ letter: { id: 'lt-held' } });
  const plain = thread();
  const letters = [
    { id: 'lt-held', read: false },
    { id: 'lt-fyi', read: false },
    { id: 'lt-read', read: true },
    { id: 'lt-old', read: false, archived: true },
  ];

  it('a decision letter its thread holds counts as the thread, never again as a letter', () => {
    expect(inboxNeedsCount([held, plain], letters)).toEqual({ threads: 2, letters: 1, total: 3 });
  });

  it('a read letter, an archived one and an ended letter thread are counted as they are', () => {
    // The letter ended (answered elsewhere): the thread holds it no more, so an unread copy counts as mail.
    const ended = thread({ letter: { id: 'lt-held', done: true } });
    expect(heldLetterOf(ended)).toBeUndefined();
    expect(inboxNeedsCount([ended], letters)).toEqual({ threads: 1, letters: 2, total: 3 });
    expect(heldLetterOf(thread({ letter: { id: 'lt-x', off: true } }))).toBeUndefined();
    expect(inboxNeedsCount([], letters)).toEqual({ threads: 0, letters: 2, total: 2 });
  });
});
