/**
 * The task kebab's collapsed Team row and its Release picker
 * (web/src/components/tasks/team-menu-model.ts).
 *
 * Pinned: the collapsed row speaks the pills' words (`Leader · n` counts open
 * workers, a leader whose workers are all done says so, `Worker of “X”`, plain
 * `Worker` when the leader is not loaded, both parts together, nothing for a
 * task in no team); the Release picker lists every direct worker, open ones
 * first, prefix-linked ones included, never grandchildren, filtered by title,
 * project or id prefix.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import { releaseCandidates, teamRowSummary } from '../../web/src/components/tasks/team-menu-model';

function task(over: Partial<Task> & { id: string }): Task {
  return { title: over.id, project: 'Walnut', phase: 'TODO', status: 'open', created_at: '', updated_at: '', ...over } as unknown as Task;
}

describe('teamRowSummary', () => {
  it('says nothing for a task in no team', () => {
    const solo = task({ id: 'solo' });
    expect(teamRowSummary([solo], solo, null)).toBe('');
  });

  it('counts the open workers of a leader, and the done ones when none is open', () => {
    const lead = task({ id: 'lead-0001' });
    const open = [task({ id: 'w1', parent_task_id: lead.id }), task({ id: 'w2', parent_task_id: 'lead', phase: 'NEED_ACTION' })];
    const done = task({ id: 'w3', parent_task_id: lead.id, phase: 'COMPLETE' });
    expect(teamRowSummary([lead, ...open, done], lead, null)).toBe('Leader · 2');
    expect(teamRowSummary([lead, done], lead, null)).toBe('Leader · 1 done');
  });

  it('names the leader of a worker, or says Worker when the leader is not loaded', () => {
    const w = task({ id: 'w', parent_task_id: 'gone' });
    expect(teamRowSummary([w], w, '\u6bcf\u65e5\u6458\u8981 digest' /* CJK title */)).toBe('Worker of “\u6bcf\u65e5\u6458\u8981 digest”');
    expect(teamRowSummary([w], w, null)).toBe('Worker');
  });

  it('says both for a worker that also leads', () => {
    const mid = task({ id: 'mid', parent_task_id: 'top' });
    const sub = task({ id: 'sub', parent_task_id: 'mid' });
    expect(teamRowSummary([mid, sub], mid, 'Top')).toBe('Leader · 1, Worker of “Top”');
  });
});

describe('releaseCandidates', () => {
  const lead = task({ id: 'muabcdef-1234', title: 'Lead' });
  const a = task({ id: 'a1', title: 'Wire the API', parent_task_id: lead.id, phase: 'COMPLETE' });
  const b = task({ id: 'b2', title: 'Write the docs', parent_task_id: 'muabcdef', project: 'Ops' });
  const grandchild = task({ id: 'g3', title: 'Docs review', parent_task_id: 'b2' });
  const stranger = task({ id: 's4', title: 'Unrelated' });
  const tasks = [lead, a, b, grandchild, stranger];

  it('lists every direct worker, open first, prefix links included, never grandchildren', () => {
    expect(releaseCandidates(tasks, lead.id).map((t) => t.id)).toEqual(['b2', 'a1']);
  });

  it('filters by title, project and id prefix', () => {
    expect(releaseCandidates(tasks, lead.id, 'api').map((t) => t.id)).toEqual(['a1']);
    expect(releaseCandidates(tasks, lead.id, 'ops').map((t) => t.id)).toEqual(['b2']);
    expect(releaseCandidates(tasks, lead.id, 'A1').map((t) => t.id)).toEqual(['a1']);
    expect(releaseCandidates(tasks, lead.id, '  ').map((t) => t.id)).toEqual(['b2', 'a1']);
    expect(releaseCandidates(tasks, lead.id, 'nothing')).toEqual([]);
  });

  it('answers [] for a task that leads nothing', () => {
    expect(releaseCandidates(tasks, stranger.id)).toEqual([]);
  });
});
