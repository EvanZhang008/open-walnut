/**
 * Where work created from inside a task lands (src/core/sessions/caller-placement.ts).
 *
 * Two halves:
 *   - decidePlacement is the rule table, pure: every combination of an explicit
 *     project / folder against each caller kind.
 *   - resolveCallerPlacement, createTimeCwd, inheritedLaunchPair and
 *     joinOrCreateSiblingFolder run against the REAL task store and session
 *     registry in an isolated home, because the bugs this guards against live in
 *     the reads (a stale session project, a Personal AI ask, a vanished folder).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-caller-placement'))
// The background label refine calls a model; pin it so nothing leaves the box.
vi.mock('../../../src/core/fork-title.js', () => ({ summarizeGroupLabel: vi.fn(async () => 'Refined Folder') }))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  decidePlacement, resolveCallerPlacement, createTimeCwd, inheritedLaunchPair,
  joinOrCreateSiblingFolder, type CallerPlacement,
} from '../../../src/core/sessions/caller-placement.js'
import {
  addTask, getTask, createFolder, updateTask, setProjectMetadata, listGroups,
} from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'

const SESSION = { id: 's-1', host: '', cwd: '/repo/marina' }
const worker = (group_id?: string, project = 'marina'): CallerPlacement => ({
  kind: 'worker',
  task: { id: 't-caller', title: 'Refactor the fixture', project, ...(group_id ? { group_id } : {}) },
  session: SESSION,
})

describe('decidePlacement (the rule table)', () => {
  const others: CallerPlacement[] = [
    { kind: 'human' }, { kind: 'external' }, { kind: 'unknown' },
    { kind: 'untracked', session: SESSION },
    { kind: 'ask', task: { id: 't-ask', title: 'Ask', project: 'Ask Walnut' }, session: SESSION },
  ]
  it.each(others.map((c) => [c.kind, c] as const))('a %s caller keeps the old defaults', (_kind, caller) => {
    expect(decidePlacement({}, caller)).toEqual({ project: undefined, group_id: undefined, createFolderWithCaller: false })
    expect(decidePlacement({ project: 'acme', group_id: 'g_x' }, caller))
      .toEqual({ project: 'acme', group_id: 'g_x', createFolderWithCaller: false })
    expect(decidePlacement({ group_id: '' }, caller).group_id).toBeUndefined()
  })

  it('worker, nothing named, caller in a folder: same project, same folder', () => {
    expect(decidePlacement({}, worker('g_f'))).toEqual({
      project: 'marina', group_id: 'g_f', createFolderWithCaller: false, inheritedFrom: 't-caller',
    })
  })

  it('worker, nothing named, caller in no folder: same project, a new folder with both', () => {
    expect(decidePlacement({}, worker())).toEqual({
      project: 'marina', createFolderWithCaller: true, inheritedFrom: 't-caller',
    })
  })

  it('worker naming its own project (any case) still lands beside it', () => {
    expect(decidePlacement({ project: 'MARINA' }, worker('g_f'))).toMatchObject({ project: 'MARINA', group_id: 'g_f' })
    expect(decidePlacement({ project: 'marina' }, worker())).toMatchObject({ createFolderWithCaller: true })
  })

  it('worker naming another project: that project, and the folder does not follow', () => {
    expect(decidePlacement({ project: 'acme' }, worker('g_f'))).toEqual({
      project: 'acme', group_id: undefined, createFolderWithCaller: false,
    })
  })

  it('worker naming the Inbox on purpose from a project: Inbox, no folder', () => {
    expect(decidePlacement({ project: '' }, worker('g_f'))).toEqual({
      project: '', group_id: undefined, createFolderWithCaller: false,
    })
  })

  it('an Inbox worker filing into the Inbox is its own project: beside it', () => {
    expect(decidePlacement({}, worker(undefined, ''))).toMatchObject({ project: '', createFolderWithCaller: true })
  })

  it('worker saying group_id "" gets its project and no folder, and none is made', () => {
    expect(decidePlacement({ group_id: '' }, worker())).toEqual({
      project: 'marina', group_id: undefined, createFolderWithCaller: false, inheritedFrom: 't-caller',
    })
  })

  it('worker naming a folder gets that folder, never a new one', () => {
    expect(decidePlacement({ group_id: 'g_other' }, worker('g_f'))).toEqual({
      project: 'marina', group_id: 'g_other', createFolderWithCaller: false, inheritedFrom: 't-caller',
    })
  })
})

describe('against the real store', () => {
  beforeEach(async () => {
    await fs.rm(WALNUT_HOME, { recursive: true, force: true })
    await fs.mkdir(WALNUT_HOME, { recursive: true })
  })

  async function seedCaller(opts: { project?: string; host?: string; cwd?: string; walnutAgent?: boolean } = {}) {
    const { task } = await addTask({
      title: 'Refactor the fixture', project: opts.project ?? 'marina',
      ...(opts.walnutAgent ? { walnut_agent: true } : {}),
    } as Parameters<typeof addTask>[0])
    const sid = `sid-${task.id}`
    await createSessionRecord(sid, task.id, task.project ?? '', opts.cwd ?? '/repo/marina', {
      title: task.title, ...(opts.host !== undefined ? { host: opts.host } : {}),
    })
    return { task, sid }
  }

  it('classifies humans, unknown ids and untracked sessions', async () => {
    expect(await resolveCallerPlacement(undefined)).toEqual({ kind: 'human' })
    expect(await resolveCallerPlacement('  ')).toEqual({ kind: 'human' })
    expect(await resolveCallerPlacement('external')).toEqual({ kind: 'external' })
    expect(await resolveCallerPlacement('no-such-session')).toEqual({ kind: 'external' })
    await createSessionRecord('sid-loose', '', '', '/tmp/x', { title: 'loose' })
    expect(await resolveCallerPlacement('sid-loose')).toMatchObject({ kind: 'untracked', session: { id: 'sid-loose' } })
  })

  it('a Personal AI ask is not a worker, so nothing is placed from it', async () => {
    const { sid } = await seedCaller({ project: 'Ask Walnut', walnutAgent: true })
    expect((await resolveCallerPlacement(sid)).kind).toBe('ask')
    // Filed under an agent's Ask project without the flag counts too (the chat
    // drawer's own rule), so its work is never filed into "Ask Mentor".
    const unflagged = await seedCaller({ project: 'Ask Mentor' })
    expect((await resolveCallerPlacement(unflagged.sid)).kind).toBe('ask')
  })

  it('reads the task LIVE: a moved task places by its new project and folder', async () => {
    const { task, sid } = await seedCaller()
    const folder = await createFolder('Nav V2', 'acme')
    await updateTask(task.id, { project: 'acme' })
    const { addToGroup } = await import('../../../src/core/task-manager.js')
    await addToGroup(folder.group_id, [task.id])
    const caller = await resolveCallerPlacement(sid)
    expect(caller).toMatchObject({
      kind: 'worker',
      task: { id: task.id, project: 'acme', group_id: folder.group_id, group_label: 'Nav V2' },
      session: { id: sid, host: '', cwd: '/repo/marina' },
    })
  })

  it('normalizes a local host spelling to "" so host comparisons agree', async () => {
    const { sid } = await seedCaller({ host: '__local__' })
    expect(await resolveCallerPlacement(sid)).toMatchObject({ session: { host: '' } })
  })

  it('records the caller cwd only when it belongs to the host a later start would use', async () => {
    const { sid } = await seedCaller({ project: 'meadow' })
    const caller = await resolveCallerPlacement(sid)
    const decision = decidePlacement({}, caller)
    expect(await createTimeCwd({}, caller, decision)).toBe('/repo/marina')
    // A task filed elsewhere is never given the caller's cwd.
    expect(await createTimeCwd({ project: 'acme' }, caller, decidePlacement({ project: 'acme' }, caller))).toBeUndefined()
    // A project that launches on another host would get a path from this one.
    await setProjectMetadata('meadow', { default_host: 'devbox' })
    expect(await createTimeCwd({}, caller, decision)).toBeUndefined()
  })

  it('an explicit launch place decides what is recorded, and a host elsewhere records nothing', async () => {
    // Review finding: task_create {host:"devbox"} used to record the LOCAL caller
    // cwd, then start on devbox with a Mac path. The pair must never split.
    const { sid } = await seedCaller({ project: 'lighthouse' })
    const caller = await resolveCallerPlacement(sid)
    const decision = decidePlacement({}, caller)
    expect(await createTimeCwd({ launch_host: 'devbox' }, caller, decision)).toBeUndefined()
    expect(await createTimeCwd({ launch_host: 'devbox', launch_cwd: '/home/me/x' }, caller, decision)).toBeUndefined()
    expect(await createTimeCwd({ launch_host: '__local__', launch_cwd: '/explicit' }, caller, decision)).toBe('/explicit')
    // A cwd alone starts on the project default host, so it is what a retry must reuse.
    expect(await createTimeCwd({ launch_cwd: '/explicit' }, caller, decision)).toBe('/explicit')
    await setProjectMetadata('lighthouse', { default_host: 'devbox' })
    expect(await createTimeCwd({ launch_host: 'devbox', launch_cwd: '/home/me/x' }, caller, decision)).toBe('/home/me/x')
  })

  it('never records a cwd that is just the default the task would get anyway', async () => {
    const { sid } = await seedCaller({ project: 'orchard', cwd: '/srv/marina-default' })
    await setProjectMetadata('orchard', { default_cwd: '/srv/marina-default' })
    const caller = await resolveCallerPlacement(sid)
    expect(await createTimeCwd({}, caller, decidePlacement({}, caller))).toBeUndefined()
    const { PROJECTS_MEMORY_DIR } = await import('../../../src/constants.js')
    const mem = await seedCaller({ project: 'orchard', cwd: `${PROJECTS_MEMORY_DIR}/orchard` })
    const memCaller = await resolveCallerPlacement(mem.sid)
    expect(await createTimeCwd({}, memCaller, decidePlacement({}, memCaller))).toBeUndefined()
  })

  it('non-workers never record a cwd, whatever they name', async () => {
    const decision = decidePlacement({}, { kind: 'human' })
    expect(await createTimeCwd({ launch_cwd: '/explicit' }, { kind: 'human' }, decision)).toBeUndefined()
  })

  it('a remote caller in a project that launches on that host gets its cwd stamped', async () => {
    const { sid } = await seedCaller({ project: 'quarry', host: 'devbox', cwd: '/home/me/repo' })
    await setProjectMetadata('quarry', { default_host: 'devbox' })
    const caller = await resolveCallerPlacement(sid)
    expect(await createTimeCwd({}, caller, decidePlacement({}, caller))).toBe('/home/me/repo')
  })

  it('inherits the host + cwd pair only for another task of the same project', async () => {
    const { task: me, sid } = await seedCaller()
    const { task: sibling } = await addTask({ title: 'Sibling', project: 'marina' })
    const { task: other } = await addTask({ title: 'Other', project: 'acme' })
    expect(await inheritedLaunchPair(sid, sibling)).toEqual({ host: '', cwd: '/repo/marina' })
    expect(await inheritedLaunchPair(sid, other)).toBeUndefined()
    expect(await inheritedLaunchPair(sid, me)).toBeUndefined()
    expect(await inheritedLaunchPair(undefined, sibling)).toBeUndefined()
  })

  it('drops the pair when the caller host is no longer configured', async () => {
    const { sid } = await seedCaller({ host: 'gone-host', cwd: '/home/me/repo' })
    const { task: sibling } = await addTask({ title: 'Sibling', project: 'marina' })
    expect(await inheritedLaunchPair(sid, sibling)).toBeUndefined()
  })

  it('makes one folder holding the caller and the new task, then refines its label', async () => {
    const { task: me } = await seedCaller()
    const { task: born } = await addTask({ title: 'Fix the flake', project: 'marina' })
    const r = await joinOrCreateSiblingFolder(me, born.id, { eventSource: 'test', refineTitles: [me.title, born.title] })
    expect(r).toMatchObject({ created: true, label: me.title })
    expect((await getTask(me.id)).group_id).toBe(r.groupId)
    expect((await getTask(born.id)).group_id).toBe(r.groupId)
    await vi.waitFor(async () => {
      const groups = await listGroups()
      expect(groups.find((g) => g.group_id === r.groupId)?.label).toBe('Refined Folder')
    })
  })

  it('joins an existing (nested) folder instead of its parent', async () => {
    const { task: me } = await seedCaller()
    const parent = await createFolder('Parent', 'marina')
    const child = await createFolder('Child', 'marina', parent.group_id)
    const { addToGroup } = await import('../../../src/core/task-manager.js')
    await addToGroup(child.group_id, [me.id])
    const { task: born } = await addTask({ title: 'Fix the flake', project: 'marina' })
    const r = await joinOrCreateSiblingFolder({ ...me, group_id: child.group_id }, born.id, { eventSource: 'test' })
    expect(r).toMatchObject({ created: false, groupId: child.group_id })
    expect((await getTask(born.id)).group_id).toBe(child.group_id)
  })

  it('joins the folder the source sits in NOW, never merging it into a new one', async () => {
    // The caller was read with no folder, then the user filed it into one.
    const { task: me } = await seedCaller()
    const theirs = await createFolder('Made by the user', 'marina')
    const { addToGroup } = await import('../../../src/core/task-manager.js')
    await addToGroup(theirs.group_id, [me.id])
    const { task: born } = await addTask({ title: 'Fix the flake', project: 'marina' })
    const r = await joinOrCreateSiblingFolder({ id: me.id, title: me.title }, born.id, { eventSource: 'test' })
    expect(r).toMatchObject({ created: false, groupId: theirs.group_id, label: 'Made by the user' })
    expect((await listGroups()).find((g) => g.group_id === theirs.group_id)?.member_ids.sort()).toEqual([me.id, born.id].sort())
  })

  it('two creates at once from one folderless caller end in ONE folder holding all three', async () => {
    const { task: me } = await seedCaller()
    const { task: a } = await addTask({ title: 'First', project: 'marina' })
    const { task: b } = await addTask({ title: 'Second', project: 'marina' })
    const [ra, rb] = await Promise.all([
      joinOrCreateSiblingFolder(me, a.id, { eventSource: 'test' }),
      joinOrCreateSiblingFolder(me, b.id, { eventSource: 'test' }),
    ])
    expect([ra.created, rb.created].sort()).toEqual([false, true])
    expect(ra.groupId).toBe(rb.groupId)
    const folders = (await listGroups()).filter((g) => g.member_ids.includes(me.id))
    expect(folders).toHaveLength(1)
    expect(folders[0].member_ids.sort()).toEqual([me.id, a.id, b.id].sort())
  })

  it('a membership whose folder is gone counts as no folder: a fresh one is made', async () => {
    const { task: me } = await seedCaller()
    const { updateTaskRaw } = await import('../../../src/core/task-manager.js')
    await updateTaskRaw(me.id, { group_id: 'g_ghost' })
    const { task: born } = await addTask({ title: 'Fix the flake', project: 'marina' })
    const r = await joinOrCreateSiblingFolder({ ...me, group_id: 'g_ghost' }, born.id, { eventSource: 'test' })
    expect(r.created).toBe(true)
    expect(r.groupId).not.toBe('g_ghost')
    expect((await getTask(me.id)).group_id).toBe(r.groupId)
  })

  it('reports, never throws, when the source vanished before grouping', async () => {
    const { task: born } = await addTask({ title: 'Fix the flake', project: 'marina' })
    const r = await joinOrCreateSiblingFolder({ id: 'gone-task', title: 'Gone' }, born.id, { eventSource: 'test' })
    expect(r.created).toBe(false)
    expect(r.error).toMatch(/No task found/)
    expect((await getTask(born.id)).group_id).toBeUndefined()
  })
})
