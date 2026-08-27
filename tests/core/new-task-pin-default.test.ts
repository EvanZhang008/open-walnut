/**
 * New tasks land on the board (2026-08-26).
 *
 * A task a PERSON or the AI creates is now born pinned with NO focus_tier, which
 * is how Satellite is stored — leaving new work off the board made it invisible
 * until someone remembered to pin it.
 *
 * The split this locks in:
 *   - `newTaskPinDefault()` fills in `true` only when the caller had no opinion.
 *   - `addTask({ pinned: true })` writes pin + pin_order in ONE store write, at
 *     the bottom of the pinned set (the same placement togglePin uses).
 *   - `addTask()` with no `pinned` stays UNPINNED. That is what keeps the
 *     automated creators (external-session import, provider/plugin sync, the
 *     reconciler's bulk pulls, routine runs) from flooding the board.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask, getTask, getPinnedTasks, getTierSplit, newTaskPinDefault,
  _resetForTesting as resetTaskManager,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { bus } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

async function rmWalnutHome(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      return;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

beforeEach(async () => {
  closeDb();
  resetTaskManager();
  await rmWalnutHome();
});

afterEach(async () => {
  bus.clear();
  closeDb();
  await rmWalnutHome();
});

describe('newTaskPinDefault', () => {
  it('defaults to the board and honors an explicit choice', () => {
    expect(newTaskPinDefault()).toBe(true);
    expect(newTaskPinDefault(undefined)).toBe(true);
    expect(newTaskPinDefault(true)).toBe(true);
    expect(newTaskPinDefault(false)).toBe(false);
    // Junk from a request body is NOT a choice — it must not read as "unpin".
    expect(newTaskPinDefault('false')).toBe(true);
    expect(newTaskPinDefault(0)).toBe(true);
    expect(newTaskPinDefault(null)).toBe(true);
  });
});

describe('addTask({ pinned: true })', () => {
  it('creates the task in Satellite: pinned, no stored focus_tier', async () => {
    const { task } = await addTask({ title: 'On the board', pinned: true });

    const stored = await getTask(task.id);
    expect(stored.pinned).toBe(true);
    expect(stored.focus_tier).toBeUndefined();
    expect(typeof stored.pin_order).toBe('number');

    const split = await getTierSplit();
    expect(split.pinned_tasks).toEqual([task.id]);
    expect(split.satellite_tasks).toEqual([task.id]);
    expect(split.focus_tasks).toEqual([]);
  });

  it('appends each new pin to the BOTTOM of the pinned set', async () => {
    const a = await addTask({ title: 'First', pinned: true });
    const b = await addTask({ title: 'Second', pinned: true });
    const c = await addTask({ title: 'Third', pinned: true });

    expect((await getPinnedTasks()).map((t) => t.id)).toEqual([a.task.id, b.task.id, c.task.id]);
    expect((await getPinnedTasks()).map((t) => t.pin_order)).toEqual([0, 1, 2]);
  });

  it('leaves the task off the board without an explicit pinned', async () => {
    // The importer/sync contract: silence means unpinned, so a high-volume pull
    // can never bury the working set.
    const { task } = await addTask({ title: 'Imported holder' });

    const stored = await getTask(task.id);
    expect(stored.pinned).toBeFalsy();
    expect(stored.pin_order).toBeUndefined();
    expect((await getTierSplit()).pinned_tasks).toEqual([]);
  });
});
