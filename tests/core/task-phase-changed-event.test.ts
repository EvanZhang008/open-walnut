/**
 * task:phase-changed emission tests — one emit per REAL transition from each
 * mutation path, zero emits on same-phase re-set.
 *
 * Uses the real task-manager against a temp store (mock-constants pattern).
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { WALNUT_HOME } from '../../src/constants.js';
import { bus, EventNames } from '../../src/core/event-bus.js';
import {
  addTask, updateTask, completeTask, toggleComplete, setPhaseBulk, updateTaskRaw,
} from '../../src/core/task-manager.js';
import type { TaskPhaseChangedEvent } from '../../src/core/event-types.js';

interface Captured { data: TaskPhaseChangedEvent; source?: string }
let captured: Captured[] = [];

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
  await fs.mkdir(WALNUT_HOME, { recursive: true });
  bus.subscribe('phase-changed-spy', (e) => {
    if (e.name === EventNames.TASK_PHASE_CHANGED) {
      captured.push({ data: e.data as TaskPhaseChangedEvent, source: e.source });
    }
  }, { global: true, interest: ['task:phase-changed'] });
});

afterAll(async () => {
  bus.unsubscribe('phase-changed-spy');
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

beforeEach(() => { captured = []; });

async function makeLocalTask(title: string): Promise<string> {
  const { task } = await addTask({ title, project: '' });
  return task.id;
}

describe('task:phase-changed emission', () => {
  it('updateTask with a phase change emits once with old/new', async () => {
    const id = await makeLocalTask('phase-emit-updateTask');
    await updateTask(id, { phase: 'IN_PROGRESS' }, { source: 'api' });

    expect(captured).toHaveLength(1);
    expect(captured[0].data.oldPhase).toBe('TODO');
    expect(captured[0].data.newPhase).toBe('IN_PROGRESS');
    expect(captured[0].data.source).toBe('api');
    expect(captured[0].data.task.id).toBe(id);
  });

  it('updateTask re-setting the SAME phase emits nothing', async () => {
    const id = await makeLocalTask('phase-emit-samephase');
    await updateTask(id, { phase: 'TODO' }, { source: 'api' });
    expect(captured).toHaveLength(0);
  });

  it('updateTask touching non-phase fields emits nothing', async () => {
    const id = await makeLocalTask('phase-emit-nonphase');
    await updateTask(id, { title: 'renamed' }, { source: 'api' });
    expect(captured).toHaveLength(0);
  });

  it('completeTask emits TODO→COMPLETE', async () => {
    const id = await makeLocalTask('phase-emit-complete');
    await completeTask(id);

    expect(captured).toHaveLength(1);
    expect(captured[0].data.oldPhase).toBe('TODO');
    expect(captured[0].data.newPhase).toBe('COMPLETE');
  });

  it('toggleComplete emits both directions', async () => {
    const id = await makeLocalTask('phase-emit-toggle');
    await toggleComplete(id);
    await toggleComplete(id);

    expect(captured).toHaveLength(2);
    expect(captured[0].data.newPhase).toBe('COMPLETE');
    expect(captured[1].data.oldPhase).toBe('COMPLETE');
    expect(captured[1].data.newPhase).toBe('TODO');
  });

  it('setPhaseBulk emits per task with source bulk, skipping no-ops', async () => {
    const a = await makeLocalTask('phase-emit-bulk-a');
    const b = await makeLocalTask('phase-emit-bulk-b');
    await updateTask(a, { phase: 'IN_PROGRESS' }, { source: 'api' });
    captured = [];

    // a: IN_PROGRESS→COMPLETE (emit), b: TODO→COMPLETE (emit)
    await setPhaseBulk([a, b], 'COMPLETE');
    expect(captured).toHaveLength(2);
    expect(captured.every(c => c.data.source === 'bulk')).toBe(true);

    captured = [];
    // both already COMPLETE — no-op, no emits
    await setPhaseBulk([a, b], 'COMPLETE');
    expect(captured).toHaveLength(0);
  });

  it('updateTaskRaw with emitEvent emits on a real phase transition only', async () => {
    const id = await makeLocalTask('phase-emit-raw');

    await updateTaskRaw(id, { phase: 'IN_PROGRESS' }, { emitEvent: true, source: 'session' });
    expect(captured).toHaveLength(1);
    expect(captured[0].data.oldPhase).toBe('TODO');
    expect(captured[0].data.newPhase).toBe('IN_PROGRESS');
    expect(captured[0].data.source).toBe('session');

    captured = [];
    await updateTaskRaw(id, { title: 'raw-rename' }, { emitEvent: true, source: 'session' });
    expect(captured).toHaveLength(0);
  });

  it('updateTaskRaw WITHOUT emitEvent stays silent (sync-pull contract)', async () => {
    const id = await makeLocalTask('phase-emit-raw-silent');
    await updateTaskRaw(id, { phase: 'IN_PROGRESS' });
    expect(captured).toHaveLength(0);
  });
});
