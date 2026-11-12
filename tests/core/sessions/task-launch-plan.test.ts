import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs/promises';
import { createMockConstants } from '../../helpers/mock-constants.js';
vi.mock('../../../src/constants.js', () => createMockConstants('launch-plan'));
import { resolveTaskLaunchReadOnly } from '../../../src/core/sessions/task-launch-plan.js';
import type { Task } from '../../../src/core/types.js';
import { addTask } from '../../../src/core/task-manager.js';
import { PROJECTS_MEMORY_DIR } from '../../../src/constants.js';
import { taskDirForHost } from '../../../src/core/sessions/task-dir-place.js';
import { updateConfig } from '../../../src/core/config-manager.js';

describe('Read-only task launch resolution', () => {
  it('resolves a task with no folder to its own task directory without creating it or claiming a session', async () => {
    for (const project of ['', 'zz test heron 141057', 'Imported from devbox']) {
      const task = (await addTask({ title: 'Review work', project })).task;
      const launch = await resolveTaskLaunchReadOnly(task, { taskIdPrefix: task.id, source: 'fixture', mode: 'default', expectReply: false });
      expect(launch.cwd).toBe(await taskDirForHost(task.id, '__local__'));
      // Never the memory tree: that left an empty memory folder per project (2026-10-31).
      expect(launch.cwd.startsWith(PROJECTS_MEMORY_DIR)).toBe(false);
      expect(launch.createTaskDir).toBe(true);
      await expect(fs.stat(launch.cwd)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(task.session_ids).toEqual([]);
      const pinned = await resolveTaskLaunchReadOnly(task, { taskIdPrefix: task.id, source: 'fixture', cwd: launch.cwd, host: '__local__' });
      expect(pinned.createTaskDir).toBe(true);
    }
    await expect(fs.stat(PROJECTS_MEMORY_DIR)).rejects.toMatchObject({ code: 'ENOENT' });
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
  it('a VP or lead starts in its own task directory, except in its isolated workspace or a folder the person picked', async () => {
    const lead = { ...(await addTask({ title: 'Acme lead', project: '' })).task, org_role: 'lead' } as Task;
    const own = await taskDirForHost(lead.id, '__local__');
    const base = { taskIdPrefix: lead.id, source: 'api-v1' };
    expect((await resolveTaskLaunchReadOnly(lead, { ...base, cwd: '/fixture/repo' })).cwd).toBe(own);
    expect((await resolveTaskLaunchReadOnly(lead, { ...base, cwd: '/fixture/repo', cwdChosen: true })).cwd).toBe('/fixture/repo');
    // Its isolated workspace is a copy, never the repository: it keeps that folder.
    const ready = { state: 'ready', host: '__local__', anchor: '/fixture/repo', root: '/fixture/ws', cwd: '/fixture/ws' } as Task['workspace'];
    expect((await resolveTaskLaunchReadOnly({ ...lead, workspace: ready }, base)).cwd).toBe('/fixture/ws');
  });
  it('a preview of a VP or lead on a remote host that has not said its root shows no folder, and never throws', async () => {
    // The inbox's plan of an action and the Org page's contact read this (item-plans.ts, org-store.ts).
    await updateConfig({ hosts: { devbox9: { hostname: 'devbox9.example.test', enabled: true } } } as never);
    const lead = { ...(await addTask({ title: 'Acme remote lead', project: '' })).task, org_role: 'lead' } as Task;
    const plan = await resolveTaskLaunchReadOnly(lead, { taskIdPrefix: lead.id, source: 'human-inbox', host: 'devbox9' }, { preview: true });
    expect(plan.cwd).toBe('');
    expect(plan.host).toBe('devbox9');
    expect(plan.createTaskDir).toBe(true);
  });
});
