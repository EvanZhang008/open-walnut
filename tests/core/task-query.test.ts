import { describe, expect, it } from 'vitest';
import {
  COMPLETION_TO_PHASES,
  TaskQueryError,
  compareTasksForQuery,
  matchesTaskQuery,
  normalizeTaskQuery,
  type TaskCompletion,
  type TaskQuery,
  type TaskQuerySort,
} from '../../src/core/task-query.js';
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
  it('maps all seven phases to exactly one completion bucket', () => {
    const expected: Record<TaskPhase, TaskCompletion> = {
      TODO: 'todo',
      IN_PROGRESS: 'in_progress',
      AGENT_COMPLETE: 'in_progress',
      AWAIT_HUMAN_ACTION: 'in_progress',
      HUMAN_VERIFIED: 'in_progress',
      POST_WORK_COMPLETED: 'in_progress',
      COMPLETE: 'complete',
    };

    for (const [phase, completion] of Object.entries(expected) as [TaskPhase, TaskCompletion][]) {
      for (const candidate of ['todo', 'in_progress', 'complete'] as const) {
        expect(matchesTaskQuery(task({ phase }), query({ completion: [candidate] }))).toBe(candidate === completion);
      }
    }
    expect(COMPLETION_TO_PHASES.in_progress).toContain('HUMAN_VERIFIED');
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
    expect(matchesTaskQuery(fixture, query({ pinned: false, starred: false, needsAttention: false, blocked: false }), { blockedIds: new Set() })).toBe(true);
    expect(matchesTaskQuery(task({ pinned: true }), query({ pinned: false }))).toBe(false);
    expect(matchesTaskQuery(task({ pinned: true, starred: true, needs_attention: true }), query())).toBe(true);
  });

  it('computes effective starred from the task or a favorite project', () => {
    const fixture = task({ project: 'Walnut' });
    expect(matchesTaskQuery(fixture, query({ starred: true }), {
      favoriteProjects: new Set(['walnut']),
    })).toBe(true);
    expect(matchesTaskQuery(task({ starred: true }), query({ starred: true }))).toBe(true);
    expect(matchesTaskQuery(fixture, query({ starred: false }), {
      favoriteProjects: new Set(['walnut']),
    })).toBe(false);
    // Inbox tasks ('' project) can't be favorite-starred.
    expect(matchesTaskQuery(task({ project: '' }), query({ starred: true }), {
      favoriteProjects: new Set(['walnut']),
    })).toBe(false);
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

  it('rejects non-arrays where arrays are expected', () => {
    expectQueryError({ completion: 'todo' as unknown as TaskCompletion[] }, 'invalid_array');
    expectQueryError({ tagsAny: 'tag' as unknown as string[] }, 'invalid_array');
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

  it.each([0, 201])('rejects limit %s', (limit) => {
    expectQueryError({ limit }, 'invalid_limit');
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

  it('sorts title_asc with localeCompare', () => {
    const fixtures = [task({ id: 'b', title: 'Beta' }), task({ id: 'a', title: 'Alpha' })];
    expect(fixtures.sort((a, b) => compareTasksForQuery(a, b, 'title_asc')).map(({ id }) => id)).toEqual(['a', 'b']);
  });

  it.each(['updated_desc', 'created_desc', 'completed_desc', 'priority', 'title_asc'] as const)(
    'uses id ascending as the final tie-breaker for %s',
    (sort) => {
      const b = task({ id: 'b', title: 'Same', completed_at: '2026-01-12T00:00:00.000Z', priority: 'important' });
      const a = task({ id: 'a', title: 'Same', completed_at: '2026-01-12T00:00:00.000Z', priority: 'important' });
      expect([b, a].sort((left, right) => compareTasksForQuery(left, right, sort)).map(({ id }) => id)).toEqual(['a', 'b']);
    },
  );
});
