/**
 * task_get_bulk + the board counts on task_list, end to end through the real
 * executor and route. Born from board-triage friction: one task_get per row cost
 * a round trip each and answered the whole note (multiple KB) when the caller
 * only wanted title/phase/progress.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import express from 'express';
import { tasksRouter } from '../../src/web/routes/tasks.js';
import { errorHandler } from '../../src/web/middleware/error-handler.js';
import { addTask, updateNote, setFocusTier, updateTask, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { executeOp } from '../../src/ops/index.js';

const NOTE = '## Executive Summary\nsummary line\n\n## Progress\n- [DONE] first thing\n- [WIP] second thing\n\n'
  + '## Work Log\n- pages and pages of log detail\n';

let server: http.Server;
let apiBase: string;

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });

  const app = express();
  app.use(express.json());
  app.use('/api/tasks', tasksRouter);
  app.use(errorHandler);
  server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  apiBase = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function callOp(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
  const outcome = await executeOp(name, args, { apiBase });
  expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result as Record<string, unknown>;
}

describe('task_get_bulk op', () => {
  it('reads many tasks in one call, projected, in input order', async () => {
    const { task: one } = await addTask({ title: 'First', project: 'Acme' });
    const { task: two } = await addTask({ title: 'Second', project: 'Acme' });
    await updateNote(one.id, NOTE);

    const result = await callOp('task_get_bulk', {
      ids: [two.id, one.id],
      fields: ['title', 'phase', 'progress'],
    });
    expect(result.count).toBe(2);
    expect(result.errors).toBe(0);
    const tasks = result.tasks as Record<string, unknown>[];
    expect(tasks.map((t) => t.id)).toEqual([two.id, one.id]);
    expect(tasks[1].progress).toEqual([
      { status: 'DONE', text: 'first thing' },
      { status: 'WIP', text: 'second thing' },
    ]);
    expect(tasks[1].progress_counts).toMatchObject({ DONE: 1, WIP: 1 });
    // The projection is the point: no note in the reply.
    expect(JSON.stringify(result)).not.toContain('pages and pages');
  });

  it('mixes good rows with per-id errors', async () => {
    const { task } = await addTask({ title: 'Only real one' });
    const result = await callOp('task_get_bulk', { ids: [task.id, 'ghost'], fields: ['title'] });
    expect(result.errors).toBe(1);
    const tasks = result.tasks as Record<string, unknown>[];
    expect(tasks[0].title).toBe('Only real one');
    expect(tasks[1]).toEqual({ id: 'ghost', error: 'not found' });
  });

  it('rejects an empty, oversized or misspelled request before or at the route', async () => {
    const empty = await executeOp('task_get_bulk', { ids: [] }, { apiBase });
    expect(empty.ok).toBe(false);

    const tooMany = await executeOp(
      'task_get_bulk',
      { ids: Array.from({ length: 51 }, (_, i) => `id${i}`) },
      { apiBase },
    );
    expect(tooMany.ok).toBe(false);

    const badField = await executeOp('task_get_bulk', { ids: ['x'], fields: ['nope'] }, { apiBase });
    expect(badField.ok).toBe(false);
    if (!badField.ok) expect(badField.message).toMatch(/Unknown field/);
  });
});

describe('task_list working_set — authoritative board counts', () => {
  it('returns per-tier counts that add up to the board', async () => {
    const { task: focus } = await addTask({ title: 'Focus pin', pinned: true });
    await addTask({ title: 'Satellite pin', pinned: true });
    const { task: finished } = await addTask({ title: 'Finished pin', pinned: true });
    await addTask({ title: 'Unpinned' });
    await setFocusTier(focus.id, 'focus');
    await updateTask(finished.id, { phase: 'COMPLETE' });

    const result = await callOp('task_list', { working_set: true });
    const board = result.board as {
      pinned_total: number; pinned_active: number; pinned_completed: number;
      tiers: { tier: string; total: number; active: number }[];
    };
    expect(board.pinned_total).toBe(3);
    expect(board.pinned_active).toBe(2);
    expect(board.pinned_completed).toBe(1);
    // The whole reason the counts exist: compare them against your own bucketing.
    expect(result.count).toBe(board.pinned_total);
    expect(board.tiers.reduce((sum, t) => sum + t.total, 0)).toBe(board.pinned_total);
    const byTier = Object.fromEntries(board.tiers.map((t) => [t.tier, t]));
    expect(byTier.focus).toMatchObject({ total: 1, active: 1 });
    expect(byTier.satellite).toMatchObject({ total: 2, active: 1 });
  });

  it('a non-board query carries no counts', async () => {
    await addTask({ title: 'Plain' });
    const result = await callOp('task_list', {});
    expect(result.board).toBeUndefined();
  });
});
