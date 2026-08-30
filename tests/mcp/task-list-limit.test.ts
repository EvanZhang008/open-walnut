/**
 * task_list page-size contract, end to end through the real executor + route.
 *
 * Regression guard (2026-08-30): the op declared `limit` with a zod
 * `.default(50)`, which was injected BEFORE anything could notice the call was a
 * board read — so `task_list {"working_set":true}` answered 50 rows of a 120-pin
 * board and reported `count: 50` with no sign that the rest existed. A board
 * review then reported 13 satellite tasks out of 36 and concluded the missing
 * ones had disappeared.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import http from 'node:http';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import express from 'express';
import { tasksRouter } from '../../src/web/routes/tasks.js';
import { errorHandler } from '../../src/web/middleware/error-handler.js';
import { addTask, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';
import { executeOp } from '../../src/ops/index.js';

/** Board size deliberately above the 50-row default page size. */
const BOARD_SIZE = 62;

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
  const port = typeof address === 'object' && address ? address.port : 0;
  apiBase = `http://127.0.0.1:${port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

async function callTaskList(args: Record<string, unknown>): Promise<{
  count: number; total: number; truncated: boolean; hint?: string; tasks: { id: string }[];
}> {
  const outcome = await executeOp('task_list', args, { apiBase });
  expect(outcome.ok, outcome.ok ? '' : outcome.message).toBe(true);
  if (!outcome.ok) throw new Error(outcome.message);
  return outcome.result as never;
}

describe('task_list op — page size and truncation visibility', () => {
  it('working_set returns the ENTIRE pinned board, past the default page size', async () => {
    for (let i = 0; i < BOARD_SIZE; i++) {
      await addTask({ title: `Pin ${String(i).padStart(3, '0')}`, pinned: true });
    }
    await addTask({ title: 'Off the board' });

    const board = await callTaskList({ working_set: true });
    expect(board.count).toBe(BOARD_SIZE);
    expect(board.total).toBe(BOARD_SIZE);
    expect(board.truncated).toBe(false);
    expect(board.hint).toBeUndefined();
    expect(board.tasks).toHaveLength(BOARD_SIZE);
  });

  it('an EXPLICIT limit still applies to working_set, and says so', async () => {
    for (let i = 0; i < BOARD_SIZE; i++) {
      await addTask({ title: `Pin ${String(i).padStart(3, '0')}`, pinned: true });
    }

    const capped = await callTaskList({ working_set: true, limit: 10 });
    expect(capped.count).toBe(10);
    expect(capped.total).toBe(BOARD_SIZE);
    expect(capped.truncated).toBe(true);
    expect(capped.hint).toMatch(/10 of 62/);
  });

  it('an unfiltered query keeps the 50-row default but flags the cut', async () => {
    for (let i = 0; i < BOARD_SIZE; i++) {
      await addTask({ title: `Task ${String(i).padStart(3, '0')}` });
    }

    const page = await callTaskList({});
    expect(page.count).toBe(50);
    expect(page.total).toBe(BOARD_SIZE);
    expect(page.truncated).toBe(true);
    expect(page.hint).toMatch(/CUT/);
  });

  it('a focus_tier filter under the default limit is flagged the same way', async () => {
    for (let i = 0; i < BOARD_SIZE; i++) {
      await addTask({ title: `Satellite ${String(i).padStart(3, '0')}`, pinned: true });
    }

    // Satellite = pinned with NO stored tier, i.e. every row above.
    const tier = await callTaskList({ focus_tier: 'satellite' });
    expect(tier.count).toBe(50);
    expect(tier.total).toBe(BOARD_SIZE);
    expect(tier.truncated).toBe(true);

    // Raising the limit reaches the whole tier and clears the flag.
    const full = await callTaskList({ focus_tier: 'satellite', limit: 200 });
    expect(full.count).toBe(BOARD_SIZE);
    expect(full.truncated).toBe(false);
  });

  it('a result that fits reports truncated=false with total == count', async () => {
    await addTask({ title: 'Only one' });
    const page = await callTaskList({});
    expect(page).toMatchObject({ count: 1, total: 1, truncated: false });
  });
});
