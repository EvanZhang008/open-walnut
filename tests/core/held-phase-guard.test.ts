/**
 * The held-phase guard: WAITING is left alone by background writers.
 *
 * A WAITING task is parked on purpose (by the user, or by the AI as the last
 * call of its turn). The writers that move phases without anyone asking (a sync
 * pull mapping a remote step back, the 'internal' default source, a reconciler)
 * must not end that wait by accident: a sync plugin compiled against the older
 * phase set maps WAITING to nothing on push and would map the remote step back
 * to TODO or IN_PROGRESS on the next pull. They may still COMPLETE it (the remote
 * side closed the item), and a deliberate source (api, user, agent) or the
 * session machine (`leaveHeld`) moves it freely. `wait_until` lives and dies with
 * the phase: set only while WAITING, cleared by every move out of it, and a move
 * INTO it with no time named gets the default clock (DEFAULT_WAIT_DAYS out), so
 * a wait is never open-ended unless "" asked for that.
 *
 * Would these fail on reverted code? YES: without the guard a sync pull with
 * `phase: 'TODO'` lands, and the task silently stops waiting.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('walnut-held-phase'));

import { addTask, updateTask, updateTaskRaw, getTask, _resetForTesting } from '../../src/core/task-manager.js';
import { DEFAULT_WAIT_DAYS } from '../../src/core/types.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

const UNTIL = '2026-10-06T10:00:00.000Z';
const DAY_MS = 86_400_000;

async function waitingTask(withUntil = true): Promise<string> {
  const { task } = await addTask({ title: 'Parked on a review' });
  await updateTask(task.id, { phase: 'WAITING', ...(withUntil ? { wait_until: UNTIL } : { wait_until: '' }) }, { source: 'agent' });
  const t = await getTask(task.id);
  expect(t.phase).toBe('WAITING');
  expect(t.status).toBe('todo');
  expect(t.wait_until).toBe(withUntil ? UNTIL : undefined);
  return task.id;
}

/** True when `iso` is DEFAULT_WAIT_DAYS after `before` (a moment taken just
 *  before the write), give or take the test's own runtime. */
function isDefaultClock(iso: string | undefined, before: number): boolean {
  if (!iso) return false;
  const ahead = Date.parse(iso) - before;
  return ahead >= DEFAULT_WAIT_DAYS * DAY_MS && ahead < DEFAULT_WAIT_DAYS * DAY_MS + 60_000;
}

describe('the default clock: a task entering WAITING with no wait_until named', () => {
  it('gets DEFAULT_WAIT_DAYS from now on the updateTask path', async () => {
    const { task } = await addTask({ title: 'Snoozed on a trigger' });
    const before = Date.now();
    await updateTask(task.id, { phase: 'WAITING' }, { source: 'agent' });
    const t = await getTask(task.id);
    expect(t.phase).toBe('WAITING');
    expect(isDefaultClock(t.wait_until, before), t.wait_until).toBe(true);
    expect(Date.parse(t.wait_until!)).toBeGreaterThanOrEqual(before + DEFAULT_WAIT_DAYS * DAY_MS);
  });

  it('a named time wins, shorter or longer; "" means no clock on purpose', async () => {
    const shortId = await waitingTask();
    expect((await getTask(shortId)).wait_until).toBe(UNTIL);
    const noneId = await waitingTask(false);
    expect((await getTask(noneId)).wait_until).toBeUndefined();
  });

  it('a task already waiting keeps its clock (or its lack of one) on later writes', async () => {
    const noneId = await waitingTask(false);
    await updateTask(noneId, { title: 'Renamed while parked' }, { source: 'api' });
    await updateTask(noneId, { phase: 'WAITING' }, { source: 'agent' });
    expect((await getTask(noneId)).wait_until).toBeUndefined();
    const id = await waitingTask();
    await updateTask(id, { phase: 'WAITING', title: 'Same phase again' }, { source: 'agent' });
    expect((await getTask(id)).wait_until).toBe(UNTIL);
  });

  it('the raw (sync-pull) path fills the same default on the move into WAITING', async () => {
    const { task } = await addTask({ title: 'Pulled into waiting' });
    const before = Date.now();
    await updateTaskRaw(task.id, { phase: 'WAITING' });
    const t = await getTask(task.id);
    expect(t.phase).toBe('WAITING');
    expect(isDefaultClock(t.wait_until, before), t.wait_until).toBe(true);
    const { task: named } = await addTask({ title: 'Pulled with a time' });
    await updateTaskRaw(named.id, { phase: 'WAITING', wait_until: UNTIL } as never);
    expect((await getTask(named.id)).wait_until).toBe(UNTIL);
  });

  it('a blocked move into WAITING sets no clock (a background write on a COMPLETE task)', async () => {
    const { task } = await addTask({ title: 'Done already' });
    await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'user' });
    await updateTask(task.id, { phase: 'WAITING' }, { source: 'internal' });
    const t = await getTask(task.id);
    expect(t.phase).toBe('COMPLETE');
    expect(t.wait_until).toBeUndefined();
  });
});

describe('held phase guard: updateTask', () => {
  it('a background source cannot move WAITING to TODO or IN_PROGRESS, but may COMPLETE it', async () => {
    const id = await waitingTask();
    for (const phase of ['TODO', 'IN_PROGRESS', 'NEED_ACTION'] as const) {
      await updateTask(id, { phase }, { source: 'internal' });
      const t = await getTask(id);
      expect(t.phase, phase).toBe('WAITING');
      expect(t.wait_until, phase).toBe(UNTIL);
    }
    await updateTask(id, { phase: 'COMPLETE' }, { source: 'internal' });
    const done = await getTask(id);
    expect(done.phase).toBe('COMPLETE');
    expect(done.wait_until).toBeUndefined();
  });

  it('the legacy status path is guarded the same way (a sync writing status in_progress)', async () => {
    const id = await waitingTask();
    await updateTask(id, { status: 'in_progress' }, { source: 'internal' });
    expect((await getTask(id)).phase).toBe('WAITING');
    await updateTask(id, { status: 'done' }, { source: 'internal' });
    expect((await getTask(id)).phase).toBe('COMPLETE');
  });

  it('a deliberate source moves it anywhere, and the move clears wait_until', async () => {
    for (const source of ['api', 'user', 'agent']) {
      const id = await waitingTask();
      await updateTask(id, { phase: 'IN_PROGRESS' }, { source });
      const t = await getTask(id);
      expect(t.phase, source).toBe('IN_PROGRESS');
      expect(t.wait_until, source).toBeUndefined();
    }
  });

  it('other fields still land on a WAITING task from a background source', async () => {
    const id = await waitingTask();
    await updateTask(id, { phase: 'TODO', title: 'Renamed by sync' }, { source: 'internal' });
    const t = await getTask(id);
    expect(t.phase).toBe('WAITING');
    expect(t.title).toBe('Renamed by sync');
  });

  it('wait_until is only ever set on a WAITING task; "" clears it', async () => {
    const { task } = await addTask({ title: 'Not waiting' });
    await updateTask(task.id, { wait_until: UNTIL }, { source: 'api' });
    expect((await getTask(task.id)).wait_until).toBeUndefined();

    const id = await waitingTask();
    await updateTask(id, { wait_until: '' }, { source: 'api' });
    const cleared = await getTask(id);
    expect(cleared.phase).toBe('WAITING');
    expect(cleared.wait_until).toBeUndefined();

    await updateTask(id, { wait_until: UNTIL }, { source: 'api' });
    expect((await getTask(id)).wait_until).toBe(UNTIL);
  });
});

describe('held phase guard: updateTaskRaw (the sync-pull path)', () => {
  it('blocks the phase but keeps the other fields of a pull', async () => {
    const id = await waitingTask();
    await updateTaskRaw(id, { phase: 'TODO', status: 'todo', title: 'Pulled title' } as never);
    const t = await getTask(id);
    expect(t.phase).toBe('WAITING');
    expect(t.title).toBe('Pulled title');
    expect(t.wait_until).toBe(UNTIL);
  });

  it('a pull may complete it', async () => {
    const id = await waitingTask();
    await updateTaskRaw(id, { phase: 'COMPLETE' });
    const t = await getTask(id);
    expect(t.phase).toBe('COMPLETE');
    expect(t.wait_until).toBeUndefined();
  });

  it('leaveHeld (the session machine) moves it, and the raw path clears wait_until with the move', async () => {
    const id = await waitingTask();
    const res = await updateTaskRaw(id, { phase: 'IN_PROGRESS' }, { leaveHeld: true });
    expect(res.changed).toBe(true);
    const t = await getTask(id);
    expect(t.phase).toBe('IN_PROGRESS');
    expect(t.wait_until).toBeUndefined();
  });

  it('a raw write of the SAME phase is not a move: wait_until survives', async () => {
    const id = await waitingTask();
    await updateTaskRaw(id, { phase: 'WAITING', title: 'Same phase' });
    const t = await getTask(id);
    expect(t.phase).toBe('WAITING');
    expect(t.wait_until).toBe(UNTIL);
  });
});
