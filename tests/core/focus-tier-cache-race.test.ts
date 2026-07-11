/**
 * Regression test — focus-tier read-cache race (fork/quick-start landed in
 * Satellite despite focus_tier=focus).
 *
 * Root cause: setFocusTier() emits config:changed{focus_bar} INSIDE the write
 * lock, after writeStore(). The whole-store read cache used to be invalidated
 * only in withWriteLock.finally — i.e. AFTER the emit — so a subscriber that
 * reacted to the event synchronously (browser GET /api/focus/tasks) could be
 * served the pre-write snapshot: task pinned but focus_tier missing → bucketed
 * into satellite_tasks by the "satellite is default" filter.
 *
 * The fix invalidates the cache at the tail of writeStore() itself, so any
 * read triggered by an in-lock emit sees committed data. This test subscribes
 * to the bus and performs the read exactly where the racing browser request
 * landed: synchronously inside the emit.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  addTask,
  togglePin,
  setFocusTier,
  getPinnedTasks,
  _resetForTesting as resetTaskManager,
} from '../../src/core/task-manager.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  resetTaskManager();
});

afterEach(async () => {
  bus.clear();
  for (let i = 0; i < 3; i++) {
    try {
      await fs.rm(WALNUT_HOME, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
});

describe('focus-tier read served from inside the setFocusTier emit', () => {
  it('sees the committed tier (cache invalidated before the in-lock emit)', async () => {
    const { task } = await addTask({ title: 'Race repro task', category: 'Local' });
    await togglePin(task.id);

    // Subscribe like the WS-forwarding path does; on the focus_bar event, read
    // pinned tasks THROUGH THE PUBLIC READ PATH (same store the route handler
    // uses). Before the fix this returned the stale pre-setFocusTier snapshot.
    const readsDuringEmit: Promise<{ id: string; focus_tier?: string }[]>[] = [];
    // global:true — the emit targets ['web-ui'], and non-global subscribers not
    // in the destination list are skipped (this mirrors the WS-forwarding
    // subscriber, which IS the 'web-ui' destination in prod).
    bus.subscribe('race-probe', (event) => {
      if (event.name !== EventNames.CONFIG_CHANGED) return;
      const { key } = event.data as { key?: string };
      if (key !== 'focus_bar') return;
      readsDuringEmit.push(
        getPinnedTasks().then((ts) => ts.map((t) => ({ id: t.id, focus_tier: t.focus_tier }))),
      );
    }, { global: true });

    await setFocusTier(task.id, 'focus');

    expect(readsDuringEmit.length).toBeGreaterThan(0);
    for (const read of readsDuringEmit) {
      const pinned = await read;
      const row = pinned.find((t) => t.id === task.id);
      expect(row).toBeTruthy();
      // The whole bug: this used to be undefined (→ satellite bucket).
      expect(row!.focus_tier).toBe('focus');
    }
  });

  it('togglePin emit also sees committed pin state', async () => {
    const { task } = await addTask({ title: 'Pin race task', category: 'Local' });

    const readsDuringEmit: Promise<string[]>[] = [];
    bus.subscribe('race-probe-pin', (event) => {
      if (event.name !== EventNames.TASK_UPDATED) return;
      const { task: t } = event.data as { task?: { id: string } };
      if (t?.id !== task.id) return;
      readsDuringEmit.push(getPinnedTasks().then((ts) => ts.map((x) => x.id)));
    }, { global: true });

    await togglePin(task.id);

    expect(readsDuringEmit.length).toBeGreaterThan(0);
    for (const read of readsDuringEmit) {
      expect(await read).toContain(task.id);
    }
  });
});
