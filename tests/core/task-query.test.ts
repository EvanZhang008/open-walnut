import { describe, expect, it } from 'vitest';
import {
  COMPLETION_TO_PHASES,
  MAX_QUERY_LIMIT,
  QUERY_TASK_PHASES,
  TaskQueryError,
  compareTasksForQuery,
  computeBlockedIds,
  matchesTaskQuery,
  normalizeTaskPriority,
  normalizeTaskQuery,
  type TaskCompletion,
  type TaskQuery,
  type TaskQuerySort,
  type TimeBasis,
} from '../../src/core/task-query.js';
import { PHASE_ORDER } from '../../src/core/phase.js';
import type { Task, TaskPhase, TaskPriority } from '../../src/core/types.js';

const NOW = new Date('2026-01-15T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

function task(overrides: Partial<Task> = {}): Task {
  return {
    id: 'task-default',
    title: 'Default task',
    status: 'todo',
    priority: 'none',
    project: 'Walnut',
    session_ids: [],
    description: '',
    summary: '',
    note: '',
    phase: 'TODO',
    source: 'local',
    created_at: '2026-01-15T08:00:00.000Z',
    updated_at: '2026-01-15T10:00:00.000Z',
    ...overrides,
  };
}

function query(raw: TaskQuery = {}) {
  return normalizeTaskQuery(raw, NOW);
}

function expectQueryError(raw: TaskQuery, code?: string): void {
  try {
    normalizeTaskQuery(raw, NOW);
    throw new Error('Expected normalizeTaskQuery to throw');
  } catch (error) {
    expect(error).toBeInstanceOf(TaskQueryError);
    if (code) expect((error as TaskQueryError).code).toBe(code);
    expect((error as Error).message.length).toBeGreaterThan(0);
  }
}

describe('completion semantics', () => {
  // task-query.ts lists the 4 phases literally instead of importing PHASE_ORDER:
  // phase.ts drags in the logger (node:fs/os), and this module ships to the
  // browser bundle. This test is the seam that keeps the copy honest.
  it('keeps its phase list identical to PHASE_ORDER', () => {
    expect([...QUERY_TASK_PHASES]).toEqual([...PHASE_ORDER]);
    const mapped = Object.values(COMPLETION_TO_PHASES).flatMap((phases) => [...phases]);
    expect(mapped.slice().sort()).toEqual([...PHASE_ORDER].sort());
  });

  // (WAIT removed 2026-08-18 — five buckets became four; WAIT's in_progress
  // membership is gone with it.)
  it('maps all four phases to exactly one completion bucket', () => {
    const expected: Record<TaskPhase, TaskCompletion> = {
      TODO: 'todo',
      IN_PROGRESS: 'in_progress',
      AGENT_COMPLETE: 'in_progress',
      COMPLETE: 'complete',
    };

    for (const [phase, completion] of Object.entries(expected) as [TaskPhase, TaskCompletion][]) {
      for (const candidate of ['todo', 'in_progress', 'complete'] as const) {
        expect(matchesTaskQuery(task({ phase }), query({ completion: [candidate] }))).toBe(candidate === completion);
      }
    }
    // The agent-stopped-but-still-open phase stays in in_progress, so a handed-back
    // task can't vanish from the in_progress bucket.
    expect(COMPLETION_TO_PHASES.in_progress).toEqual(['IN_PROGRESS', 'AGENT_COMPLETE']);
    expect(COMPLETION_TO_PHASES.complete).toEqual(['COMPLETE']);
  });

  it('ORs completion values but ANDs completion with an exact phase filter', () => {
    expect(matchesTaskQuery(task({ phase: 'TODO' }), query({
      completion: ['todo', 'complete'],
      phases: ['TODO', 'IN_PROGRESS'],
    }))).toBe(true);
    expect(matchesTaskQuery(task({ phase: 'COMPLETE' }), query({
      completion: ['todo', 'complete'],
      phases: ['TODO', 'IN_PROGRESS'],
    }))).toBe(false);
  });
});

describe('field composition', () => {
  it('ORs values within fields and ANDs different fields', () => {
    const fixtures = [
      task({ id: 'match', phase: 'COMPLETE', pinned: true, project: 'Alpha', updated_at: '2026-01-15T07:00:00.000Z' }),
      task({ id: 'not-pinned', phase: 'COMPLETE', pinned: false, project: 'Alpha', updated_at: '2026-01-15T07:00:00.000Z' }),
      task({ id: 'too-old', phase: 'COMPLETE', pinned: true, project: 'alpha', updated_at: '2026-01-15T05:59:59.999Z' }),
      task({ id: 'wrong-project', phase: 'COMPLETE', pinned: true, project: 'Gamma', updated_at: '2026-01-15T07:00:00.000Z' }),
    ];
    const normalized = query({
      pinned: true,
      completion: ['complete'],
      projects: ['ALPHA', 'Beta'],
      time: { basis: 'updated', last: { value: 6, unit: 'hours' } },
    });

    expect(fixtures.filter((fixture) => matchesTaskQuery(fixture, normalized)).map(({ id }) => id)).toEqual(['match']);
  });

  it('folds a legacy priority into the canonical vocabulary', () => {
    // Rows written before the 4-tier vocabulary carry 'high'/'medium'/'low'.
    // sanitizePriority normalizes on WRITE only, so the query layer has to fold.
    expect(normalizeTaskPriority('high' as TaskPriority)).toBe('immediate');
    expect(normalizeTaskPriority('medium' as TaskPriority)).toBe('backlog');
    expect(normalizeTaskPriority('low' as TaskPriority)).toBe('backlog');
    expect(normalizeTaskPriority('important')).toBe('important');
    expect(normalizeTaskPriority(undefined)).toBeUndefined();

    const legacy = task({ priority: 'high' as TaskPriority });
    expect(matchesTaskQuery(legacy, query({ priorities: ['immediate'] }))).toBe(true);
    expect(matchesTaskQuery(legacy, query({ priorities: ['backlog'] }))).toBe(false);
    expect(matchesTaskQuery(task({ priority: 'medium' as TaskPriority }), query({ priorities: ['backlog'] }))).toBe(true);
  });

  it('matches priorities, sources, sprints, parent ids, and group ids exactly', () => {
    const fixture = task({
      priority: 'important', source: 'sync', sprint: 'S1', parent_task_id: 'parent-1', group_id: 'group-1',
    });
    expect(matchesTaskQuery(fixture, query({
      priorities: ['important', 'backlog'],
      sources: ['sync', 'local'],
      sprints: ['S1', 'S2'],
      parentTaskId: 'parent-1',
      groupId: 'group-1',
    }))).toBe(true);
    expect(matchesTaskQuery(fixture, query({ sources: ['SYNC'] }))).toBe(false);
    expect(matchesTaskQuery(fixture, query({ parentTaskId: 'parent' }))).toBe(false);
  });

  it('implements tagsAny, tagsAll, and their AND interaction with case-sensitive matching', () => {
    const fixture = task({ tags: ['red', 'Blue', 'shared'] });
    expect(matchesTaskQuery(fixture, query({ tagsAny: ['missing', 'red'] }))).toBe(true);
    expect(matchesTaskQuery(fixture, query({ tagsAny: ['RED'] }))).toBe(false);
    expect(matchesTaskQuery(fixture, query({ tagsAll: ['red', 'shared'] }))).toBe(true);
    expect(matchesTaskQuery(fixture, query({ tagsAll: ['red', 'missing'] }))).toBe(false);
    expect(matchesTaskQuery(fixture, query({ tagsAny: ['Blue'], tagsAll: ['red', 'shared'] }))).toBe(true);
    expect(matchesTaskQuery(fixture, query({ tagsAny: ['missing'], tagsAll: ['red', 'shared'] }))).toBe(false);
  });

  it('matches explicit false against absent booleans while undefined does not filter', () => {
    const fixture = task();
    expect(matchesTaskQuery(fixture, query({ pinned: false, unread: false, blocked: false }), { blockedIds: new Set() })).toBe(true);
    expect(matchesTaskQuery(task({ pinned: true }), query({ pinned: false }))).toBe(false);
    expect(matchesTaskQuery(task({ pinned: true, unread: true }), query())).toBe(true);
  });

  it('matches the unread marker in both directions, treating absent as read', () => {
    expect(matchesTaskQuery(task({ unread: true }), query({ unread: true }))).toBe(true);
    expect(matchesTaskQuery(task({ unread: true }), query({ unread: false }))).toBe(false);
    // Absent means READ — the whole reason the field is `unread` and not `is_read`.
    expect(matchesTaskQuery(task(), query({ unread: false }))).toBe(true);
    expect(matchesTaskQuery(task(), query({ unread: true }))).toBe(false);
    expect(matchesTaskQuery(task({ unread: false }), query({ unread: false }))).toBe(true);
  });

  it('uses blockedIds as the blocked source of truth', () => {
    const fixture = task({ id: 'blocked-task' });
    const ctx = { blockedIds: new Set(['blocked-task']) };
    expect(matchesTaskQuery(fixture, query({ blocked: true }), ctx)).toBe(true);
    expect(matchesTaskQuery(fixture, query({ blocked: false }), ctx)).toBe(false);
  });

  it('throws when query.blocked is set without ctx.blockedIds', () => {
    const fixture = task();
    expect(() => matchesTaskQuery(fixture, query({ blocked: true }))).toThrow(/blockedIds/);
    expect(() => matchesTaskQuery(fixture, query({ blocked: false }))).toThrow(/blockedIds/);
  });
});

describe('focusTiers', () => {
  // Tier belongs to the PINNED board only, and the DEFAULT tier is stored as an
  // ABSENT focus_tier — so the query value 'satellite' has to answer three
  // storage shapes (absent / '' / the literal string) while every other tier
  // ('focus' | 'backlog' | 'wait' | a custom 'ct_*' id) matches exactly.
  const cases: [string, Partial<Task>, string[], boolean][] = [
    ['pinned with no stored tier vs satellite', { pinned: true }, ['satellite'], true],
    ['pinned with an empty stored tier vs satellite', { pinned: true, focus_tier: '' }, ['satellite'], true],
    ['pinned with a literal satellite stored', { pinned: true, focus_tier: 'satellite' }, ['satellite'], true],
    ['pinned focus vs focus', { pinned: true, focus_tier: 'focus' }, ['focus'], true],
    ['pinned focus vs satellite', { pinned: true, focus_tier: 'focus' }, ['satellite'], false],
    ['pinned default vs focus', { pinned: true }, ['focus'], false],
    ['pinned custom tier vs itself', { pinned: true, focus_tier: 'ct_abc12345' }, ['ct_abc12345'], true],
    ['pinned custom tier vs another custom tier', { pinned: true, focus_tier: 'ct_abc12345' }, ['ct_zzz99999'], false],
    ['pinned custom tier vs satellite', { pinned: true, focus_tier: 'ct_abc12345' }, ['satellite'], false],
    // An unpinned row has no tier at all — not even the value it still stores.
    ['unpinned focus vs focus', { focus_tier: 'focus' }, ['focus'], false],
    ['unpinned focus vs satellite', { focus_tier: 'focus' }, ['satellite'], false],
    ['unpinned focus vs every tier', { focus_tier: 'focus' }, ['focus', 'satellite'], false],
    ['unpinned with no stored tier vs satellite', {}, ['satellite'], false],
    // Multiple tiers OR within the field.
    ['multi-tier hits the stored focus', { pinned: true, focus_tier: 'focus' }, ['focus', 'satellite'], true],
    ['multi-tier hits the absent tier', { pinned: true }, ['focus', 'satellite'], true],
    ['multi-tier misses an unlisted tier', { pinned: true, focus_tier: 'backlog' }, ['focus', 'satellite'], false],
    // [] matches nothing, same as every other array filter.
    ['empty list vs a pinned default row', { pinned: true }, [], false],
    ['empty list vs a pinned focus row', { pinned: true, focus_tier: 'focus' }, [], false],
  ];

  it.each(cases)('matches %s', (_label, overrides, focusTiers, expected) => {
    expect(matchesTaskQuery(task(overrides), query({ focusTiers }))).toBe(expected);
  });

  it('ANDs the tier filter with completion and projects', () => {
    const fixtures = [
      task({ id: 'match', pinned: true, focus_tier: 'focus', project: 'Alpha' }),
      task({ id: 'wrong-tier', pinned: true, focus_tier: 'backlog', project: 'Alpha' }),
      task({ id: 'wrong-project', pinned: true, focus_tier: 'focus', project: 'Gamma' }),
      task({ id: 'wrong-completion', pinned: true, focus_tier: 'focus', project: 'Alpha', phase: 'COMPLETE' }),
      task({ id: 'not-pinned', focus_tier: 'focus', project: 'Alpha' }),
    ];
    const normalized = query({ focusTiers: ['focus'], completion: ['todo'], projects: ['alpha'] });
    expect(fixtures.filter((fixture) => matchesTaskQuery(fixture, normalized)).map(({ id }) => id)).toEqual(['match']);
  });
});

describe('workingSet', () => {
  it('resolves to pinned=true with the pin_order default sort', () => {
    const normalized = query({ workingSet: true });
    expect(normalized.pinned).toBe(true);
    expect(normalized.sort).toBe('pin_order');
  });

  it('lets an explicit sort win over the pin_order default', () => {
    const normalized = query({ workingSet: true, sort: 'title_asc' });
    expect(normalized.pinned).toBe(true);
    expect(normalized.sort).toBe('title_asc');
  });

  it('accepts a redundant pinned:true', () => {
    const normalized = query({ workingSet: true, pinned: true });
    expect(normalized.pinned).toBe(true);
    expect(normalized.sort).toBe('pin_order');
  });

  // workingSet IS pinned=true, so an explicit pinned:false can only be a caller
  // bug — it errors instead of one side winning silently.
  it('rejects pinned:false alongside workingSet', () => {
    expectQueryError({ workingSet: true, pinned: false }, 'conflicting_working_set');
  });

  it('reaches the shared predicate as a plain pinned filter', () => {
    const normalized = query({ workingSet: true });
    expect(matchesTaskQuery(task({ pinned: true }), normalized)).toBe(true);
    expect(matchesTaskQuery(task(), normalized)).toBe(false);
  });
});

describe('q (title substring)', () => {
  it('matches a case-insensitive substring of the title', () => {
    const fixture = task({ title: 'Fix Login Flow' });
    expect(matchesTaskQuery(fixture, query({ q: 'login' }))).toBe(true);
    expect(matchesTaskQuery(fixture, query({ q: 'LOGIN' }))).toBe(true);
    expect(matchesTaskQuery(fixture, query({ q: 'x Log' }))).toBe(true);
    expect(matchesTaskQuery(fixture, query({ q: 'logout' }))).toBe(false);
  });

  it('trims q and turns a whitespace-only value into no condition', () => {
    expect(query({ q: '  login  ' }).q).toBe('login');
    expect(query({ q: '   ' }).q).toBeUndefined();
    expect(query({ q: '' }).q).toBeUndefined();
    // No condition filters NOTHING — it must not read as "matches nothing".
    expect(matchesTaskQuery(task({ title: 'Anything' }), query({ q: '   ' }))).toBe(true);
    expect(matchesTaskQuery(task({ title: 'Fix Login Flow' }), query({ q: '  login  ' }))).toBe(true);
  });

  // Title only: description/summary are deliberately not searched here.
  it('does not match the description or summary', () => {
    const fixture = task({ title: 'Untitled', description: 'login', summary: 'login' });
    expect(matchesTaskQuery(fixture, query({ q: 'login' }))).toBe(false);
  });

  it('rejects a non-string q', () => {
    expectQueryError({ q: 5 as unknown as string }, 'invalid_string');
  });
});

describe('ids', () => {
  it('matches exact ids only', () => {
    const fixtures = [task({ id: 'a' }), task({ id: 'b' }), task({ id: 'ab' })];
    const normalized = query({ ids: ['a', 'b'] });
    expect(fixtures.filter((fixture) => matchesTaskQuery(fixture, normalized)).map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('matches nothing for [] and filters nothing when absent', () => {
    expect(matchesTaskQuery(task({ id: 'a' }), query({ ids: [] }))).toBe(false);
    expect(query().ids).toBeUndefined();
    expect(matchesTaskQuery(task({ id: 'a' }), query())).toBe(true);
  });
});

describe('time matching', () => {
  it('uses inclusive lower and upper bounds for relative windows', () => {
    const normalized = query({ time: { basis: 'updated', last: { value: 6, unit: 'hours' } } });
    const lower = new Date(NOW.getTime() - 6 * HOUR);
    expect(matchesTaskQuery(task({ updated_at: lower.toISOString() }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ updated_at: NOW.toISOString() }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ updated_at: new Date(lower.getTime() - 1).toISOString() }), normalized)).toBe(false);
    expect(matchesTaskQuery(task({ updated_at: new Date(NOW.getTime() + 1).toISOString() }), normalized)).toBe(false);
  });

  it('uses an absolute half-open [from, until) window', () => {
    const normalized = query({ time: {
      basis: 'created',
      from: '2026-01-15T06:00:00.000Z',
      until: '2026-01-15T10:00:00.000Z',
    } });
    expect(matchesTaskQuery(task({ created_at: '2026-01-15T06:00:00.000Z' }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ created_at: '2026-01-15T09:59:59.999Z' }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ created_at: '2026-01-15T10:00:00.000Z' }), normalized)).toBe(false);
  });

  it('ORs created and updated timestamps for created_or_updated', () => {
    const normalized = query({ time: {
      basis: 'created_or_updated',
      from: '2026-01-15T06:00:00.000Z',
      until: '2026-01-15T10:00:00.000Z',
    } });
    expect(matchesTaskQuery(task({ created_at: '2026-01-15T07:00:00.000Z', updated_at: '2026-01-15T11:00:00.000Z' }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ created_at: '2026-01-15T05:00:00.000Z', updated_at: '2026-01-15T09:00:00.000Z' }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ created_at: '2026-01-15T05:00:00.000Z', updated_at: '2026-01-15T11:00:00.000Z' }), normalized)).toBe(false);
  });

  it('does not match missing, invalid, impossible, or future timestamps', () => {
    const normalized = query({ time: { basis: 'updated', last: { value: 6, unit: 'hours' } } });
    expect(matchesTaskQuery(task({ updated_at: undefined as unknown as string }), normalized)).toBe(false);
    expect(matchesTaskQuery(task({ updated_at: 'not-a-date' }), normalized)).toBe(false);
    expect(matchesTaskQuery(task({ updated_at: '2026-02-30T09:00:00.000Z' }), normalized)).toBe(false);
    expect(matchesTaskQuery(task({ updated_at: '2026-01-15T12:00:00.001Z' }), normalized)).toBe(false);
  });

  it('reads due_date for basis due, including a date-only stamp', () => {
    const normalized = query({ time: { basis: 'due', from: '2026-08-01', until: '2026-10-01' } });
    // due_date is commonly stored date-only, so that shape has to match.
    expect(matchesTaskQuery(task({ due_date: '2026-09-01' }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ due_date: '2026-09-01T12:00:00.000Z' }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ due_date: '2026-07-31' }), normalized)).toBe(false);
    // A row with no deadline can never answer a due window, even though its
    // created_at/updated_at would be in range for the other bases.
    expect(matchesTaskQuery(task(), normalized)).toBe(false);
  });

  it('keeps the due window half-open on bare date bounds', () => {
    const normalized = query({ time: { basis: 'due', from: '2026-09-01', until: '2026-09-03' } });
    expect(normalized.time).toEqual({
      basis: 'due',
      fromMs: Date.parse('2026-09-01T00:00:00.000Z'),
      untilMs: Date.parse('2026-09-03T00:00:00.000Z'),
      untilExclusive: true,
    });
    expect(matchesTaskQuery(task({ due_date: '2026-09-01' }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ due_date: '2026-09-03' }), normalized)).toBe(false);
  });

  it('reads completed_at for basis completed', () => {
    const normalized = query({ time: { basis: 'completed', last: { value: 6, unit: 'hours' } } });
    expect(matchesTaskQuery(task({ phase: 'COMPLETE', completed_at: '2026-01-15T09:00:00.000Z' }), normalized)).toBe(true);
    expect(matchesTaskQuery(task({ phase: 'COMPLETE', completed_at: '2026-01-15T01:00:00.000Z' }), normalized)).toBe(false);
    // An in-window updated_at must not stand in for a missing completed_at.
    expect(matchesTaskQuery(task({ updated_at: '2026-01-15T10:00:00.000Z' }), normalized)).toBe(false);
  });
});

describe('normalizeTaskQuery', () => {
  it('captures now once and resolves relative windows', () => {
    const normalized = query({ time: { basis: 'updated', last: { value: 6, unit: 'hours' } } });
    expect(normalized.now).toBe(NOW.getTime());
    expect(normalized.time).toEqual({
      basis: 'updated',
      fromMs: NOW.getTime() - 6 * HOUR,
      untilMs: NOW.getTime(),
      untilExclusive: false,
    });
  });

  it('rejects unknown enum values', () => {
    expectQueryError({ completion: ['other' as TaskCompletion] }, 'invalid_enum');
    expectQueryError({ phases: ['OTHER' as TaskPhase] }, 'invalid_enum');
    expectQueryError({ priorities: ['urgent' as TaskPriority] }, 'invalid_enum');
    expectQueryError({ sort: 'other' as TaskQuerySort }, 'invalid_enum');
    expectQueryError({ time: { basis: 'other' as 'updated', last: { value: 1, unit: 'hours' } } }, 'invalid_enum');
    expectQueryError({ time: { basis: undefined as unknown as 'updated' } }, 'invalid_enum');
    expectQueryError({ time: { basis: 'updated', last: { value: 1, unit: 'weeks' as 'hours' } } }, 'invalid_enum');
    expectQueryError({ time: { basis: 'updated', last: { value: 1, unit: undefined as unknown as 'hours' } } }, 'invalid_enum');
  });

  // The Record over each union makes these lists exhaustive at COMPILE time, so
  // a new sort key or time basis can't join the type without landing here too.
  it('accepts every declared sort and time basis', () => {
    const sorts: Record<TaskQuerySort, true> = {
      updated_desc: true,
      created_desc: true,
      completed_desc: true,
      priority: true,
      title_asc: true,
      pin_order: true,
    };
    for (const sort of Object.keys(sorts) as TaskQuerySort[]) {
      expect(query({ sort }).sort).toBe(sort);
    }

    const bases: Record<TimeBasis, true> = {
      created: true,
      updated: true,
      created_or_updated: true,
      due: true,
      completed: true,
    };
    for (const basis of Object.keys(bases) as TimeBasis[]) {
      expect(query({ time: { basis, last: { value: 1, unit: 'days' } } }).time?.basis).toBe(basis);
    }
  });

  it('rejects non-arrays where arrays are expected', () => {
    expectQueryError({ completion: 'todo' as unknown as TaskCompletion[] }, 'invalid_array');
    expectQueryError({ tagsAny: 'tag' as unknown as string[] }, 'invalid_array');
    expectQueryError({ focusTiers: 'focus' as unknown as string[] }, 'invalid_array');
    expectQueryError({ ids: 'task-1' as unknown as string[] }, 'invalid_array');
  });

  it('rejects an empty-string focus tier', () => {
    // '' is how the DEFAULT tier is STORED, never how it is queried — accepting
    // it would silently alias 'satellite'.
    expectQueryError({ focusTiers: [''] }, 'invalid_tier');
    expectQueryError({ focusTiers: ['focus', '  '] }, 'invalid_tier');
  });

  it('accepts a bare YYYY-MM-DD bound as UTC midnight', () => {
    const normalized = query({ time: { basis: 'updated', from: '2026-01-14', until: '2026-01-16' } });
    expect(normalized.time?.fromMs).toBe(Date.parse('2026-01-14T00:00:00.000Z'));
    expect(normalized.time?.untilMs).toBe(Date.parse('2026-01-16T00:00:00.000Z'));
    // Still a validated calendar date, not just an accepted shape.
    expectQueryError({ time: { basis: 'due', from: '2026-02-30' } }, 'invalid_timestamp');
    expectQueryError({ time: { basis: 'due', from: '2026-1-5' } }, 'invalid_timestamp');
  });

  it.each([0, -1, 1.5])('rejects invalid last.value %s', (value) => {
    expectQueryError({ time: { basis: 'updated', last: { value, unit: 'hours' } } }, 'invalid_last_value');
  });

  it('rejects relative windows over one year', () => {
    expectQueryError({ time: { basis: 'updated', last: { value: 8761, unit: 'hours' } } }, 'last_too_large');
    expectQueryError({ time: { basis: 'updated', last: { value: 366, unit: 'days' } } }, 'last_too_large');
  });

  it('rejects last combined with absolute bounds', () => {
    expectQueryError({ time: {
      basis: 'updated',
      last: { value: 1, unit: 'hours' },
      from: '2026-01-15T00:00:00.000Z',
    } }, 'conflicting_time_window');
  });

  it('rejects from >= until', () => {
    expectQueryError({ time: {
      basis: 'updated',
      from: '2026-01-15T10:00:00.000Z',
      until: '2026-01-15T10:00:00.000Z',
    } }, 'invalid_time_range');
    expectQueryError({ time: {
      basis: 'updated',
      from: '2026-01-15T11:00:00.000Z',
      until: '2026-01-15T10:00:00.000Z',
    } }, 'invalid_time_range');
  });

  it('rejects malformed and impossible ISO timestamps', () => {
    expectQueryError({ time: { basis: 'updated', from: 'not-a-date' } }, 'invalid_timestamp');
    expectQueryError({ time: { basis: 'updated', until: '2026-02-30T00:00:00.000Z' } }, 'invalid_timestamp');
  });

  it.each([0, MAX_QUERY_LIMIT + 1])('rejects limit %s', (limit) => {
    expectQueryError({ limit }, 'invalid_limit');
  });

  it('accepts the documented maximum limit', () => {
    expect(query({ limit: MAX_QUERY_LIMIT }).limit).toBe(MAX_QUERY_LIMIT);
  });
});

describe('computeBlockedIds', () => {
  it('blocks only on a RESOLVABLE non-COMPLETE dependency', () => {
    const done = task({ id: 'done', phase: 'COMPLETE' });
    const open = task({ id: 'open', phase: 'IN_PROGRESS' });
    const fixtures = [
      done,
      open,
      task({ id: 'no-deps' }),
      task({ id: 'waits-on-open', depends_on: ['open'] }),
      task({ id: 'waits-on-done', depends_on: ['done'] }),
      task({ id: 'waits-on-both', depends_on: ['done', 'open'] }),
      // An id nobody resolves does NOT block (same as isTaskBlocked).
      task({ id: 'waits-on-ghost', depends_on: ['gone'] }),
      task({ id: 'empty-deps', depends_on: [] }),
    ];
    expect([...computeBlockedIds(fixtures)].sort()).toEqual(['waits-on-both', 'waits-on-open']);
  });

  it('returns an empty set for an empty list', () => {
    expect(computeBlockedIds([]).size).toBe(0);
  });
});

describe('compareTasksForQuery', () => {
  it('sorts updated_desc and created_desc newest first', () => {
    const older = task({ id: 'older', created_at: '2026-01-10T00:00:00.000Z', updated_at: '2026-01-11T00:00:00.000Z' });
    const newer = task({ id: 'newer', created_at: '2026-01-12T00:00:00.000Z', updated_at: '2026-01-13T00:00:00.000Z' });
    expect([older, newer].sort((a, b) => compareTasksForQuery(a, b, 'updated_desc')).map(({ id }) => id)).toEqual(['newer', 'older']);
    expect([older, newer].sort((a, b) => compareTasksForQuery(a, b, 'created_desc')).map(({ id }) => id)).toEqual(['newer', 'older']);
  });

  it('sorts completed_desc newest first and missing completed_at last', () => {
    const fixtures = [
      task({ id: 'missing' }),
      task({ id: 'older', completed_at: '2026-01-10T00:00:00.000Z' }),
      task({ id: 'newer', completed_at: '2026-01-12T00:00:00.000Z' }),
    ];
    expect(fixtures.sort((a, b) => compareTasksForQuery(a, b, 'completed_desc')).map(({ id }) => id))
      .toEqual(['newer', 'older', 'missing']);
  });

  it('sorts priority by rank and then created_at descending', () => {
    const fixtures = [
      task({ id: 'none', priority: 'none' }),
      task({ id: 'backlog', priority: 'backlog' }),
      task({ id: 'important-old', priority: 'important', created_at: '2026-01-10T00:00:00.000Z' }),
      task({ id: 'important-new', priority: 'important', created_at: '2026-01-11T00:00:00.000Z' }),
      task({ id: 'immediate', priority: 'immediate' }),
      task({ id: 'missing', priority: undefined as unknown as TaskPriority }),
    ];
    expect(fixtures.sort((a, b) => compareTasksForQuery(a, b, 'priority')).map(({ id }) => id)).toEqual([
      'immediate', 'important-new', 'important-old', 'backlog', 'none', 'missing',
    ]);
  });

  it('ranks a legacy priority with its canonical tier, not below none', () => {
    const fixtures = [
      task({ id: 'none', priority: 'none' }),
      task({ id: 'legacy-high', priority: 'high' as TaskPriority, created_at: '2026-01-09T00:00:00.000Z' }),
      task({ id: 'immediate', priority: 'immediate', created_at: '2026-01-11T00:00:00.000Z' }),
      task({ id: 'backlog', priority: 'backlog' }),
    ];
    // 'high' folds to immediate, so it sits with the immediates (created_at
    // tie-break) rather than falling below 'none' on an unknown-rank 0.
    expect(fixtures.sort((a, b) => compareTasksForQuery(a, b, 'priority')).map(({ id }) => id))
      .toEqual(['immediate', 'legacy-high', 'backlog', 'none']);
  });

  it('sorts title_asc with localeCompare', () => {
    const fixtures = [task({ id: 'b', title: 'Beta' }), task({ id: 'a', title: 'Alpha' })];
    expect(fixtures.sort((a, b) => compareTasksForQuery(a, b, 'title_asc')).map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it('sorts pin_order ascending with orderless rows last', () => {
    const fixtures = [
      // A pin_order left on an UNPINNED row is stale bookkeeping, not a board
      // position, so it sorts with the orderless rows.
      task({ id: 'unpinned-with-order', pin_order: 1 }),
      task({ id: 'pinned-2', pinned: true, pin_order: 2 }),
      task({ id: 'pinned-0', pinned: true, pin_order: 0 }),
      task({ id: 'pinned-no-order', pinned: true }),
      task({ id: 'pinned-1', pinned: true, pin_order: 1 }),
    ];
    expect(fixtures.sort((a, b) => compareTasksForQuery(a, b, 'pin_order')).map(({ id }) => id)).toEqual([
      'pinned-0', 'pinned-1', 'pinned-2', 'pinned-no-order', 'unpinned-with-order',
    ]);
  });

  it('breaks a pin_order tie by updated_at descending, then id', () => {
    const fixtures = [
      task({ id: 'same-b', pinned: true, pin_order: 3, updated_at: '2026-01-15T10:00:00.000Z' }),
      task({ id: 'same-a', pinned: true, pin_order: 3, updated_at: '2026-01-15T10:00:00.000Z' }),
      task({ id: 'newer', pinned: true, pin_order: 3, updated_at: '2026-01-15T11:00:00.000Z' }),
    ];
    expect(fixtures.sort((a, b) => compareTasksForQuery(a, b, 'pin_order')).map(({ id }) => id))
      .toEqual(['newer', 'same-a', 'same-b']);
  });

  it.each(['updated_desc', 'created_desc', 'completed_desc', 'priority', 'title_asc', 'pin_order'] as const)(
    'uses id ascending as the final tie-breaker for %s',
    (sort) => {
      const b = task({ id: 'b', title: 'Same', completed_at: '2026-01-12T00:00:00.000Z', priority: 'important' });
      const a = task({ id: 'a', title: 'Same', completed_at: '2026-01-12T00:00:00.000Z', priority: 'important' });
      expect([b, a].sort((left, right) => compareTasksForQuery(left, right, sort)).map(({ id }) => id)).toEqual(['a', 'b']);
    },
  );
});
