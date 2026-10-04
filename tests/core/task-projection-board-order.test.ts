/**
 * The task projection carries the pinned board's two order inputs a replica
 * cannot know on its own: the project order (`ordering.projects`, which lives in
 * the primary's machine-local config.yaml) and the folder listing (replica rows
 * are built from the slim projection, which carries no group_id). The phone
 * paired to a replica orders its board from these (web/src/utils/pinned-tier-order.ts
 * and its Swift twin), so without them it cannot match the Mac.
 *
 * Real files, real fs: only `constants` is redirected to a temp dir.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-projection-board-order'));

import {
  exportTaskProjection,
  readTaskProjection,
  startTaskProjectionExport,
} from '../../src/core/task-projection.js';
import { _resetForTesting, addTask, addTaskFull, groupTasks } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { updateConfig } from '../../src/core/config-manager.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import { WALNUT_HOME } from '../../src/constants.js';

async function wipe(): Promise<void> {
  closeDb();
  _resetForTesting();
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true });
}

beforeEach(async () => {
  await wipe();
  await fsp.mkdir(WALNUT_HOME, { recursive: true });
});
afterEach(wipe);

describe('board order inputs on the exported projection', () => {
  it('carries the project order and every folder, members narrowed to shipped rows', async () => {
    await updateConfig({ ordering: { projects: ['Lighthouse', '', 'Orchard'] } });
    const a = (await addTask({ title: 'Seed tray', project: 'Orchard' })).task;
    const b = (await addTask({ title: 'Seed labels', project: 'Orchard' })).task;
    const folder = await groupTasks([a.id, b.id], 'Seeds');
    // A member finished long ago is not in the projection, so it is not a member here.
    const longAgo = '2020-01-02T00:00:00.000Z';
    await addTaskFull({
      title: 'Old seed batch', project: 'Orchard', group_id: folder.group_id,
      status: 'done', phase: 'COMPLETE', priority: 'none', source: 'local',
      session_ids: [], description: '', summary: '', note: '',
      created_at: longAgo, updated_at: longAgo, completed_at: longAgo,
    } as unknown as Parameters<typeof addTaskFull>[0]);

    await exportTaskProjection();
    const projection = await readTaskProjection();
    expect(projection?.project_order).toEqual(['Lighthouse', '', 'Orchard']);
    const seeds = projection?.groups?.find((g) => g.group_id === folder.group_id);
    expect(seeds).toMatchObject({ label: 'Seeds', project: 'Orchard', hidden: false });
    expect([...(seeds?.member_ids ?? [])].sort()).toEqual([a.id, b.id].sort());
  });

  it('an empty order and no folders still ship, so a replica can tell them from an old primary', async () => {
    await addTask({ title: 'Loose', project: 'Orchard' });
    await exportTaskProjection();
    const projection = await readTaskProjection();
    expect(projection?.project_order).toEqual([]);
    expect(projection?.groups).toEqual([]);
  });

  it('a project reorder re-exports without any task changing; other config keys do not', async () => {
    await addTask({ title: 'Loose', project: 'Orchard' });
    await exportTaskProjection();
    const first = (await readTaskProjection())?.exportedAt;
    // The export is debounced (3s); wait on the file rather than faking the clock,
    // since the export itself is real async I/O.
    const waitFor = async (done: (p: Awaited<ReturnType<typeof readTaskProjection>>) => boolean) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const projection = await readTaskProjection();
        if (done(projection)) return projection;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      return readTaskProjection();
    };
    const handle = startTaskProjectionExport();
    try {
      // Let the start-up export land first, so the one below can only come from the event.
      const booted = await waitFor((p) => p?.exportedAt !== first);
      expect(booted?.exportedAt).not.toBe(first);

      await updateConfig({ ordering: { projects: ['Orchard', 'Lighthouse'] } });
      bus.emit(EventNames.CONFIG_CHANGED, { key: 'favorites' }, ['web-ui']);
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const unrelated = await readTaskProjection();
      expect(unrelated?.exportedAt).toBe(booted?.exportedAt);
      expect(unrelated?.project_order).toEqual([]);

      bus.emit(EventNames.CONFIG_CHANGED, { key: 'ordering' }, ['web-ui']);
      const reordered = await waitFor((p) => p?.project_order?.[0] === 'Orchard');
      expect(reordered?.project_order).toEqual(['Orchard', 'Lighthouse']);
    } finally {
      handle.stop();
    }
  }, 30_000);
});
