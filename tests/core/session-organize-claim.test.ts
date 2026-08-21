/**
 * organizeQuickStartTask claim guard — the unattended fast-model placement
 * pass must NEVER walk a local task into a provider-claimed project. That
 * move triggers migrateTaskSource (local → provider), pushes the task to the
 * external tracker, and is how quick-start noise tasks multiplied in the
 * user's real tracker (19 "Session: walnut" copies by 2026-08-20). A human
 * move through updateTask still migrates — that's an explicit decision.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants('session-organize-claim'));

// Pin the model suggestion so the test controls what the "AI" picks.
const suggestMock = vi.fn();
vi.mock('../../src/agent/model.js', () => ({
  sendMessage: (...args: unknown[]) => suggestMock(...args),
}));

import { WALNUT_HOME } from '../../src/constants.js';
import { organizeQuickStartTask } from '../../src/core/session-organize.js';
import {
  _resetForTesting,
  addTask,
  getTask,
  ensureProject,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';

function modelPicks(project: string) {
  suggestMock.mockResolvedValue({
    content: [{ type: 'text', text: JSON.stringify({ project }) }],
  });
}

beforeEach(() => {
  closeDb();
  _resetForTesting();
  suggestMock.mockReset();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  fs.mkdirSync(WALNUT_HOME, { recursive: true });
});

afterEach(() => {
  closeDb();
  _resetForTesting();
  fs.rmSync(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

describe('organizeQuickStartTask claim guard', () => {
  it('refuses to move a local task into a provider-claimed project', async () => {
    await ensureProject('Provider Land', 'some-provider' as any);
    // Give the claimed project a task so the digest lists it.
    const { updateTaskRaw } = await import('../../src/core/task-manager.js');
    const { task: anchor } = await addTask({ title: 'anchor', project: 'Provider Land' });
    await updateTaskRaw(anchor.id, { source: 'some-provider' as any });

    const { task } = await addTask({ title: 'Quick start task' }); // Inbox, local
    modelPicks('Provider Land');

    await organizeQuickStartTask(task.id, '/tmp/somewhere', 'do a thing');

    const after = await getTask(task.id);
    expect(after?.project ?? '').toBe(''); // stayed in Inbox
    expect(after?.source).toBe('local');   // never migrated / pushed
  });

  it('still places a local task into a local-claimed project', async () => {
    await ensureProject('Local Land', 'local');
    await addTask({ title: 'anchor', project: 'Local Land' });

    const { task } = await addTask({ title: 'Quick start task' });
    modelPicks('Local Land');

    await organizeQuickStartTask(task.id, '/tmp/somewhere', 'do a thing');

    const after = await getTask(task.id);
    expect(after?.project).toBe('Local Land');
    expect(after?.source).toBe('local');
  });

  it('does not move a task a human already placed', async () => {
    await ensureProject('Local Land', 'local');
    const { task } = await addTask({ title: 'Placed already', project: 'Local Land' });
    modelPicks('Local Land');

    await organizeQuickStartTask(task.id, '/tmp/somewhere');

    const after = await getTask(task.id);
    expect(after?.project).toBe('Local Land'); // untouched (guard returned early)
  });
});
