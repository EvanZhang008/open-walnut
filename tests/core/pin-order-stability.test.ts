/**
 * Pin order must be STABLE (2026-08-22 fix).
 *
 * Reported: "它的 order 一直在变 … 我把这个东西拖到最前面然后 … 如果是有新的
 * conversation … 它就会直接跑到最前面". Two independent server-side causes:
 *
 *  1. togglePin() prepended (pin_order = min - 1). Pinning is also AUTOMATIC — a fork
 *     inherits its source's pin, a launcher can pin with a preset tier — so a new
 *     arrival silently rewrote a hand-arranged order. Worse, the pinned area anchors a
 *     group at its FIRST member, so an auto-pinned fork that joined an existing group
 *     dragged that whole group to the very top.
 *  2. reorderPins() only renumbered the ids it was handed, and callers legitimately
 *     hand it a SUBSET (the panel builds its order from the rendered tiers, which
 *     exclude a hidden group's members). Those excluded rows kept their old pin_order,
 *     which then COLLIDED with the fresh 0..n-1 — and two tasks sharing a pin_order
 *     are ordered by their physical position in the store, so the list reshuffled on
 *     its own after unrelated writes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask, getTask, togglePin, reorderPins, getPinnedTasks, updateTaskRaw,
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

async function pin(title: string): Promise<string> {
  const { task } = await addTask({ title, project: 'Local' });
  await togglePin(task.id);
  return task.id;
}

const pinnedIds = async () => (await getPinnedTasks()).map((t) => t.id);

describe('togglePin placement', () => {
  it('appends each new pin to the bottom', async () => {
    const a = await pin('A');
    const b = await pin('B');
    const c = await pin('C');
    expect(await pinnedIds()).toEqual([a, b, c]);
  });

  it('does not disturb an order the user arranged by hand', async () => {
    const a = await pin('A');
    const b = await pin('B');
    const c = await pin('C');
    await reorderPins([c, a, b]);
    expect(await pinnedIds()).toEqual([c, a, b]);

    // A fork / new session lands and inherits a pin.
    const fresh = await pin('Fresh');
    expect(await pinnedIds()).toEqual([c, a, b, fresh]);
  });

  it('a new member of an existing group sorts LAST within that group', async () => {
    // The panel clusters a group at its first member's slot, so keeping the new
    // arrival last is what keeps the group's anchor (and every other row) put.
    const solo = await pin('Solo');
    const g1 = await pin('Group one');
    const g2 = await pin('Group two');
    await reorderPins([solo, g1, g2]);
    const forked = await pin('Forked member');

    const order = await pinnedIds();
    expect(order.indexOf(solo)).toBeLessThan(order.indexOf(g1));
    expect(order.indexOf(forked)).toBeGreaterThan(order.indexOf(g2));
  });

  it('reuses the freed slots after an unpin (no runaway drift)', async () => {
    const a = await pin('A');
    const b = await pin('B');
    await togglePin(a); // unpin — compacts the rest to 0..n
    const c = await pin('C');
    expect(await pinnedIds()).toEqual([b, c]);
    const orders = (await getPinnedTasks()).map((t) => t.pin_order);
    expect(orders).toEqual([0, 1]);
  });
});

describe('reorderPins renumbering', () => {
  it('gives every pinned task a unique, gap-free pin_order', async () => {
    const a = await pin('A');
    const b = await pin('B');
    const c = await pin('C');
    await reorderPins([c, b, a]);
    const orders = (await getPinnedTasks()).map((t) => t.pin_order);
    expect(orders).toEqual([0, 1, 2]);
  });

  it('renumbers pins the caller did NOT list, instead of leaving them colliding', async () => {
    const a = await pin('A');
    const b = await pin('B');
    const hidden = await pin('Hidden group member');
    // The panel's order excludes `hidden` (its group is collapsed out of the tiers).
    await reorderPins([b, a]);

    const tasks = await getPinnedTasks();
    const orders = tasks.map((t) => t.pin_order);
    expect(new Set(orders).size, `pin_order collision: ${JSON.stringify(orders)}`).toBe(3);
    expect(orders).toEqual([0, 1, 2]);
    // Listed ids take the front in the given order; the unlisted one follows.
    expect(tasks.map((t) => t.id)).toEqual([b, a, hidden]);
  });

  it('converges: the same subset reorder twice yields the same order', async () => {
    const a = await pin('A');
    const b = await pin('B');
    const hidden = await pin('Hidden');
    await reorderPins([b, a]);
    const first = await pinnedIds();
    await reorderPins([b, a]);
    expect(await pinnedIds()).toEqual(first);
    expect(first).toEqual([b, a, hidden]);
  });

  it('a subset reorder survives an unrelated write to another task', async () => {
    // The original symptom: after the collision, any later write flipped the order.
    const a = await pin('A');
    const b = await pin('B');
    const hidden = await pin('Hidden');
    await reorderPins([b, a]);
    const before = await pinnedIds();

    await updateTaskRaw(hidden, { description: 'touched' });
    expect(await pinnedIds()).toEqual(before);
    expect((await getTask(a)).pinned).toBe(true);
  });

  it('ignores ids that are not pinned', async () => {
    const a = await pin('A');
    const { task: loose } = await addTask({ title: 'Not pinned', project: 'Local' });
    await reorderPins([loose.id, a]);
    expect(await pinnedIds()).toEqual([a]);
    expect((await getTask(loose.id)).pin_order).toBeUndefined();
  });
});
