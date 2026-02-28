/**
 * Tests for the host/cwd resolution chain used by start_session.
 *
 * The resolution chain (from agent/tools.ts start_session):
 *   host:  params.host → .metadata default_host → undefined (local)
 *   cwd:   params.working_directory → .metadata default_cwd → error (if remote)
 *
 * These tests validate the resolution logic by exercising getProjectMetadata()
 * and applying the same chain logic that tools.ts uses.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import { addTask, getProjectMetadata, getTask, updateTask } from '../../src/core/task-manager.js';
import type { Task } from '../../src/core/types.js';
import { WALNUT_HOME, CONFIG_FILE } from '../../src/constants.js';

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

afterEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true });
});

/**
 * Simulate the host/cwd resolution chain from start_session tool.
 * This is the exact logic from src/agent/tools.ts, extracted for testing.
 *
 * Resolution chain:
 *   ① explicit param → ② task.cwd → ③ parent chain → ④ project metadata → ⑤ error
 */
async function resolveHostAndCwd(
  task: { id?: string; category: string; project: string; cwd?: string; parent_task_id?: string } | null,
  paramsHost?: string,
  paramsCwd?: string,
): Promise<{
  resolvedHost: string | undefined;
  resolvedCwd: string | undefined;
  error?: string;
}> {
  let resolvedHost = paramsHost;
  let resolvedCwd = paramsCwd;

  // Priority 2 & 3: task cwd → walk up parent chain
  if (!resolvedCwd && task) {
    let current: typeof task | undefined = task;
    const seen = new Set<string>();
    while (current && !resolvedCwd) {
      if (current.cwd) {
        resolvedCwd = current.cwd;
        break;
      }
      if (!current.parent_task_id || seen.has(current.parent_task_id)) break;
      if (current.id) seen.add(current.id);
      current = await getTask(current.parent_task_id).catch(() => undefined) as typeof task | undefined;
    }
  }

  // Priority 4: project/category metadata
  if (task && (!resolvedHost || !resolvedCwd)) {
    const metadata = await getProjectMetadata(task.category, task.project);
    if (metadata) {
      if (!resolvedHost) resolvedHost = metadata.default_host as string | undefined;
      if (!resolvedCwd) resolvedCwd = metadata.default_cwd as string | undefined;
    }
  }

  // Validate: remote sessions MUST have a cwd
  if (resolvedHost && !resolvedCwd) {
    return {
      resolvedHost,
      resolvedCwd,
      error: `Error: Remote host "${resolvedHost}" specified but no working directory. Set working_directory or add default_cwd to the project .metadata task.`,
    };
  }

  // Local sessions still require a cwd (but the error message differs)
  if (!resolvedCwd) {
    return {
      resolvedHost,
      resolvedCwd,
      error: 'Error: working_directory is required for CLI sessions.',
    };
  }

  return { resolvedHost, resolvedCwd };
}

describe('Host/CWD resolution chain', () => {
  it('uses explicit host when provided, even if .metadata has a default', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_host: staging-server\ndefault_cwd: /workspace/small',
    });

    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      'remote-dev',         // explicit host
      '/workspace/big',  // explicit cwd
    );

    expect(result.resolvedHost).toBe('remote-dev');    // explicit wins
    expect(result.resolvedCwd).toBe('/workspace/big'); // explicit wins
    expect(result.error).toBeUndefined();
  });

  it('falls back to .metadata default_host when no explicit host', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_host: remote-dev\ndefault_cwd: /workspace/project',
    });

    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      undefined,         // no explicit host
      undefined,         // no explicit cwd
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace/project');
    expect(result.error).toBeUndefined();
  });

  it('uses local execution when no host specified and no .metadata', async () => {
    // No .metadata task exists
    await addTask({ title: 'Regular task', category: 'Work', project: 'HomeLab' });

    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      undefined,            // no host
      '/local/workspace',   // local cwd provided
    );

    expect(result.resolvedHost).toBeUndefined(); // local execution
    expect(result.resolvedCwd).toBe('/local/workspace');
    expect(result.error).toBeUndefined();
  });

  it('errors when remote host has no cwd and no .metadata default_cwd', async () => {
    // .metadata exists but only has default_host, no default_cwd
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_host: remote-dev',
    });

    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      undefined, // host will be resolved from .metadata
      undefined, // no cwd provided and no default_cwd in .metadata
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.error).toContain('Remote host');
    expect(result.error).toContain('no working directory');
  });

  it('errors when explicit remote host has no cwd', async () => {
    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      'remote-dev', // explicit host
      undefined, // no cwd
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.error).toContain('Remote host');
    expect(result.error).toContain('no working directory');
  });

  it('errors when no cwd at all for local session', async () => {
    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      undefined, // no host
      undefined, // no cwd
    );

    expect(result.resolvedHost).toBeUndefined();
    expect(result.error).toContain('working_directory is required');
  });

  it('explicit host overrides .metadata host, but .metadata cwd is used as fallback', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_host: staging-server\ndefault_cwd: /workspace/from-metadata',
    });

    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      'remote-dev',   // explicit host overrides staging-server
      undefined,   // cwd falls back to .metadata
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace/from-metadata');
    expect(result.error).toBeUndefined();
  });

  it('explicit cwd overrides .metadata cwd, and .metadata host is used as fallback', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_host: remote-dev\ndefault_cwd: /workspace/from-metadata',
    });

    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      undefined,              // host falls back to .metadata
      '/workspace/explicit',  // explicit cwd overrides metadata
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace/explicit');
    expect(result.error).toBeUndefined();
  });

  it('skips .metadata lookup when task is null (taskless sessions)', async () => {
    const result = await resolveHostAndCwd(
      null,       // no task
      'remote-dev',  // explicit host
      '/workspace',
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace');
    expect(result.error).toBeUndefined();
  });

  it('.metadata with only default_cwd (no host) resolves to local session with cwd', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_cwd: /workspace/local-project',
    });

    const result = await resolveHostAndCwd(
      { category: 'Work', project: 'HomeLab' },
      undefined, // no host
      undefined, // no explicit cwd — falls back to .metadata
    );

    expect(result.resolvedHost).toBeUndefined(); // local
    expect(result.resolvedCwd).toBe('/workspace/local-project');
    expect(result.error).toBeUndefined();
  });
});

describe('Task-level cwd resolution', () => {
  it('task.cwd overrides project default_cwd', async () => {
    // Set up project with default_cwd
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_cwd: /workspace/project-default',
    });

    // Create a task with its own cwd
    const { task } = await addTask({ title: 'Special task', category: 'Work', project: 'HomeLab' });
    await updateTask(task.id, { cwd: '/workspace/task-override' });
    const updated = await getTask(task.id);

    const result = await resolveHostAndCwd(
      { id: updated.id, category: updated.category, project: updated.project, cwd: updated.cwd },
      undefined, // no explicit host
      undefined, // no explicit cwd
    );

    expect(result.resolvedCwd).toBe('/workspace/task-override');
    expect(result.error).toBeUndefined();
  });

  it('explicit param overrides task.cwd', async () => {
    const { task } = await addTask({ title: 'Task with cwd', category: 'Work', project: 'HomeLab' });
    await updateTask(task.id, { cwd: '/workspace/task-cwd' });
    const updated = await getTask(task.id);

    const result = await resolveHostAndCwd(
      { id: updated.id, category: updated.category, project: updated.project, cwd: updated.cwd },
      undefined,
      '/workspace/explicit',  // explicit param wins
    );

    expect(result.resolvedCwd).toBe('/workspace/explicit');
    expect(result.error).toBeUndefined();
  });

  it('subtask inherits cwd from parent task', async () => {
    const { task: parent } = await addTask({ title: 'Parent', category: 'Work', project: 'HomeLab' });
    await updateTask(parent.id, { cwd: '/workspace/parent-cwd' });

    const { task: child } = await addTask({
      title: 'Child',
      category: 'Work',
      project: 'HomeLab',
      parent_task_id: parent.id,
    });

    // Child has no cwd — should inherit from parent
    const result = await resolveHostAndCwd(
      { id: child.id, category: child.category, project: child.project, cwd: child.cwd, parent_task_id: child.parent_task_id },
      undefined,
      undefined,
    );

    expect(result.resolvedCwd).toBe('/workspace/parent-cwd');
    expect(result.error).toBeUndefined();
  });

  it('subtask cwd overrides parent cwd', async () => {
    const { task: parent } = await addTask({ title: 'Parent', category: 'Work', project: 'HomeLab' });
    await updateTask(parent.id, { cwd: '/workspace/parent-cwd' });

    const { task: child } = await addTask({
      title: 'Child',
      category: 'Work',
      project: 'HomeLab',
      parent_task_id: parent.id,
    });
    await updateTask(child.id, { cwd: '/workspace/child-cwd' });
    const updatedChild = await getTask(child.id);

    const result = await resolveHostAndCwd(
      { id: updatedChild.id, category: updatedChild.category, project: updatedChild.project, cwd: updatedChild.cwd, parent_task_id: updatedChild.parent_task_id },
      undefined,
      undefined,
    );

    expect(result.resolvedCwd).toBe('/workspace/child-cwd');
    expect(result.error).toBeUndefined();
  });

  it('falls back to project metadata when no task cwd in chain', async () => {
    await addTask({
      title: '.metadata_project',
      category: 'Work',
      project: 'HomeLab',
      description: 'default_cwd: /workspace/project-default',
    });

    const { task: parent } = await addTask({ title: 'Parent no cwd', category: 'Work', project: 'HomeLab' });
    const { task: child } = await addTask({
      title: 'Child no cwd',
      category: 'Work',
      project: 'HomeLab',
      parent_task_id: parent.id,
    });

    // Neither parent nor child has cwd → falls back to project metadata
    const result = await resolveHostAndCwd(
      { id: child.id, category: child.category, project: child.project, cwd: child.cwd, parent_task_id: child.parent_task_id },
      undefined,
      undefined,
    );

    expect(result.resolvedCwd).toBe('/workspace/project-default');
    expect(result.error).toBeUndefined();
  });
});
