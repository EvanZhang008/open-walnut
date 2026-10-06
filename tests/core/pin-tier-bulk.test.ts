/**
 * setPinTierBulk — pin, retier or unpin many tasks in one store write.
 *
 * The folder and project menus' "Pinned" row acts on every open task inside the
 * folder (50+ is normal). The per-task focus routes cost two requests each, so
 * the bulk call must keep the per-task rules of togglePin / setFocusTier exactly:
 *   - new pins land at the BOTTOM, in the caller's order (nextPinOrder per task)
 *   - satellite is stored as NO focus_tier
 *   - no NEW pin on a completed task (reported, the rest still apply)
 *   - an unknown tier throws before anything is touched
 *   - unpin compacts the remaining pin_orders to 0..n-1
 *   - one TASK_UPDATED per changed task, no CONFIG_CHANGED (the route sends it)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask, getTask, togglePin, setFocusTier, completeTask, getPinnedTasks, getTierSplit,
  createCustomTier, setPinTierBulk,
  _resetForTesting as resetTaskManager,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
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
  vi.restoreAllMocks();
  bus.clear();
  closeDb();
  await rmWalnutHome();
});

async function make(title: string): Promise<string> {
  const { task } = await addTask({ title, project: 'Marina' });
  return task.id;
}

async function pinned(title: string): Promise<string> {
  const id = await make(title);
  await togglePin(id);
  return id;
}

const ids = (tasks: Array<{ id: string }>) => tasks.map((t) => t.id);

describe('setPinTierBulk: pinning', () => {
  it('pins unpinned tasks into Focus at the bottom, in the caller order', async () => {
    const existing = await pinned('Existing');
    const existingOrder = (await getTask(existing)).pin_order ?? 0;
    const a = await make('A');
    const b = await make('B');
    const c = await make('C');

    const { changed, failed, split } = await setPinTierBulk([c, a, b], 'focus');

    expect(failed).toEqual([]);
    expect(ids(changed)).toEqual([c, a, b]);
    const orders: number[] = [];
    for (const id of [c, a, b]) {
      const t = await getTask(id);
      expect(t.pinned).toBe(true);
      expect(t.focus_tier).toBe('focus');
      orders.push(t.pin_order ?? -1);
    }
    expect(orders[0]).toBeGreaterThan(existingOrder);
    expect(orders[1]).toBeGreaterThan(orders[0]);
    expect(orders[2]).toBeGreaterThan(orders[1]);
    expect(split.focus_tasks).toEqual([c, a, b]);
    expect(split.pinned_tasks).toEqual([existing, c, a, b]);
    expect(split).toEqual(await getTierSplit());
  });

  it('stores satellite as no focus_tier', async () => {
    const a = await pinned('A');
    await setFocusTier(a, 'focus');
    const b = await make('B');

    const { changed } = await setPinTierBulk([a, b], 'satellite');

    expect(ids(changed)).toEqual([a, b]);
    for (const id of [a, b]) {
      const t = await getTask(id);
      expect(t.pinned).toBe(true);
      expect(t.focus_tier).toBeUndefined();
    }
    expect((await getTierSplit()).satellite_tasks).toEqual([a, b]);
  });

  it('retiers already-pinned tasks and keeps their pin_order', async () => {
    const a = await pinned('A');
    const b = await pinned('B');
    await setFocusTier(b, 'focus');
    const c = await make('C');
    const orderA = (await getTask(a)).pin_order;
    const orderB = (await getTask(b)).pin_order;

    const { changed, split } = await setPinTierBulk([a, b, c], 'wait');

    expect(ids(changed)).toEqual([a, b, c]);
    expect((await getTask(a)).pin_order).toBe(orderA);
    expect((await getTask(b)).pin_order).toBe(orderB);
    expect(split.wait_tasks).toEqual([a, b, c]);
    expect(split.focus_tasks).toEqual([]);
  });

  it('leaves a task already in the target tier out of changed', async () => {
    const a = await pinned('A');
    await setFocusTier(a, 'focus');
    const before = await getTask(a);
    const b = await make('B');

    const { changed, failed } = await setPinTierBulk([a, b], 'focus');

    expect(ids(changed)).toEqual([b]);
    expect(failed).toEqual([]);
    expect((await getTask(a)).updated_at).toBe(before.updated_at);
  });

  it('reads a retired tier name as its successor (backlog lands in wait)', async () => {
    const a = await make('A');
    const { changed } = await setPinTierBulk([a], 'backlog');
    expect(ids(changed)).toEqual([a]);
    expect((await getTask(a)).focus_tier).toBe('wait');
  });

  it('accepts a registered custom tier id', async () => {
    const { tier } = await createCustomTier('Marina review');
    const a = await make('A');
    const b = await pinned('B');

    const { changed, split } = await setPinTierBulk([a, b], tier.id);

    expect(ids(changed)).toEqual([a, b]);
    expect((await getTask(a)).focus_tier).toBe(tier.id);
    expect((await getTask(b)).focus_tier).toBe(tier.id);
    expect(split.custom_tier_tasks[tier.id]).toEqual([b, a]);
  });
});

describe('setPinTierBulk: partial failure', () => {
  it('refuses a NEW pin on a completed task while the others apply', async () => {
    const done = await make('Done');
    await completeTask(done);
    const a = await make('A');

    const { changed, failed } = await setPinTierBulk([done, a], 'focus');

    expect(ids(changed)).toEqual([a]);
    expect(failed).toEqual([{ id: done, ok: false, error: 'complete' }]);
    expect((await getTask(done)).pinned).toBeFalsy();
    expect((await getTask(a)).pinned).toBe(true);
  });

  it('retiers a completed task that was ALREADY pinned (an existing pin survives completion)', async () => {
    const done = await pinned('Done');
    await completeTask(done);

    const { changed, failed } = await setPinTierBulk([done], 'focus');

    expect(ids(changed)).toEqual([done]);
    expect(failed).toEqual([]);
    expect((await getTask(done)).focus_tier).toBe('focus');
  });

  it('reports a missing id as not_found', async () => {
    const a = await make('A');
    const { changed, failed } = await setPinTierBulk(['no-such-task', a], 'focus');
    expect(ids(changed)).toEqual([a]);
    expect(failed).toEqual([{ id: 'no-such-task', ok: false, error: 'not_found' }]);
  });

  it('throws on an unknown tier and changes nothing', async () => {
    const a = await make('A');
    const b = await pinned('B');
    const before = await getTierSplit();
    const emit = vi.spyOn(bus, 'emit');

    await expect(setPinTierBulk([a, b], 'not-a-tier')).rejects.toThrow(/^Unknown tier/);
    // A ct_* id that is not registered is just as unknown.
    await expect(setPinTierBulk([a, b], 'ct_missing')).rejects.toThrow(/^Unknown tier/);

    expect((await getTask(a)).pinned).toBeFalsy();
    expect((await getTask(b)).focus_tier).toBeUndefined();
    expect(await getTierSplit()).toEqual(before);
    expect(emit).not.toHaveBeenCalled();
  });

  it('handles a duplicated id once', async () => {
    const a = await make('A');
    const b = await make('B');

    const { changed } = await setPinTierBulk([a, b, a], 'focus');

    expect(ids(changed)).toEqual([a, b]);
    expect((await getPinnedTasks()).filter((t) => t.id === a)).toHaveLength(1);
    expect((await getTask(a)).pin_order).toBeLessThan((await getTask(b)).pin_order ?? 0);
  });
});

describe('setPinTierBulk: unpinning', () => {
  it('unpins and compacts the remaining pin_orders to 0..n-1', async () => {
    const a = await pinned('A');
    const b = await pinned('B');
    const c = await pinned('C');
    const d = await pinned('D');
    const e = await pinned('E');
    await setFocusTier(b, 'focus');
    const loose = await make('Never pinned');

    const { changed, failed, split } = await setPinTierBulk([b, d, loose], null);

    expect(ids(changed)).toEqual([b, d]);
    expect(failed).toEqual([]);
    for (const id of [b, d]) {
      const t = await getTask(id);
      expect(t.pinned).toBe(false);
      expect(t.pin_order).toBeUndefined();
      expect(t.focus_tier).toBeUndefined();
    }
    const remaining = await getPinnedTasks();
    expect(ids(remaining)).toEqual([a, c, e]);
    expect(remaining.map((t) => t.pin_order)).toEqual([0, 1, 2]);
    expect(split.pinned_tasks).toEqual([a, c, e]);
  });

  it('is a no-op for tasks that are not pinned', async () => {
    const a = await make('A');
    const emit = vi.spyOn(bus, 'emit');
    const { changed, failed } = await setPinTierBulk([a], null);
    expect(changed).toEqual([]);
    expect(failed).toEqual([]);
    expect(emit).not.toHaveBeenCalled();
  });

  it('unpins a completed pinned task', async () => {
    const done = await pinned('Done');
    await completeTask(done);
    const { changed } = await setPinTierBulk([done], null);
    expect(ids(changed)).toEqual([done]);
    expect((await getTask(done)).pinned).toBe(false);
  });
});

describe('setPinTierBulk: events', () => {
  it('emits one pin-scoped TASK_UPDATED per changed task and no CONFIG_CHANGED', async () => {
    const a = await make('A');
    const b = await pinned('B');
    await setFocusTier(b, 'focus');
    const c = await make('C');
    const emit = vi.spyOn(bus, 'emit');

    // b is already in Focus: a no-op, so it gets no event.
    await setPinTierBulk([a, b, c], 'focus');

    const updates = emit.mock.calls.filter(([name]) => name === EventNames.TASK_UPDATED);
    expect(updates.map(([, data]) => (data as { task: { id: string } }).task.id)).toEqual([a, c]);
    for (const [, data, destinations, options] of updates) {
      expect((data as { fields: string[] }).fields).toEqual(['pinned', 'pin_order', 'focus_tier']);
      expect(destinations).toEqual(['web-ui']);
      expect(options).toEqual({ source: 'internal' });
    }
    expect(emit.mock.calls.filter(([name]) => name === EventNames.CONFIG_CHANGED)).toEqual([]);
  });
});
