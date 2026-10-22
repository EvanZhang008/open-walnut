import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('launch-plan'));
import { resolveTaskLaunchReadOnly } from '../../../src/core/sessions/task-launch-plan.js';
import type { Task } from '../../../src/core/types.js';
import { addTask } from '../../../src/core/task-manager.js';
import { PROJECTS_MEMORY_DIR } from '../../../src/constants.js';

describe('Read-only task launch resolution', () => {
  it('resolves the same fallback directory without creating it or claiming a session', async () => {
    const task = (await addTask({ title: 'Review work', project: '' })).task;
    const launch = await resolveTaskLaunchReadOnly(task, { taskIdPrefix: task.id, source: 'fixture', mode: 'default', expectReply: false });
    expect(launch.cwd).toBe(`${PROJECTS_MEMORY_DIR}/inbox`);
    expect(launch.createLocalDirectory).toBe(true);
    await expect(fs.stat(launch.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(task.session_ids).toEqual([]);
    const pinned = await resolveTaskLaunchReadOnly(task, { taskIdPrefix: task.id, source: 'fixture', cwd: launch.cwd, host: '__local__' });
    expect(pinned.createLocalDirectory).toBe(true);
  });
  it('does not freeze a deferred workspace launch before its final directory is known', async () => {
    const task = (await addTask({ title: 'Workspace work', project: '' })).task;
    const workspace = { state: 'creating', host: '__local__', anchor: '/fixture/project', root: '/fixture/workspace' } as Task['workspace'];
    const params = { taskIdPrefix: task.id, source: 'human-inbox', cwd: '/fixture/project' };
    await expect(resolveTaskLaunchReadOnly({ ...task, workspace }, params)).rejects.toThrow('workspace is not ready');
    const ready = { ...workspace, state: 'ready', cwd: '/fixture/workspace' } as Task['workspace'];
    expect((await resolveTaskLaunchReadOnly({ ...task, workspace: ready }, params)).cwd).toBe('/fixture/workspace');
    expect((await resolveTaskLaunchReadOnly({ ...task, workspace }, { ...params, cwd: '/fixture/elsewhere' })).cwd).toBe('/fixture/elsewhere');
  });
});
