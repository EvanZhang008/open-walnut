/**
 * fileTasksIntoFolder: the batch write behind the plugin API's `tasks.fileIntoFolder`.
 *
 * One transaction over the listed rows, so the rules a per-task updateTask applies have to
 * hold here too: a folder's project goes through the registry (renamed names redirect,
 * deleted ones refuse, new ones become local), a synced task is only ever filed, the rest
 * of a task's payload survives, and a task that changed since the caller planned is left
 * alone. Folders also follow their project through a rename.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-folder-filing'))

import {
  addTask,
  createFolder,
  deleteProject,
  ensureProject,
  fileTasksIntoFolder,
  getProjectRecord,
  getTask,
  listGroups,
  renameProject,
  updateTask,
  updateTasksBulk,
  _resetForTesting,
} from '../../src/core/task-manager.js'
import { closeDb, getDb } from '../../src/core/task-db.js'
import { WALNUT_HOME } from '../../src/constants.js'
import { bus, EventNames } from '../../src/core/event-bus.js'

async function freshHome(): Promise<void> {
  if (!WALNUT_HOME.includes('walnut-task-folder-filing')) throw new Error(`refusing to run against ${WALNUT_HOME}`)
  closeDb()
  _resetForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 })
}

beforeEach(freshHome)
afterEach(async () => {
  bus.unsubscribe('filing-test-observer')
  await freshHome()
})

async function localTask(title: string, project: string, extra: Record<string, unknown> = {}) {
  const { task } = await addTask({ title, project, source: 'local', ...extra } as never)
  return task
}

describe('fileTasksIntoFolder', () => {
  it('moves a local task into the folder, adds tags and title, and keeps the rest of the task', async () => {
    const task = await localTask('Investigate this ticket', 'Import', { tags: ['walnut:external-sessions'] })
    await updateTask(task.id, { cwd: '/work/checkout' })
    await updateTasksBulk([{ id: task.id, patch: { session_ids: ['sess-1'], unread: true } }])
    await ensureProject('Team', 'local')
    const folder = await createFolder('Robot runs', 'Team')

    const result = await fileTasksIntoFolder(folder.group_id, [
      { id: task.id, add_tags: ['ticket:P1'], title: 'Nodes stuck NotReady', expect_project: 'Import', expect_title: 'Investigate this ticket' },
    ])

    expect(result.filed.map((one) => one.id)).toEqual([task.id])
    const after = await getTask(task.id)
    expect(after).toMatchObject({
      project: 'Team', group_id: folder.group_id, title: 'Nodes stuck NotReady', source: 'local',
      cwd: '/work/checkout', session_ids: ['sess-1'], unread: true,
    })
    expect(after.tags?.sort()).toEqual(['ticket:P1', 'walnut:external-sessions'])
  })

  it('files a synced task only in place, and never moves, retags or renames it', async () => {
    await ensureProject('Team', 'local')
    const folder = await createFolder('Robot runs', 'Team')
    const inPlace = await localTask('Synced here', 'Team')
    const elsewhere = await localTask('Synced elsewhere', 'Import')
    const retag = await localTask('Synced, asked to retag', 'Team')
    await updateTasksBulk([inPlace, elsewhere, retag].map((one) => ({ id: one.id, patch: { source: 'ms-todo' } })))

    const result = await fileTasksIntoFolder(folder.group_id, [
      { id: inPlace.id },
      { id: elsewhere.id },
      { id: retag.id, add_tags: ['ticket:P2'] },
    ])

    expect(result.filed.map((one) => one.id)).toEqual([inPlace.id])
    expect(result.skipped).toEqual([{ id: elsewhere.id, reason: 'synced' }, { id: retag.id, reason: 'synced' }])
    expect(await getTask(inPlace.id)).toMatchObject({ project: 'Team', group_id: folder.group_id })
    expect(await getTask(elsewhere.id)).toMatchObject({ project: 'Import' })
    expect((await getTask(retag.id)).tags).toBeUndefined()
  })

  it('leaves a task that moved or was renamed since the caller planned', async () => {
    await ensureProject('Team', 'local')
    const folder = await createFolder('Robot runs', 'Team')
    const moved = await localTask('Planned in Import', 'Import')
    await updateTask(moved.id, { project: 'Mine' })
    const renamed = await localTask('Old generic title', 'Import')
    await updateTask(renamed.id, { title: 'The user renamed this' })

    const result = await fileTasksIntoFolder(folder.group_id, [
      { id: moved.id, expect_project: 'Import' },
      { id: renamed.id, title: 'Machine title', expect_title: 'Old generic title', expect_project: 'Import' },
    ])

    expect(result.skipped).toEqual([{ id: moved.id, reason: 'changed' }])
    expect(await getTask(moved.id)).toMatchObject({ project: 'Mine' })
    // Still filed; the user's title stands.
    expect(await getTask(renamed.id)).toMatchObject({ project: 'Team', group_id: folder.group_id, title: 'The user renamed this' })
  })

  it("follows a renamed project's redirect, refuses a deleted one, and makes a missing one local", async () => {
    await ensureProject('Team', 'local')
    const folder = await createFolder('Robot runs', 'Team')
    const task = await localTask('Run', 'Import')

    // A folder record left on the old name (as renames before this fix did) follows the redirect.
    await localTask('Keeps Team alive', 'Team')
    await renameProject('Team', 'Team Ops')
    getDb()!.prepare('UPDATE task_groups SET project = ? WHERE id = ?').run('Team', folder.group_id)
    _resetForTesting()
    await fileTasksIntoFolder(folder.group_id, [{ id: task.id }])
    expect(await getTask(task.id)).toMatchObject({ project: 'Team Ops', group_id: folder.group_id })
    expect((await listGroups()).find((one) => one.group_id === folder.group_id)).toMatchObject({ project: 'Team Ops' })

    // A folder whose project was deleted takes nothing.
    await ensureProject('Gone', 'local')
    const orphan = await createFolder('Orphan', 'Gone')
    await deleteProject('Gone')
    const other = await localTask('Other run', 'Import')
    await expect(fileTasksIntoFolder(orphan.group_id, [{ id: other.id }])).rejects.toThrow(/was deleted/)
    expect(await getTask(other.id)).toMatchObject({ project: 'Import' })

    // A folder in a project with no registry row mints a local one, announced once.
    const created: unknown[] = []
    bus.subscribe('filing-test-observer', (event) => { if (event.name === EventNames.PROJECT_CREATED) created.push(event.data) },
      { global: true, interest: [EventNames.PROJECT_CREATED] })
    const fresh = await createFolder('New home', 'Brand New')
    expect(await getProjectRecord('Brand New')).toBeNull()
    await fileTasksIntoFolder(fresh.group_id, [{ id: other.id }])
    expect(await getProjectRecord('Brand New')).toMatchObject({ source: 'local' })
    expect(created).toEqual([expect.objectContaining({ name: 'Brand New', source: 'local' })])
  })

  it('carries folders along when their project is renamed', async () => {
    await ensureProject('Team', 'local')
    const folder = await createFolder('Robot runs', 'Team')
    const member = await localTask('Member', 'Team')
    await fileTasksIntoFolder(folder.group_id, [{ id: member.id }])

    await renameProject('Team', 'Team Ops')

    expect((await listGroups()).find((one) => one.group_id === folder.group_id)).toMatchObject({ project: 'Team Ops' })
    expect(await getTask(member.id)).toMatchObject({ project: 'Team Ops', group_id: folder.group_id })
  })

  it('refuses an unknown folder and writes nothing', async () => {
    const task = await localTask('Run', 'Import')
    await expect(fileTasksIntoFolder('g_missing', [{ id: task.id }])).rejects.toThrow(/not found/)
    expect((await getTask(task.id)).group_id).toBeUndefined()
  })
})
