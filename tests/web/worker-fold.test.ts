/**
 * Workers fold into their leader on the Home list (web/src/components/tasks/worker-fold.ts).
 *
 * Pinned: a VP or Main never leads a fold (every task is under one), nor a finished leader; a
 * folded worker leaves its section and its leader carries it; a leader the view does not hold is
 * drawn quiet where its first worker was; a leader sitting in a less active section than its
 * folded workers moves up to them; Watching, Needs you and Completed never fold; showing one
 * worker separately, a whole team, or turning the fold off brings the rows back; a worker of a
 * folded leader folds into the top host, nested one level deeper; a prefix parent ref counts.
 */
import { describe, expect, it } from 'vitest';
import type { Task } from '@open-walnut/core';
import {
  DEFAULT_WORKER_FOLD, WORKER_FOLD_IDS_MAX, countsAsLeader, foldHostOf, foldMixLine, foldSections, isFoldedWorker,
  isWorkerFoldView, stateSectionKey, withId, type WorkerFoldView,
} from '../../web/src/components/tasks/worker-fold';

function task(over: Partial<Task> & { id: string }): Task {
  return { title: over.id, project: 'Walnut', phase: 'IN_PROGRESS', status: 'open', created_at: '', updated_at: '', ...over } as unknown as Task;
}
const view = (over: Partial<WorkerFoldView> = {}): WorkerFoldView => ({ ...DEFAULT_WORKER_FOLD, ...over });
const ids = (l: readonly Task[]) => l.map((t) => t.id);

type K = 'watching' | 'needs' | 'working' | 'waiting' | 'notstarted' | 'done';
const KEEP = new Set<K>(['watching', 'needs', 'done']);

describe('who leads a fold', () => {
  it('a VP, Main and a finished task never do', () => {
    expect(countsAsLeader(task({ id: 'vp', org_role: 'lead' }))).toBe(false);
    expect(countsAsLeader(task({ id: 'main', org_role: 'main' }))).toBe(false);
    expect(countsAsLeader(task({ id: 'done', phase: 'COMPLETE' }))).toBe(false);
    expect(countsAsLeader(task({ id: 'lead' }))).toBe(true);
  });

  it('a worker of a VP is a row of its own', () => {
    const vp = task({ id: 'mvp00000-0001', org_role: 'lead' });
    const w = task({ id: 'w1', parent_task_id: vp.id });
    const tasks = [vp, w];
    expect(isFoldedWorker(tasks, w, view())).toBe(false);
    const f = foldSections<K>(tasks, [['working', [w]]], view(), KEEP);
    expect(ids(f.rows.working)).toEqual(['w1']);
    expect(f.trees.size).toBe(0);
  });

  it('a prefix parent ref finds its leader', () => {
    const lead = task({ id: 'muabcdef-1234' });
    const w = task({ id: 'w1', parent_task_id: 'muabcdef' });
    expect(foldHostOf([lead, w], w, view())?.id).toBe(lead.id);
  });
});

describe('foldSections', () => {
  const lead = task({ id: 'lead', phase: 'IN_PROGRESS' });
  const w1 = task({ id: 'w1', parent_task_id: 'lead' });
  const w2 = task({ id: 'w2', parent_task_id: 'lead', phase: 'TODO' });
  const other = task({ id: 'other' });
  const tasks = [lead, w1, w2, other];

  it('folds workers into a leader drawn in the same section', () => {
    const f = foldSections<K>(tasks, [['working', [other, lead, w1]], ['waiting', [w2]]], view(), KEEP);
    expect(ids(f.rows.working)).toEqual(['other', 'lead']);
    expect(ids(f.rows.waiting)).toEqual([]);
    expect(f.trees.get('lead')?.map((e) => [e.task.id, e.depth, e.out])).toEqual([['w1', 0, false], ['w2', 0, false]]);
    expect(f.quiet.size).toBe(0);
  });

  it('draws a leader the view does not hold as a quiet row in its first worker\'s place', () => {
    const f = foldSections<K>(tasks, [['working', [other, w1]], ['waiting', [w2]]], view(), KEEP);
    expect(ids(f.rows.working)).toEqual(['other', 'lead']);
    expect(ids(f.rows.waiting)).toEqual([]);
    expect([...f.quiet]).toEqual(['lead']);
  });

  it('moves a waiting leader up to its working workers, never down', () => {
    const waitingLead = task({ id: 'lead', phase: 'TODO' });
    const t = [waitingLead, w1, other];
    const f = foldSections<K>(t, [['working', [other, w1]], ['waiting', [waitingLead]]], view(), KEEP);
    expect(ids(f.rows.working)).toEqual(['other', 'lead']);
    expect(ids(f.rows.waiting)).toEqual([]);
    expect(f.movedFrom.get('lead')).toBe('waiting');
    const g = foldSections<K>(t, [['working', [waitingLead]], ['waiting', [w1]]], view(), KEEP);
    expect(ids(g.rows.working)).toEqual(['lead']);
    expect(g.movedFrom.size).toBe(0);
  });

  it('never folds Watching, Needs you or Completed, and lists those workers as shown', () => {
    const needsW = task({ id: 'nw', parent_task_id: 'lead', phase: 'NEED_ACTION' });
    const t = [lead, needsW, w1];
    const f = foldSections<K>(t, [['needs', [needsW]], ['working', [lead, w1]]], view(), KEEP);
    expect(ids(f.rows.needs)).toEqual(['nw']);
    expect(ids(f.rows.working)).toEqual(['lead']);
    expect(f.trees.get('lead')?.map((e) => [e.task.id, e.out])).toEqual([['nw', true], ['w1', false]]);
  });

  it('shows one worker, a whole team, or every worker separately', () => {
    const sections: [K, Task[]][] = [['working', [lead, w1, w2]]];
    expect(ids(foldSections<K>(tasks, sections, view({ separate: ['w2'] }), KEEP).rows.working)).toEqual(['lead', 'w2']);
    const team = foldSections<K>(tasks, sections, view({ teams: ['lead'] }), KEEP);
    expect(ids(team.rows.working)).toEqual(['lead', 'w1', 'w2']);
    expect(team.trees.get('lead')?.every((e) => e.out)).toBe(true);
    const off = foldSections<K>(tasks, sections, view({ fold: false }), KEEP);
    expect(ids(off.rows.working)).toEqual(['lead', 'w1', 'w2']);
    expect(off.trees.size).toBe(0);
  });

  it('folds a worker of a folded leader into the top host, one level deeper', () => {
    const sub = task({ id: 'sub', parent_task_id: 'w1' });
    const t = [lead, w1, sub];
    const f = foldSections<K>(t, [['working', [lead, w1, sub]]], view(), KEEP);
    expect(ids(f.rows.working)).toEqual(['lead']);
    expect(f.trees.get('lead')?.map((e) => [e.task.id, e.depth])).toEqual([['w1', 0], ['sub', 1]]);
    // w1 shown separately: it carries its own worker.
    const g = foldSections<K>(t, [['working', [lead, w1, sub]]], view({ separate: ['w1'] }), KEEP);
    expect(ids(g.rows.working)).toEqual(['lead', 'w1']);
    expect(g.trees.get('w1')?.map((e) => e.task.id)).toEqual(['sub']);
  });

  it('a finished worker never folds', () => {
    const done = task({ id: 'd', parent_task_id: 'lead', phase: 'COMPLETE', status: 'done' });
    const f = foldSections<K>([lead, done], [['working', [lead]], ['done', [done]]], view(), KEEP);
    expect(ids(f.rows.done)).toEqual(['d']);
    expect(f.trees.size).toBe(0);
  });
});

describe('view helpers', () => {
  it('accepts only a whole view', () => {
    expect(isWorkerFoldView(DEFAULT_WORKER_FOLD)).toBe(true);
    expect(isWorkerFoldView({ fold: true, teams: [], separate: [] })).toBe(false);
    expect(isWorkerFoldView({ fold: 'yes', teams: [], separate: [], open: [] })).toBe(false);
  });

  it('keeps the last WORKER_FOLD_IDS_MAX ids', () => {
    let l: string[] = [];
    for (let i = 0; i < WORKER_FOLD_IDS_MAX + 5; i++) l = withId(l, `t${i}`, true);
    expect(l.length).toBe(WORKER_FOLD_IDS_MAX);
    expect(l.at(-1)).toBe(`t${WORKER_FOLD_IDS_MAX + 4}`);
    expect(withId(l, 't10', false)).not.toContain('t10');
  });

  it('reads a worker nobody started as Not started, as its own section would', () => {
    const todo = task({ id: 'todo', phase: 'TODO' })
    expect(stateSectionKey(todo)).toBe('notstarted')
    expect(foldMixLine([{ task: todo, depth: 0, out: false }])).toBe('1 not started')
  });

  it('says the team\'s mix', () => {
    const e = (id: string, phase: string, out = false) => ({ task: task({ id, phase: phase as Task['phase'] }), depth: 0, out });
    expect(foldMixLine([e('a', 'NEED_ACTION', true), e('b', 'IN_PROGRESS'), e('c', 'IN_PROGRESS'), e('d', 'WAITING')]))
      .toBe('1 needs you · 2 working · 1 waiting · 1 in the list');
    expect(foldMixLine([e('b', 'IN_PROGRESS', true)])).toBe('1 working · all in the list');
  });
});
