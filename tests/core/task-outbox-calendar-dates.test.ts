/**
 * The PRIMARY-side apply half of the calendar-date contract: a replica op that
 * names `start_date`/`end_date` must land those columns on the Mac's row.
 *
 * The REST half (POST/PATCH accept the fields, and the dispatched op carries
 * them) lives in tests/web/routes/api-v1-task-dates{,-cloud}.test.ts. This file
 * closes the loop at the other end — applyTaskOp — so an accidental drop from
 * UPDATE_WHITELIST would fail here instead of silently losing a phone-scheduled
 * block on the primary.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fsp from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

const constantsBase = createMockConstants('walnut-outbox-cal-dates');

type Modules = {
  outbox: typeof import('../../src/core/task-outbox.js');
  tm: typeof import('../../src/core/task-manager.js');
  taskDb: typeof import('../../src/core/task-db.js');
};

/** PRIMARY box (CLOUD_MODE=false) — the side that APPLIES ops. */
async function loadPrimary(): Promise<Modules> {
  vi.resetModules();
  vi.doMock('../../src/constants.js', () => ({ ...constantsBase, CLOUD_MODE: false }));
  return {
    outbox: await import('../../src/core/task-outbox.js'),
    tm: await import('../../src/core/task-manager.js'),
    taskDb: await import('../../src/core/task-db.js'),
  };
}

let current: Modules | undefined;

async function wipeHome(mods?: Modules): Promise<void> {
  if (mods) {
    mods.taskDb.closeDb();
    mods.tm._resetForTesting();
  }
  await fsp.rm(constantsBase.WALNUT_HOME as string, { recursive: true, force: true });
  await fsp.mkdir(constantsBase.TASKS_DIR as string, { recursive: true });
}

beforeEach(async () => { await wipeHome(current); });
afterEach(async () => {
  await wipeHome(current);
  current = undefined;
  vi.resetModules();
});

/** A timestamp newer than the row's, so the LWW guard lets the op through. */
function newerThan(updatedAt: string): string {
  return new Date(Date.parse(updatedAt) + 60_000).toISOString();
}

describe('applyTaskOp: calendar dates (start_date / end_date)', () => {
  it('a create op inserts both dates on the primary row', async () => {
    current = await loadPrimary();
    const { outbox, tm } = current;
    const now = new Date().toISOString();

    expect(await outbox.applyTaskOp({
      opId: 'cal-create-1', type: 'create', at: now,
      task: {
        id: 'cal-task-1', title: 'phone-scheduled block', status: 'todo', phase: 'TODO',
        priority: 'none', project: '', source: 'local', session_ids: [],
        description: '', summary: '', note: '', created_at: now, updated_at: now,
        start_date: '2030-07-01T09:00:00.000Z', end_date: '2030-07-01T11:00:00.000Z',
      } as never,
    })).toEqual({ applied: true, reason: 'created' });

    const row = await tm.getTask('cal-task-1');
    expect(row.start_date).toBe('2030-07-01T09:00:00.000Z');
    expect(row.end_date).toBe('2030-07-01T11:00:00.000Z');
  });

  it('a touched-scoped op writes end_date without disturbing the rest of the row', async () => {
    current = await loadPrimary();
    const { outbox, tm } = current;

    const { task } = await tm.addTask({
      title: 'resize target', source: 'local', start_date: '2030-07-02T09:00:00.000Z',
    });
    await tm.updateDescription(task.id, 'primary description');
    const row = await tm.getTask(task.id);
    const at = newerThan(row.updated_at);

    expect(await outbox.applyTaskOp({
      opId: 'cal-update-1', type: 'update', at, touched: ['end_date'],
      task: {
        ...row, end_date: '2030-07-02T12:00:00.000Z', updated_at: at,
        // Replica rows are projection-blind on the text blobs; `touched` is what
        // keeps them out of the patch.
        description: '', note: '', summary: '',
      } as never,
    })).toEqual({ applied: true, reason: 'updated' });

    const after = await tm.getTask(task.id);
    expect(after.end_date).toBe('2030-07-02T12:00:00.000Z');
    expect(after.start_date).toBe('2030-07-02T09:00:00.000Z');
    expect(after.description).toBe('primary description');
  });

  it('a touched date ABSENT from the snapshot clears it on the primary (the "" path)', async () => {
    current = await loadPrimary();
    const { outbox, tm } = current;

    const { task } = await tm.addTask({
      title: 'clear target', source: 'local',
      start_date: '2030-07-03T09:00:00.000Z', end_date: '2030-07-03T10:00:00.000Z',
    });
    const row = await tm.getTask(task.id);
    const at = newerThan(row.updated_at);
    const { end_date: _dropped, ...withoutEnd } = row as Record<string, unknown>;

    expect(await outbox.applyTaskOp({
      opId: 'cal-clear-1', type: 'update', at, touched: ['end_date'],
      task: { ...withoutEnd, updated_at: at } as never,
    })).toEqual({ applied: true, reason: 'updated' });

    const after = await tm.getTask(task.id);
    expect(after.end_date).toBeUndefined();
    expect(after.start_date).toBe('2030-07-03T09:00:00.000Z'); // untouched half survives
  });

  it('a stale op cannot roll a newer primary window backwards (LWW)', async () => {
    current = await loadPrimary();
    const { outbox, tm } = current;

    const { task } = await tm.addTask({ title: 'lww target', source: 'local' });
    await tm.updateTask(task.id, {
      start_date: '2030-07-04T09:00:00.000Z', end_date: '2030-07-04T15:00:00.000Z',
    }, { source: 'api' });
    const row = await tm.getTask(task.id);
    const stale = new Date(Date.parse(row.updated_at) - 60_000).toISOString();

    expect(await outbox.applyTaskOp({
      opId: 'cal-stale-1', type: 'update', at: stale, touched: ['end_date'],
      task: { ...row, end_date: '2030-07-04T10:00:00.000Z', updated_at: stale } as never,
    })).toEqual({ applied: false, reason: 'stale' });

    const after = await tm.getTask(task.id);
    expect(after.end_date).toBe('2030-07-04T15:00:00.000Z');
  });
});
