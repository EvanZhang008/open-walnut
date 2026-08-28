/**
 * Liveness penalty for completed tasks in ranked task search.
 * Deterministic: WALNUT_DISABLE_SEARCH=1 routes the task lane to bm25, and the
 * penalty applies AFTER lane assembly, so it is exercised identically.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import { WALNUT_HOME } from '../../src/constants.js';
import {
  completedLivenessPenalty,
  LIVENESS_HALF_LIFE_DAYS,
  LIVENESS_PENALTY_MAX,
  search,
} from '../../src/core/search.js';
import { addTaskFull, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';

const prevDisable = process.env.WALNUT_DISABLE_SEARCH;
process.env.WALNUT_DISABLE_SEARCH = '1';
afterAll(() => {
  if (prevDisable === undefined) delete process.env.WALNUT_DISABLE_SEARCH;
  else process.env.WALNUT_DISABLE_SEARCH = prevDisable;
});

const NOW = Date.parse('2026-08-28T00:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('completedLivenessPenalty', () => {
  it('is zero for anything not completed', () => {
    expect(completedLivenessPenalty({ phase: 'IN_PROGRESS', updated_at: daysAgo(400) }, NOW)).toBe(0);
    expect(completedLivenessPenalty({ phase: 'TODO' }, NOW)).toBe(0);
    expect(completedLivenessPenalty({ phase: 'AGENT_COMPLETE', updated_at: daysAgo(90) }, NOW)).toBe(0);
  });

  it('barely touches a fresh completion and saturates on old history', () => {
    const fresh = completedLivenessPenalty({ phase: 'COMPLETE', completed_at: daysAgo(0.5) }, NOW);
    expect(fresh).toBeLessThan(0);
    expect(fresh).toBeGreaterThan(-0.01);

    const half = completedLivenessPenalty({ phase: 'COMPLETE', completed_at: daysAgo(LIVENESS_HALF_LIFE_DAYS) }, NOW);
    expect(half).toBeCloseTo(-LIVENESS_PENALTY_MAX / 2, 3);

    const old = completedLivenessPenalty({ phase: 'COMPLETE', completed_at: daysAgo(365) }, NOW);
    expect(old).toBeCloseTo(-LIVENESS_PENALTY_MAX, 3);
  });

  it('treats status done and a missing date as fully stale', () => {
    expect(completedLivenessPenalty({ status: 'done' }, NOW)).toBeCloseTo(-LIVENESS_PENALTY_MAX, 6);
  });

  it('falls back to updated_at when completed_at is absent', () => {
    const viaUpdated = completedLivenessPenalty({ phase: 'COMPLETE', updated_at: daysAgo(LIVENESS_HALF_LIFE_DAYS) }, NOW);
    expect(viaUpdated).toBeCloseTo(-LIVENESS_PENALTY_MAX / 2, 3);
  });
});

describe('search() task lane with liveness', () => {
  // closeDb BEFORE rm — the task db is a module-level sqlite singleton;
  // deleting its file under a live handle leaks state across tests.
  beforeEach(async () => {
    closeDb();
    _resetForTesting();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });
  afterEach(async () => {
    closeDb();
    _resetForTesting();
    await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  });

  const baseTask = {
    description: '', note: '', project: '', source: 'local' as const, status: 'todo' as const,
    priority: 'none' as const, created_at: daysAgo(200), updated_at: daysAgo(200),
  };

  it('sinks a stale completed task below an equally-relevant running one', async () => {
    const doneTask = await addTaskFull({
      ...baseTask,
      title: 'daemon reconnect retry storm mitigation',
      phase: 'COMPLETE', status: 'done', completed_at: daysAgo(120),
    } as never);
    const liveTask = await addTaskFull({
      ...baseTask,
      title: 'daemon reconnect retry storm mitigation v2',
      phase: 'IN_PROGRESS', status: 'in_progress',
    } as never);

    const rows = await search('daemon reconnect retry storm', { types: ['task'] });
    const ids = rows.map((r) => r.taskId);
    expect(ids).toContain(doneTask.id);
    expect(ids).toContain(liveTask.id);
    expect(ids.indexOf(liveTask.id)).toBeLessThan(ids.indexOf(doneTask.id));
  });

  it('keeps a strongly-matching completed task above a weakly-matching open one', async () => {
    const doneExact = await addTaskFull({
      ...baseTask,
      title: 'notification center two pane redesign',
      phase: 'COMPLETE', status: 'done', completed_at: daysAgo(120),
    } as never);
    const openWeak = await addTaskFull({
      ...baseTask,
      title: 'notification sound preference',
      phase: 'IN_PROGRESS', status: 'in_progress',
    } as never);

    const rows = await search('notification center two pane redesign', { types: ['task'] });
    const ids = rows.map((r) => r.taskId);
    expect(ids.indexOf(doneExact.id)).toBeLessThan(ids.indexOf(openWeak.id));
  });
});
