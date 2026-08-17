import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

let tmpDir: string;

vi.mock('../../src/constants.js', () => createMockConstants('walnut-terminal-phase'));

// Import after mocking
import { addTask, updateTask, updateTaskRaw, listTasks, _resetForTesting } from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

beforeEach(async () => {
  tmpDir = WALNUT_HOME;
  closeDb();
  _resetForTesting();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

afterEach(async () => {
  closeDb();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('terminal phase guard — updateTask', () => {
  it('blocks agent from overwriting COMPLETE → AWAIT_HUMAN_ACTION', async () => {
    const { task } = await addTask({ title: 'Guard test 1' });

    // Set phase to COMPLETE via human source
    await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'api' });
    const before = (await listTasks()).find(t => t.id === task.id)!;
    expect(before.phase).toBe('COMPLETE');

    // Agent tries to overwrite COMPLETE → AWAIT_HUMAN_ACTION — should be blocked
    await updateTask(task.id, { phase: 'AWAIT_HUMAN_ACTION' }, { source: 'agent' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
  });

  it('blocks agent from overwriting HUMAN_VERIFIED → IN_PROGRESS', async () => {
    const { task } = await addTask({ title: 'Guard test 2' });

    // Set phase to HUMAN_VERIFIED via human source
    await updateTask(task.id, { phase: 'HUMAN_VERIFIED' }, { source: 'api' });
    const before = (await listTasks()).find(t => t.id === task.id)!;
    expect(before.phase).toBe('HUMAN_VERIFIED');

    // Agent tries to overwrite HUMAN_VERIFIED → IN_PROGRESS — should be blocked
    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'agent' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('HUMAN_VERIFIED');
  });

  it('allows human to overwrite COMPLETE → IN_PROGRESS', async () => {
    const { task } = await addTask({ title: 'Guard test 3' });

    // Set phase to COMPLETE via human source
    await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'api' });
    const before = (await listTasks()).find(t => t.id === task.id)!;
    expect(before.phase).toBe('COMPLETE');

    // Human (source='api') re-opens the task → should be allowed
    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'api' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('IN_PROGRESS');
    expect(after.status).toBe('in_progress');
  });

  it('rejects human-owned phases from agent sources', async () => {
    const { task } = await addTask({ title: 'Guard human phases' });

    for (const phase of ['HUMAN_VERIFIED', 'POST_WORK_COMPLETED', 'COMPLETE'] as const) {
      await expect(updateTask(task.id, { phase }, { source: 'agent' }))
        .rejects.toThrow(/Agents may set/);
    }
    await expect(updateTask(task.id, { status: 'done' }, { source: 'agent' }))
      .rejects.toThrow(/Agents cannot set status=done/);
  });

  it('allows agent to overwrite non-terminal phase AGENT_COMPLETE → AWAIT_HUMAN_ACTION', async () => {
    const { task } = await addTask({ title: 'Guard test 5' });

    // Set phase to AGENT_COMPLETE (non-terminal)
    await updateTask(task.id, { phase: 'AGENT_COMPLETE' }, { source: 'api' });
    const before = (await listTasks()).find(t => t.id === task.id)!;
    expect(before.phase).toBe('AGENT_COMPLETE');

    // Agent changes AGENT_COMPLETE → AWAIT_HUMAN_ACTION — should succeed
    await updateTask(task.id, { phase: 'AWAIT_HUMAN_ACTION' }, { source: 'agent' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('AWAIT_HUMAN_ACTION');
  });
});

describe('terminal phase guard — updateTaskRaw', () => {
  it('blocks sync from overwriting COMPLETE phase but allows other field updates', async () => {
    const { task } = await addTask({ title: 'Raw guard test' });

    // Set phase to COMPLETE via human source
    await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'api' });
    const before = (await listTasks()).find(t => t.id === task.id)!;
    expect(before.phase).toBe('COMPLETE');

    // Sync pull tries to change phase + title — phase should be blocked, title should update
    await updateTaskRaw(task.id, { phase: 'AWAIT_HUMAN_ACTION', title: 'Updated by sync' } as any);
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
    expect(after.title).toBe('Updated by sync');
  });
});
