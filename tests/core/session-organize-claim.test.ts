/**
 * organizeQuickStartTask placement safety — the unattended fast-model pass
 * may file a local task into ANY project, including a provider-claimed one,
 * because updateTask now keeps a local task local on that move (the project
 * is just a folder; nothing is pushed). The old claim-skip guard protected
 * against the pre-fix behavior where the move flipped the source and pushed
 * the task to the external tracker (19 "Session: walnut" copies by
 * 2026-08-20). These tests pin the new invariant: placed anywhere, but the
 * source NEVER changes and nothing ever reaches a provider.
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
  it('places a local task into a provider-claimed project WITHOUT migrating it', async () => {
    await ensureProject('Provider Land', 'some-provider' as any);
    // Give the claimed project a task so the digest lists it.
    const { updateTaskRaw } = await import('../../src/core/task-manager.js');
    const { task: anchor } = await addTask({ title: 'anchor', project: 'Provider Land' });
    await updateTaskRaw(anchor.id, { source: 'some-provider' as any });

    const { task } = await addTask({ title: 'Quick start task' }); // Inbox, local
    modelPicks('Provider Land');

    await organizeQuickStartTask(task.id, '/tmp/somewhere', 'do a thing');

    const after = await getTask(task.id);
    expect(after?.project).toBe('Provider Land'); // filed — the folder is usable
    expect(after?.source).toBe('local');          // never migrated / pushed
    expect(after?.ext).toBeUndefined();           // no remote identity minted
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
