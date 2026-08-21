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
  it('blocks a BACKGROUND source from reopening COMPLETE', async () => {
    const { task } = await addTask({ title: 'Guard test 1' });

    await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'api' });
    expect((await listTasks()).find(t => t.id === task.id)!.phase).toBe('COMPLETE');

    // 'internal' is the DEFAULT source — anything that merely passed a phase
    // along (reconciler, cron, a plugin echo). Nobody asked for this, so a
    // finished task must not silently reopen.
    // (WAIT removed 2026-08-18 — was 'WAIT'; TODO is a valid non-terminal
    // phase, so this still exercises the guard rather than enum validation.)
    await updateTask(task.id, { phase: 'TODO' }, { source: 'internal' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
  });

  it('lets an agent reopen COMPLETE — deliberate is deliberate, human or not', async () => {
    // The guard used to allow only 'api'/'user', which left an asymmetry: an
    // agent could SET COMPLETE but not UNSET it, purely because 'agent' wasn't
    // on the human-only allowlist. The question is whether anyone ASKED, not who.
    const { task } = await addTask({ title: 'Agent reopens' });

    await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'agent' });
    expect((await listTasks()).find(t => t.id === task.id)!.phase).toBe('COMPLETE');

    await updateTask(task.id, { phase: 'IN_PROGRESS' }, { source: 'agent' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('IN_PROGRESS');
    expect(after.status).toBe('in_progress');
  });

  // The 5-phase model has no human-vs-agent write gate: an agent may complete a
  // task outright. COMPLETE stays terminal only against BACKGROUND overwrites.
  it('allows an agent to set COMPLETE (no human-only completion gate)', async () => {
    const { task } = await addTask({ title: 'Agent completes' });

    await updateTask(task.id, { phase: 'COMPLETE' }, { source: 'agent' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
  });

  it('allows an agent to set status=done (legacy status path, no gate)', async () => {
    const { task } = await addTask({ title: 'Agent status done' });

    await updateTask(task.id, { status: 'done' }, { source: 'agent' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
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

  // (WAIT removed 2026-08-18 — this pinned AGENT_COMPLETE → WAIT; TODO is the
  // landing WAIT rows migrated to, and is equally non-terminal, so the guard's
  // behavior is pinned the same way.)
  it('allows agent to overwrite non-terminal phase AGENT_COMPLETE → TODO', async () => {
    const { task } = await addTask({ title: 'Guard test 5' });

    // Set phase to AGENT_COMPLETE (non-terminal)
    await updateTask(task.id, { phase: 'AGENT_COMPLETE' }, { source: 'api' });
    const before = (await listTasks()).find(t => t.id === task.id)!;
    expect(before.phase).toBe('AGENT_COMPLETE');

    // Agent changes AGENT_COMPLETE → TODO — should succeed
    await updateTask(task.id, { phase: 'TODO' }, { source: 'agent' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('TODO');
  });

  // WAIT is no longer in VALID_PHASES (removed 2026-08-18). updateTask's phase
  // branch is gated on `VALID_PHASES.has(updates.phase)`, so a stale caller's
  // WAIT is silently IGNORED (no throw, phase untouched) rather than written.
  it('a stale WAIT write through updateTask is ignored, not applied', async () => {
    const { task } = await addTask({ title: 'Stale WAIT write' });
    await updateTask(task.id, { phase: 'AGENT_COMPLETE' }, { source: 'api' });

    await updateTask(task.id, { phase: 'WAIT' as never }, { source: 'agent' });
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('AGENT_COMPLETE');
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
    // (WAIT removed 2026-08-18 — was 'WAIT'; TODO is a live non-terminal phase.)
    await updateTaskRaw(task.id, { phase: 'TODO', title: 'Updated by sync' } as any);
    const after = (await listTasks()).find(t => t.id === task.id)!;
    expect(after.phase).toBe('COMPLETE');
    expect(after.status).toBe('done');
    expect(after.title).toBe('Updated by sync');
  });
});
