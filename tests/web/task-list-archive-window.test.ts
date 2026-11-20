/**
 * A page that holds the whole completed archive refetches only the recent window and keeps
 * the archive rows it has (2026-11-20 memory work: each refetch of all 7.9k tasks was 11.5 MB
 * of JSON at every socket reconnect and bulk event).
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '@open-walnut/core';
import { archiveRowsOutsideWindow, mergeWindowedRefetch } from '@/hooks/task-list-merge';

const NOW = Date.parse('2026-11-20T12:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const iso = (ms: number) => new Date(ms).toISOString();
let seq = 0;
function task(over: Partial<Task> = {}): Task {
  seq++;
  return {
    id: over.id ?? `t-${seq}`, title: `Task ${seq}`, status: 'todo', phase: 'TODO', priority: 'none', project: '',
    created_at: '2026-01-01T00:00:00Z', updated_at: iso(NOW - DAY), ...over,
  } as Task;
}
const old = (over: Partial<Task> = {}) => task({ status: 'done', phase: 'COMPLETE', completed_at: iso(NOW - 30 * DAY), ...over });

describe('archiveRowsOutsideWindow', () => {
  it('keeps the old completed rows the window leaves out, drops what is really gone', () => {
    const archived = old();
    const pinnedOld = old({ pinned: true });
    const tieredOld = old({ focus_tier: 'focus' });
    const recentDone = task({ status: 'done', phase: 'COMPLETE', completed_at: iso(NOW - 2 * DAY) });
    const open = task();
    const fallbackStamp = old({ completed_at: undefined, updated_at: iso(NOW - 20 * DAY) });
    const kept = archiveRowsOutsideWindow([archived, pinnedOld, tieredOld, recentDone, open, fallbackStamp], [], 7, NOW);
    expect(kept.map((t) => t.id)).toEqual([archived.id, fallbackStamp.id]);
  });

  it('drops an old completed ask the answer lacks: asks always ride the window, so it is deleted', () => {
    const ask = old({ walnut_agent: true } as Partial<Task>);
    const askProject = old({ project: 'Ask Walnut' });
    expect(archiveRowsOutsideWindow([ask, askProject], [], 7, NOW)).toEqual([]);
  });

  it('never keeps a row the answer carries', () => {
    const archived = old();
    expect(archiveRowsOutsideWindow([archived], [archived], 7, NOW)).toEqual([]);
  });
});

describe('mergeWindowedRefetch', () => {
  it('keeps the archive and adopts the window', () => {
    const archived = old();
    const open = task();
    const changed = { ...open, title: 'renamed', updated_at: iso(NOW) } as Task;
    const next = mergeWindowedRefetch([open, archived], [changed], 7, undefined, undefined, NOW);
    expect(next.map((t) => t.id).sort()).toEqual([open.id, archived.id].sort());
    expect(next.find((t) => t.id === open.id)?.title).toBe('renamed');
    expect(next.find((t) => t.id === archived.id)).toBe(archived);
  });

  it('returns the previous array when nothing changed', () => {
    const archived = old();
    const open = task();
    const prev = [open, archived];
    expect(mergeWindowedRefetch(prev, [{ ...open } as Task], 7, undefined, undefined, NOW)).toBe(prev);
  });

  it('drops an open task the window no longer carries (deleted while away)', () => {
    const archived = old();
    const gone = task();
    const next = mergeWindowedRefetch([gone, archived], [], 7, undefined, undefined, NOW);
    expect(next.map((t) => t.id)).toEqual([archived.id]);
  });

  it('a reopened archive row comes back from the window, not twice', () => {
    const archived = old();
    const reopened = { ...archived, status: 'todo', phase: 'TODO', completed_at: undefined, updated_at: iso(NOW) } as Task;
    const next = mergeWindowedRefetch([archived], [reopened], 7, undefined, undefined, NOW);
    expect(next).toHaveLength(1);
    expect(next[0].phase).toBe('TODO');
  });
});
