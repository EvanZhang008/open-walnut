/**
 * fileTasksIntoFolder: the batch write behind the plugin API's `tasks.fileIntoFolder`.
 *
 * One transaction over the listed rows, so the rules a per-task updateTask applies have to
 * hold here too: a folder's project goes through the registry (renamed names redirect,
 * deleted ones refuse, new ones become local), a synced task is only ever filed, the rest
 * of a task's payload survives, and a task that changed since the caller planned is left
 * alone. Folders also follow their project through a rename.
 *
 * fileTasksIntoProject (`tasks.fileIntoProject`) is the same write with a project as the
 * target: a task that moves in lands at the top level, one already there keeps its folder.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-folder-filing'))

import {
  addTask,
  completeTask,
  createCustomTier,
  createFolder,
  deleteProject,
  ensureCustomTier,
  ensureProject,
  fileTasksIntoFolder,
  fileTasksIntoProject,
  getProjectRecord,
  getTask,
  listGroups,
  renameProject,
  setFocusTier,
  togglePin,
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

describe('fileTasksIntoProject', () => {
  it('moves tasks to the top level of the project, leaving their old folder behind', async () => {
    await ensureProject('Old', 'local')
    const oldFolder = await createFolder('Old runs', 'Old')
    const filed = await localTask('Filed run', 'Old')
    await fileTasksIntoFolder(oldFolder.group_id, [{ id: filed.id }])
    const loose = await localTask('Loose run caf\u00e9', 'Import', { tags: ['walnut:external-sessions'] })
    await updateTask(loose.id, { cwd: '/work/checkout' })
    await updateTasksBulk([{ id: loose.id, patch: { session_ids: ['sess-1'] } }])

    const result = await fileTasksIntoProject('Robot runs', [
      { id: filed.id, add_tags: ['ticket:P1'] },
      { id: loose.id, add_tags: ['ticket:P2'], title: 'Nodes stuck NotReady', expect_project: 'Import', expect_title: 'Loose run caf\u00e9' },
    ])

    expect(result.project).toBe('Robot runs')
    expect(result.filed.map((one) => one.id)).toEqual([filed.id, loose.id])
    const movedFiled = await getTask(filed.id)
    expect(movedFiled).toMatchObject({ project: 'Robot runs', tags: ['ticket:P1'] })
    expect(movedFiled.group_id).toBeUndefined()
    const movedLoose = await getTask(loose.id)
    expect(movedLoose).toMatchObject({ project: 'Robot runs', title: 'Nodes stuck NotReady', cwd: '/work/checkout', session_ids: ['sess-1'] })
    expect(movedLoose.group_id).toBeUndefined()
    expect(movedLoose.tags?.sort()).toEqual(['ticket:P2', 'walnut:external-sessions'])
    // The old folder is left in place, empty; nothing deletes it behind the user's back.
    expect((await listGroups()).find((one) => one.group_id === oldFolder.group_id)).toMatchObject({ member_ids: [] })
    expect(await getProjectRecord('Robot runs')).toMatchObject({ source: 'local' })
  })

  it('keeps a task already in the project in the folder the user put it in', async () => {
    await ensureProject('Robot runs', 'local')
    const mine = await createFolder('Keep an eye on', 'Robot runs')
    const task = await localTask('Run', 'Robot runs')
    await fileTasksIntoFolder(mine.group_id, [{ id: task.id }])

    const result = await fileTasksIntoProject('robot RUNS', [{ id: task.id, add_tags: ['ticket:P3'] }])

    expect(result.filed.map((one) => one.id)).toEqual([task.id])
    expect(await getTask(task.id)).toMatchObject({ project: 'Robot runs', group_id: mine.group_id, tags: ['ticket:P3'] })
    // Asked again with nothing new: in neither list.
    expect(await fileTasksIntoProject('Robot runs', [{ id: task.id, add_tags: ['ticket:P3'] }])).toMatchObject({ filed: [], skipped: [] })
    // Asked for the top level, it leaves the folder and keeps everything else.
    expect((await fileTasksIntoProject('Robot runs', [{ id: task.id, top_level: true }])).filed.map((one) => one.id)).toEqual([task.id])
    const unfiled = await getTask(task.id)
    expect(unfiled).toMatchObject({ project: 'Robot runs', tags: ['ticket:P3'] })
    expect(unfiled.group_id).toBeUndefined()
  })

  it('applies the same skips as folder filing', async () => {
    const synced = await localTask('Synced elsewhere', 'Import')
    await updateTasksBulk([{ id: synced.id, patch: { source: 'ms-todo' } }])
    const moved = await localTask('Planned in Import', 'Import')
    await updateTask(moved.id, { project: 'Mine' })

    const result = await fileTasksIntoProject('Robot runs', [
      { id: synced.id }, { id: moved.id, expect_project: 'Import' }, { id: 'no-such-task' },
    ])

    expect(result.filed).toEqual([])
    expect(result.skipped).toEqual([
      { id: synced.id, reason: 'synced' }, { id: moved.id, reason: 'changed' }, { id: 'no-such-task', reason: 'missing' },
    ])
    expect(await getTask(synced.id)).toMatchObject({ project: 'Import' })
    expect(await getTask(moved.id)).toMatchObject({ project: 'Mine' })
  })

  it("follows a renamed project's redirect, and refuses a deleted or empty name", async () => {
    await localTask('Keeps Team alive', 'Team')
    await renameProject('Team', 'Team Ops')
    const task = await localTask('Run', 'Import')
    const result = await fileTasksIntoProject('Team', [{ id: task.id }])
    expect(result.project).toBe('Team Ops')
    expect(await getTask(task.id)).toMatchObject({ project: 'Team Ops' })

    await ensureProject('Gone', 'local')
    await deleteProject('Gone')
    const other = await localTask('Other run', 'Import')
    await expect(fileTasksIntoProject('Gone', [{ id: other.id }])).rejects.toThrow(/was deleted/)
    await expect(fileTasksIntoProject('  ', [{ id: other.id }])).rejects.toThrow(/cannot be empty/)
    expect(await getTask(other.id)).toMatchObject({ project: 'Import' })
  })
})

describe('filing with pin_tier', () => {
  it('pins open unpinned tasks at the bottom of the board, in item order, moves a pinned one to the asked tier, and never pins a finished one', async () => {
    const earlier = await localTask('Already on the board', 'Mine', { pinned: false })
    await togglePin(earlier.id)
    const [fresh, second, satellite] = await Promise.all(['Fresh run', 'Second run', 'Satellite run'].map((title) => localTask(title, 'Import', { pinned: false })))
    const waiting = await localTask('Pinned in Wait by the user', 'Import', { pinned: false })
    await togglePin(waiting.id)
    await setFocusTier(waiting.id, 'wait')
    const done = await localTask('Finished run', 'Import', { pinned: false })
    await completeTask(done.id)
    // New pins follow every pin on the board, the user's two included.
    const floor = Math.max((await getTask(earlier.id)).pin_order ?? 0, (await getTask(waiting.id)).pin_order ?? 0)

    const result = await fileTasksIntoProject('Robot runs', [
      { id: fresh.id, pin_tier: 'focus' },
      { id: second.id, pin_tier: 'focus', add_tags: ['ticket:P1'] },
      { id: satellite.id, pin_tier: 'satellite' },
      { id: waiting.id, pin_tier: 'focus' },
      { id: done.id, pin_tier: 'focus', add_tags: ['ticket:P2'] },
    ])

    expect(result.filed.map((one) => one.id)).toEqual([fresh.id, second.id, satellite.id, waiting.id, done.id])
    expect(await getTask(fresh.id)).toMatchObject({ pinned: true, focus_tier: 'focus', pin_order: floor + 1 })
    expect(await getTask(second.id)).toMatchObject({ pinned: true, focus_tier: 'focus', pin_order: floor + 2, tags: ['ticket:P1'] })
    const sat = await getTask(satellite.id)
    expect(sat).toMatchObject({ pinned: true, pin_order: floor + 3 })
    expect(sat.focus_tier).toBeUndefined()
    // A pinned task moves to the asked tier and keeps its place in the order; a finished task
    // is filed and tagged, never pinned.
    expect(await getTask(waiting.id)).toMatchObject({ pinned: true, focus_tier: 'focus', project: 'Robot runs', pin_order: floor })
    const finished = await getTask(done.id)
    expect(finished).toMatchObject({ project: 'Robot runs', tags: ['ticket:P2'] })
    expect(finished.pinned).toBeFalsy()
    // Asked again: nothing to do.
    expect(await fileTasksIntoProject('Robot runs', [{ id: fresh.id, pin_tier: 'focus' }])).toMatchObject({ filed: [] })
  })

  it('takes a custom tier, and refuses an unknown one before writing anything', async () => {
    const { tier } = await createCustomTier('Icebox')
    const task = await localTask('Run', 'Import', { pinned: false })
    const other = await localTask('Other run', 'Import', { pinned: false })
    await expect(fileTasksIntoProject('Robot runs', [{ id: other.id, add_tags: ['ticket:P3'] }, { id: task.id, pin_tier: 'someday' }]))
      .rejects.toThrow(/unknown pin tier "someday"/)
    expect(await getTask(other.id)).toMatchObject({ project: 'Import' })
    expect((await getTask(task.id)).pinned).toBeFalsy()

    await fileTasksIntoFolder((await createFolder('Runs', 'Robot runs')).group_id, [{ id: task.id, pin_tier: tier.id }])
    expect(await getTask(task.id)).toMatchObject({ pinned: true, focus_tier: tier.id, project: 'Robot runs' })
  })

  it('unpins with pin_tier null, moves a pin between tiers, and leaves pins alone when the field is absent', async () => {
    const [a, b, c] = await Promise.all(['A', 'B', 'C'].map((title) => localTask(title, 'Import', { pinned: false })))
    await fileTasksIntoProject('Robot runs', [{ id: a.id, pin_tier: 'focus' }, { id: b.id, pin_tier: 'focus' }, { id: c.id, pin_tier: 'backlog' }])
    const orderB = (await getTask(b.id)).pin_order
    const result = await fileTasksIntoProject('Robot runs', [
      { id: a.id, pin_tier: null, add_tags: ['aged'] },
      { id: b.id, pin_tier: 'backlog' },
      { id: c.id, add_tags: ['kept'] },
    ])
    expect(result.filed.map((one) => one.id)).toEqual([a.id, b.id, c.id])
    const unpinned = await getTask(a.id)
    expect(unpinned.pinned).toBeFalsy()
    expect(unpinned.pin_order).toBeUndefined()
    expect(unpinned.focus_tier).toBeUndefined()
    expect(unpinned.tags).toEqual(['aged'])
    expect(await getTask(b.id)).toMatchObject({ pinned: true, focus_tier: 'backlog', pin_order: orderB })
    expect(await getTask(c.id)).toMatchObject({ pinned: true, focus_tier: 'backlog', tags: ['kept'] })
    // Unpinning an unpinned task, or moving to the tier it has, is nothing to do.
    expect(await fileTasksIntoProject('Robot runs', [{ id: a.id, pin_tier: null }, { id: b.id, pin_tier: 'backlog' }])).toMatchObject({ filed: [] })
    // Satellite is the absence of a tier.
    await fileTasksIntoProject('Robot runs', [{ id: b.id, pin_tier: 'satellite' }])
    const sat = await getTask(b.id)
    expect(sat.pinned).toBe(true)
    expect(sat.focus_tier).toBeUndefined()
  })

  it('pins at the top in item order when asked, above every pin so far', async () => {
    const mine = await localTask('Mine', 'Work', { pinned: false })
    await togglePin(mine.id)
    const [newest, older, bottom] = await Promise.all(['Newest', 'Older', 'Bottom'].map((title) => localTask(title, 'Import', { pinned: false })))
    await fileTasksIntoProject('Robot runs', [
      { id: newest.id, pin_tier: 'focus', pin_at: 'top' },
      { id: older.id, pin_tier: 'focus', pin_at: 'top' },
      { id: bottom.id, pin_tier: 'focus' },
    ])
    const order = async (id: string) => (await getTask(id)).pin_order ?? 0
    expect(await order(newest.id)).toBeLessThan(await order(older.id))
    expect(await order(older.id)).toBeLessThan(await order(mine.id))
    expect(await order(mine.id)).toBeLessThan(await order(bottom.id))
    // The next batch at the top goes above the earlier one.
    const later = await localTask('Later', 'Import', { pinned: false })
    await fileTasksIntoProject('Robot runs', [{ id: later.id, pin_tier: 'focus', pin_at: 'top' }])
    expect(await order(later.id)).toBeLessThan(await order(newest.id))
    // An existing pin keeps its place without pin_at, and moves when it is given.
    expect(await fileTasksIntoProject('Robot runs', [{ id: bottom.id, pin_tier: 'focus' }])).toMatchObject({ filed: [] })
    await fileTasksIntoProject('Robot runs', [{ id: bottom.id, pin_tier: 'focus', pin_at: 'top' }])
    expect(await order(bottom.id)).toBeLessThan(await order(later.id))
    expect(await getTask(bottom.id)).toMatchObject({ pinned: true, focus_tier: 'focus' })
  })

  it('takes tags off, swaps one for another in one item, and sets the creation time once', async () => {
    const task = await localTask('Run', 'Import', { pinned: false, tags: ['marker', 'ticket:P1'] })
    const opened = '2026-09-20T08:00:00.000Z'
    const before = (await getTask(task.id)).created_at
    await fileTasksIntoProject('Robot runs', [{ id: task.id, remove_tags: ['marker', 'absent'], add_tags: ['severity:2'], created_at: opened }])
    expect(await getTask(task.id)).toMatchObject({ tags: ['ticket:P1', 'severity:2'], created_at: opened })
    expect(before).not.toBe(opened)
    // A removal and an addition of the same tag keeps it; a bad or future time is ignored.
    await fileTasksIntoProject('Robot runs', [{ id: task.id, remove_tags: ['severity:2'], add_tags: ['severity:2'], created_at: 'not a time' }])
    expect(await getTask(task.id)).toMatchObject({ tags: ['ticket:P1', 'severity:2'], created_at: opened })
    const future = new Date(Date.now() + 86_400_000).toISOString()
    expect(await fileTasksIntoProject('Robot runs', [{ id: task.id, created_at: future }])).toMatchObject({ filed: [] })
    expect((await getTask(task.id)).created_at).toBe(opened)
  })
})

describe('ensureCustomTier', () => {
  it('reuses a tier by label, case-insensitively, else creates one, and refuses a built-in name', async () => {
    const made = await ensureCustomTier('Ticket Runs')
    expect(made.created).toBe(true)
    const again = await ensureCustomTier('  ticket   runs ')
    expect(again).toEqual({ tier: made.tier, created: false })
    const theirs = await createCustomTier('Icebox')
    expect(await ensureCustomTier('icebox')).toEqual({ tier: theirs.tier, created: false })
    await expect(ensureCustomTier('Focus')).rejects.toThrow(/built-in tier/)
  })
})
