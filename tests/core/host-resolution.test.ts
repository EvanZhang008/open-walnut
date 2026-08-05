/**
 * Tests for the host/cwd resolution chain used by start_session.
 *
 * The resolution chain (from agent/tools.ts resolveSessionContext):
 *   host:  params.host → project registry metadata (default_host) → undefined (local)
 *   cwd:   params.working_directory → task.cwd → parent chain → project registry
 *          metadata (default_cwd) → error (in this harness; tools.ts additionally
 *          falls back to the project memory dir — see resolve-session-cwd.test.ts)
 *
 * Project settings now live on the task_projects registry row (setProjectMetadata),
 * not a `.metadata_project` sentinel task, and are keyed by project name only.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../helpers/mock-constants.js';

vi.mock('../../src/constants.js', () => createMockConstants());

import {
  _resetForTesting,
  addTask,
  getProjectMetadata,
  setProjectMetadata,
  getTask,
  updateTask,
} from '../../src/core/task-manager.js';
import { closeDb } from '../../src/core/task-db.js';
import { WALNUT_HOME } from '../../src/constants.js';

// Tasks live in SQLite, and both the handle and task-manager's `initialized`
// flag / whole-store cache are module singletons. Deleting WALNUT_HOME alone
// leaves the previous test's rows readable through the still-open handle, so
// project registry lookups leak across tests (symptom: a later test resolves
// the *previous* test's default_host/default_cwd). Close + reset first.
beforeEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

afterEach(async () => {
  closeDb();
  _resetForTesting();
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
});

interface ChainTask {
  id?: string;
  project?: string;
  cwd?: string;
  parent_task_id?: string;
}

/**
 * Simulate the host/cwd resolution chain from the start_session tool.
 * Mirrors src/agent/tools.ts resolveSessionContext, extracted for testing.
 */
async function resolveHostAndCwd(
  task: ChainTask | null,
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
    let current: ChainTask | undefined = task;
    const seen = new Set<string>();
    while (current && !resolvedCwd) {
      if (current.cwd) {
        resolvedCwd = current.cwd;
        break;
      }
      if (!current.parent_task_id || seen.has(current.parent_task_id)) break;
      if (current.id) seen.add(current.id);
      current = await getTask(current.parent_task_id).catch(() => undefined) as ChainTask | undefined;
    }
  }

  // Priority 4: project registry metadata (keyed by project name; Inbox has no row)
  if (task && (!resolvedHost || !resolvedCwd)) {
    const metadata = await getProjectMetadata(task.project || '');
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
      error: `Error: Remote host "${resolvedHost}" specified but no working directory. Set working_directory or configure the project default_cwd.`,
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
  it('uses explicit host when provided, even if the project has defaults', async () => {
    await setProjectMetadata('HomeLab', {
      default_host: 'staging-server',
      default_cwd: '/workspace/small',
    });

    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      'remote-dev',         // explicit host
      '/workspace/big',  // explicit cwd
    );

    expect(result.resolvedHost).toBe('remote-dev');    // explicit wins
    expect(result.resolvedCwd).toBe('/workspace/big'); // explicit wins
    expect(result.error).toBeUndefined();
  });

  it('falls back to the project default_host when no explicit host', async () => {
    await setProjectMetadata('HomeLab', {
      default_host: 'remote-dev',
      default_cwd: '/workspace/project',
    });

    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      undefined,         // no explicit host
      undefined,         // no explicit cwd
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace/project');
    expect(result.error).toBeUndefined();
  });

  it('matches the project registry row case-insensitively', async () => {
    await setProjectMetadata('HomeLab', { default_host: 'remote-dev', default_cwd: '/workspace/p' });

    const result = await resolveHostAndCwd({ project: 'homelab' }, undefined, undefined);

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace/p');
  });

  it('uses local execution when no host specified and the project has no defaults', async () => {
    await addTask({ title: 'Regular task', project: 'HomeLab' });

    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      undefined,            // no host
      '/local/workspace',   // local cwd provided
    );

    expect(result.resolvedHost).toBeUndefined(); // local execution
    expect(result.resolvedCwd).toBe('/local/workspace');
    expect(result.error).toBeUndefined();
  });

  it('resolves nothing from the registry for an Inbox task (no row by design)', async () => {
    const { task } = await addTask({ title: 'Loose thought' });
    expect(task.project).toBe('');

    const result = await resolveHostAndCwd({ id: task.id, project: task.project }, undefined, undefined);

    expect(result.resolvedHost).toBeUndefined();
    expect(result.error).toContain('working_directory is required');
  });

  it('errors when remote host has no cwd and the project has no default_cwd', async () => {
    await setProjectMetadata('HomeLab', { default_host: 'remote-dev' });

    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      undefined, // host will be resolved from the project
      undefined, // no cwd provided and no default_cwd
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.error).toContain('Remote host');
    expect(result.error).toContain('no working directory');
  });

  it('errors when explicit remote host has no cwd', async () => {
    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      'remote-dev', // explicit host
      undefined, // no cwd
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.error).toContain('Remote host');
    expect(result.error).toContain('no working directory');
  });

  it('errors when no cwd at all for local session', async () => {
    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      undefined, // no host
      undefined, // no cwd
    );

    expect(result.resolvedHost).toBeUndefined();
    expect(result.error).toContain('working_directory is required');
  });

  it('explicit host overrides the project host, but project cwd is used as fallback', async () => {
    await setProjectMetadata('HomeLab', {
      default_host: 'staging-server',
      default_cwd: '/workspace/from-metadata',
    });

    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      'remote-dev',   // explicit host overrides staging-server
      undefined,   // cwd falls back to the project default
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace/from-metadata');
    expect(result.error).toBeUndefined();
  });

  it('explicit cwd overrides the project cwd, and the project host is used as fallback', async () => {
    await setProjectMetadata('HomeLab', {
      default_host: 'remote-dev',
      default_cwd: '/workspace/from-metadata',
    });

    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      undefined,              // host falls back to the project default
      '/workspace/explicit',  // explicit cwd overrides the project default
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace/explicit');
    expect(result.error).toBeUndefined();
  });

  it('skips the project lookup when task is null (taskless sessions)', async () => {
    const result = await resolveHostAndCwd(
      null,       // no task
      'remote-dev',  // explicit host
      '/workspace',
    );

    expect(result.resolvedHost).toBe('remote-dev');
    expect(result.resolvedCwd).toBe('/workspace');
    expect(result.error).toBeUndefined();
  });

  it('a project with only default_cwd (no host) resolves to a local session with cwd', async () => {
    await setProjectMetadata('HomeLab', { default_cwd: '/workspace/local-project' });

    const result = await resolveHostAndCwd(
      { project: 'HomeLab' },
      undefined, // no host
      undefined, // no explicit cwd — falls back to the project default
    );

    expect(result.resolvedHost).toBeUndefined(); // local
    expect(result.resolvedCwd).toBe('/workspace/local-project');
    expect(result.error).toBeUndefined();
  });
});

describe('Task-level cwd resolution', () => {
  it('task.cwd overrides project default_cwd', async () => {
    await setProjectMetadata('HomeLab', { default_cwd: '/workspace/project-default' });

    const { task } = await addTask({ title: 'Special task', project: 'HomeLab' });
    await updateTask(task.id, { cwd: '/workspace/task-override' });
    const updated = await getTask(task.id);

    const result = await resolveHostAndCwd(
      { id: updated.id, project: updated.project, cwd: updated.cwd },
      undefined, // no explicit host
      undefined, // no explicit cwd
    );

    expect(result.resolvedCwd).toBe('/workspace/task-override');
    expect(result.error).toBeUndefined();
  });

  it('explicit param overrides task.cwd', async () => {
    const { task } = await addTask({ title: 'Task with cwd', project: 'HomeLab' });
    await updateTask(task.id, { cwd: '/workspace/task-cwd' });
    const updated = await getTask(task.id);

    const result = await resolveHostAndCwd(
      { id: updated.id, project: updated.project, cwd: updated.cwd },
      undefined,
      '/workspace/explicit',  // explicit param wins
    );

    expect(result.resolvedCwd).toBe('/workspace/explicit');
    expect(result.error).toBeUndefined();
  });

  it('subtask inherits cwd from parent task', async () => {
    const { task: parent } = await addTask({ title: 'Parent', project: 'HomeLab' });
    await updateTask(parent.id, { cwd: '/workspace/parent-cwd' });

    const { task: child } = await addTask({
      title: 'Child',
      project: 'HomeLab',
      parent_task_id: parent.id,
    });

    // Child has no cwd — should inherit from parent
    const result = await resolveHostAndCwd(
      { id: child.id, project: child.project, cwd: child.cwd, parent_task_id: child.parent_task_id },
      undefined,
      undefined,
    );

    expect(result.resolvedCwd).toBe('/workspace/parent-cwd');
    expect(result.error).toBeUndefined();
  });

  it('subtask cwd overrides parent cwd', async () => {
    const { task: parent } = await addTask({ title: 'Parent', project: 'HomeLab' });
    await updateTask(parent.id, { cwd: '/workspace/parent-cwd' });

    const { task: child } = await addTask({
      title: 'Child',
      project: 'HomeLab',
      parent_task_id: parent.id,
    });
    await updateTask(child.id, { cwd: '/workspace/child-cwd' });
    const updatedChild = await getTask(child.id);

    const result = await resolveHostAndCwd(
      { id: updatedChild.id, project: updatedChild.project, cwd: updatedChild.cwd, parent_task_id: updatedChild.parent_task_id },
      undefined,
      undefined,
    );

    expect(result.resolvedCwd).toBe('/workspace/child-cwd');
    expect(result.error).toBeUndefined();
  });

  it('falls back to project metadata when no task cwd in chain', async () => {
    await setProjectMetadata('HomeLab', { default_cwd: '/workspace/project-default' });

    const { task: parent } = await addTask({ title: 'Parent no cwd', project: 'HomeLab' });
    const { task: child } = await addTask({
      title: 'Child no cwd',
      project: 'HomeLab',
      parent_task_id: parent.id,
    });

    // Neither parent nor child has cwd → falls back to project metadata
    const result = await resolveHostAndCwd(
      { id: child.id, project: child.project, cwd: child.cwd, parent_task_id: child.parent_task_id },
      undefined,
      undefined,
    );

    expect(result.resolvedCwd).toBe('/workspace/project-default');
    expect(result.error).toBeUndefined();
  });
});
