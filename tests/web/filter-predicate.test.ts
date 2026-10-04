/**
 * The shared hit test (web/src/components/tasks/filter-predicate.ts): every
 * dimension through matchesTaskQuery, Date through the moved legacy filter,
 * bypassDefaults (search) and except (footer counts), plus the 5.12 reasons.
 */
import { describe, it, expect } from 'vitest';
import type { Task } from '../../src/core/types';
import { DEFAULT_FILTER_STATE as S0, type FilterState } from '../../web/src/components/tasks/filter-bar-types';
import {
  buildFilterEvalContext, failingDims, hiddenByReasons, hiddenByText, passesChips, showValueFor,
} from '../../web/src/components/tasks/filter-predicate';
import { matchesDateFilter } from '../../web/src/components/tasks/task-date-filter';

const NOW = new Date('2026-10-01T12:00:00Z');
let seq = 0;
function mk(over: Partial<Task> = {}): Task {
  seq += 1;
  const phase = over.phase ?? 'TODO';
  return {
    id: `t${seq}`,
    title: `Task ${seq}`,
    status: phase === 'COMPLETE' ? 'done' : phase === 'TODO' || phase === 'WAITING' ? 'todo' : 'in_progress',
    phase,
    priority: 'none',
    project: 'Home',
    source: 'local',
    tags: [],
    created_at: '2026-09-30T12:00:00Z',
    updated_at: '2026-09-30T12:00:00Z',
    ...over,
  } as unknown as Task;
}

const ids = (tasks: Task[], s: FilterState, opts = {}) => {
  const ctx = buildFilterEvalContext(tasks, s, NOW);
  return tasks.filter((t) => passesChips(t, ctx, opts)).map((t) => t.title);
};

describe('passesChips', () => {
  const home = mk({ title: 'home-todo' });
  const garden = mk({ title: 'garden-doing', project: 'Garden', phase: 'IN_PROGRESS' });
  const inbox = mk({ title: 'inbox', project: '' });
  const done = mk({ title: 'done', phase: 'COMPLETE' });
  const waiting = mk({ title: 'waiting', phase: 'WAITING' });
  const future = mk({ title: 'future', start_date: '2099-01-01' });
  const ms = mk({ title: 'ms', source: 'ms-todo', tags: ['label:urgent'], sprint: 'S1', priority: 'important' });
  const old = mk({ title: 'old', updated_at: '2026-01-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' });
  const tasks = [home, garden, inbox, done, waiting, future, ms, old];

  it('default: open statuses, available now', () => {
    expect(ids(tasks, S0)).toEqual(['home-todo', 'garden-doing', 'inbox', 'ms', 'old']);
  });
  it('Status is exact phases; Complete skips the date rule', () => {
    expect(ids(tasks, { ...S0, status: ['COMPLETE'] })).toEqual(['done']);
    expect(ids(tasks, { ...S0, status: ['WAITING'] })).toEqual(['waiting']);
    expect(ids(tasks, { ...S0, status: ['IN_PROGRESS'] })).toEqual(['garden-doing']);
  });
  it('Project matches case-insensitively and "" is Inbox', () => {
    expect(ids(tasks, { ...S0, projects: ['garden'] })).toEqual(['garden-doing']);
    expect(ids(tasks, { ...S0, projects: ['', 'Garden'] })).toEqual(['garden-doing', 'inbox']);
  });
  it('Source, Tags, Sprint, Priority, Time window', () => {
    expect(ids(tasks, { ...S0, sources: ['ms-todo'] })).toEqual(['ms']);
    expect(ids(tasks, { ...S0, tagsAny: ['label:urgent', 'x'] })).toEqual(['ms']);
    expect(ids(tasks, { ...S0, sprints: ['S1'] })).toEqual(['ms']);
    expect(ids(tasks, { ...S0, priorities: ['important'] })).toEqual(['ms']);
    expect(ids(tasks, { ...S0, time: { ...S0.time, preset: '7d' } })).not.toContain('old');
    expect(ids(tasks, { ...S0, time: { ...S0.time, preset: '7d' } })).toContain('home-todo');
  });
  it('Blocked needs the dependency set and builds it', () => {
    const dep = mk({ title: 'dep' });
    const blocked = mk({ title: 'blocked', depends_on: [dep.id] });
    expect(ids([dep, blocked], { ...S0, blocked: true })).toEqual(['blocked']);
    expect(ids([dep, blocked], { ...S0, blocked: false })).toEqual(['dep']);
  });
  it('Date: any date shows the future task; overdue uses the moved filter', () => {
    expect(ids(tasks, { ...S0, date: '' })).toContain('future');
    const late = mk({ title: 'late', due_date: '2020-01-01' });
    expect(ids([...tasks, late], { ...S0, date: 'overdue' })).toEqual(['late']);
    expect(matchesDateFilter(late, 'overdue', [late])).toBe(true);
  });
  it('only the default Date skips completed tasks; a picked Date applies to them too', () => {
    const doneLate = mk({ title: 'done-late', phase: 'COMPLETE', due_date: '2020-01-01' });
    const doneFuture = mk({ title: 'done-future', phase: 'COMPLETE', start_date: '2099-01-01' });
    const all = [...tasks, doneLate, doneFuture];
    const withDone = ['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE'] as FilterState['status'];
    expect(ids(all, { ...S0, status: withDone })).toEqual(expect.arrayContaining(['done', 'done-late', 'done-future']));
    expect(ids(all, { ...S0, status: withDone, date: 'overdue' })).toEqual(['done-late']);
  });
  it('bypassDefaults skips only default dimensions (search, 5.7)', () => {
    expect(ids(tasks, S0, { bypassDefaults: true })).toEqual(tasks.map((t) => t.title));
    expect(ids(tasks, { ...S0, projects: ['Garden'] }, { bypassDefaults: true })).toEqual(['garden-doing']);
    expect(ids(tasks, { ...S0, status: ['COMPLETE'] }, { bypassDefaults: true })).toEqual(['done']);
    expect(ids(tasks, { ...S0, date: 'overdue' }, { bypassDefaults: true })).toEqual([]);
  });
  it('except leaves one dimension out (footer counts, 5.6)', () => {
    const s = { ...S0, projects: ['Home'] };
    expect(ids(tasks, s, { except: 'status' })).toEqual(['home-todo', 'done', 'waiting', 'ms', 'old']);
    expect(ids(tasks, s, { except: ['status', 'date'] })).toEqual(['home-todo', 'done', 'waiting', 'future', 'ms', 'old']);
  });
});

describe('failingDims and reasons (5.12)', () => {
  const done = mk({ title: 'done', phase: 'COMPLETE', project: 'Home' });
  const later = mk({ title: 'later', start_date: '2099-01-01', project: 'Home' });
  const tasks = [done, later];

  it('lists every failing dimension in registry order', () => {
    const ctx = buildFilterEvalContext(tasks, { ...S0, projects: ['Garden'] }, NOW);
    expect(failingDims(done, ctx)).toEqual(['status', 'project']);
    expect(failingDims(later, ctx)).toEqual(['project', 'date']);
    expect(failingDims(later, ctx, { bypassDefaults: true })).toEqual(['project']);
  });
  it('reasons use the chip words, default dims included', () => {
    const ctx = buildFilterEvalContext(tasks, { ...S0, projects: ['Garden'] }, NOW);
    const r = hiddenByReasons(done, ctx);
    expect(r.map((x) => x.text)).toEqual(['Hidden by Status: Open', 'Hidden by Project: Garden']);
    expect(r[1].ariaLabel).toBe('Show tasks hidden by Project: Garden');
    expect(hiddenByReasons(later, ctx).map((x) => x.text)).toEqual(['Hidden by Project: Garden', 'Hidden by Date: Available now']);
    const text = hiddenByText(r);
    expect(text).toBe('Hidden by Status: Open, Hidden by Project: Garden');
    expect(text).not.toMatch(/≠|·|phase/);
  });
  it('Show widens exactly that dimension so the task becomes a hit', () => {
    let s: FilterState = { ...S0, projects: ['Garden'] };
    s = showValueFor(s, done, 'status');
    expect(s.status).toEqual(['TODO', 'IN_PROGRESS', 'NEED_ACTION', 'COMPLETE']);
    s = showValueFor(s, done, 'project');
    expect(s.projects).toEqual(['Garden', 'Home']);
    const ctx = buildFilterEvalContext(tasks, s, NOW);
    expect(passesChips(done, ctx)).toBe(true);
    expect(showValueFor(S0, later, 'date').date).toBe('');
    expect(showValueFor({ ...S0, projects: ['Garden'] }, mk({ project: '' }), 'project').projects).toEqual(['Garden', '']);
  });
});
