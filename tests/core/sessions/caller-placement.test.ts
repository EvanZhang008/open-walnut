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
  joinOrCreateSiblingFolder, inheritedTier, type CallerPlacement,
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
  ]
  it.each(others.map((c) => [c.kind, c] as const))('a %s caller keeps the old defaults', (_kind, caller) => {
    expect(decidePlacement({}, caller)).toEqual({ project: undefined, group_id: undefined, placeBesideCaller: false })
    expect(decidePlacement({ project: 'acme', group_id: 'g_x' }, caller))
      .toEqual({ project: 'acme', group_id: 'g_x', placeBesideCaller: false })
    expect(decidePlacement({ group_id: '' }, caller).group_id).toBeUndefined()
  })

  it('a Personal AI ask keeps the old defaults for project and folder, but the work is its subtask', () => {
    // Its own `Ask …` project is never a place for the user's work, so nothing
    // is inherited from it; the task is still this conversation's, wherever it lands.
    const ask: CallerPlacement = { kind: 'ask', task: { id: 't-ask', title: 'Ask', project: 'Ask Walnut' }, session: SESSION }
    expect(decidePlacement({}, ask)).toEqual({ project: undefined, group_id: undefined, placeBesideCaller: false, parentTaskId: 't-ask' })
    expect(decidePlacement({ project: 'acme', group_id: 'g_x' }, ask))
      .toEqual({ project: 'acme', group_id: 'g_x', placeBesideCaller: false, parentTaskId: 't-ask' })
    expect(decidePlacement({ group_id: '' }, ask).group_id).toBeUndefined()
  })

  it('worker, nothing named, caller in a folder: same project, placed beside it under the lock', () => {
    // Join or nest is decided against the caller's CURRENT folder by
    // placeInFolderBeside, so the pure decision never names the folder.
    expect(decidePlacement({}, worker('g_f'))).toEqual({
      project: 'marina', placeBesideCaller: true, inheritedFrom: 't-caller', parentTaskId: 't-caller',
    })
  })

  it('worker, nothing named, caller in no folder: same project, a new folder with both', () => {
    expect(decidePlacement({}, worker())).toEqual({
      project: 'marina', placeBesideCaller: true, inheritedFrom: 't-caller', parentTaskId: 't-caller',
    })
  })

  it('worker naming its own project (any case) still lands beside it', () => {
    expect(decidePlacement({ project: 'MARINA' }, worker('g_f'))).toMatchObject({ project: 'MARINA', placeBesideCaller: true })
    expect(decidePlacement({ project: 'marina' }, worker())).toMatchObject({ placeBesideCaller: true })
  })

  it('worker naming another project: that project, and the folder does not follow', () => {
    expect(decidePlacement({ project: 'acme' }, worker('g_f'))).toEqual({
      project: 'acme', group_id: undefined, placeBesideCaller: false, parentTaskId: 't-caller',
    })
  })

  it('worker naming the Inbox on purpose from a project: Inbox, no folder', () => {
    expect(decidePlacement({ project: '' }, worker('g_f'))).toEqual({
      project: '', group_id: undefined, placeBesideCaller: false, parentTaskId: 't-caller',
    })
  })

  it('an Inbox worker filing into the Inbox is its own project: beside it', () => {
    expect(decidePlacement({}, worker(undefined, ''))).toMatchObject({ project: '', placeBesideCaller: true })
  })

  it('worker saying group_id "" gets its project and no folder, and none is made', () => {
    expect(decidePlacement({ group_id: '' }, worker())).toEqual({
      project: 'marina', group_id: undefined, placeBesideCaller: false, inheritedFrom: 't-caller', parentTaskId: 't-caller',
    })
  })

  it('worker naming a folder gets that folder, never a new one', () => {
    expect(decidePlacement({ group_id: 'g_other' }, worker('g_f'))).toEqual({
      project: 'marina', group_id: 'g_other', placeBesideCaller: false, inheritedFrom: 't-caller', parentTaskId: 't-caller',
    })
  })

  it('whatever a session files is its subtask, wherever it lands', () => {
    // Work an agent splits off stays attached to the work it came from (the
    // board shows a Sub pill): beside it, in another project, in the Inbox.
    expect(decidePlacement({}, worker()).parentTaskId).toBe('t-caller')
    expect(decidePlacement({ project: 'MARINA', group_id: 'g_x' }, worker('g_f')).parentTaskId).toBe('t-caller')
    expect(decidePlacement({}, worker(undefined, '')).parentTaskId).toBe('t-caller')
    expect(decidePlacement({ project: 'acme' }, worker('g_f')).parentTaskId).toBe('t-caller')
    expect(decidePlacement({ project: '' }, worker('g_f')).parentTaskId).toBe('t-caller')
    // Only a caller with no task of its own has nothing to be the parent.
    for (const c of others) expect(decidePlacement({}, c).parentTaskId).toBeUndefined()
  })
})

describe('inheritedTier (a worker\'s new task is born in its board tier)', () => {
  // User report 2026-09-25: a Focus task's subtask landed in Satellite.
  const at = (pinned: boolean | undefined, focus_tier?: string): CallerPlacement => ({
    kind: 'worker',
    task: { id: 't-caller', title: 'Refactor the fixture', project: 'marina', ...(pinned === undefined ? {} : { pinned }), ...(focus_tier ? { focus_tier } : {}) },
    session: SESSION,
  })

  it('takes the caller\'s tier: Focus, a custom tier, Satellite, or off the board', () => {
    expect(inheritedTier({}, at(true, 'focus'))).toEqual({ pinned: true, focus_tier: 'focus' })
    expect(inheritedTier({}, at(true, 'ct_launch'))).toEqual({ pinned: true, focus_tier: 'ct_launch' })
    expect(inheritedTier({}, at(true))).toEqual({ pinned: true })
    expect(inheritedTier({}, at(false))).toEqual({ pinned: false })
  })

  it('"" and null focus_tier mean not named, so the caller\'s tier still applies', () => {
    expect(inheritedTier({ focus_tier: '' }, at(true, 'wait'))).toEqual({ pinned: true, focus_tier: 'wait' })
    expect(inheritedTier({ focus_tier: '  ' }, at(true, 'wait'))).toEqual({ pinned: true, focus_tier: 'wait' })
    expect(inheritedTier({ focus_tier: null }, at(true, 'wait'))).toEqual({ pinned: true, focus_tier: 'wait' })
  })

  it('an explicit pinned or focus_tier wins: nothing is inherited', () => {
    expect(inheritedTier({ pinned: true }, at(true, 'focus'))).toBeUndefined()
    expect(inheritedTier({ pinned: false }, at(true, 'focus'))).toBeUndefined()
    expect(inheritedTier({ focus_tier: 'wait' }, at(true, 'focus'))).toBeUndefined()
  })

  it('only a worker: an ask (often parked in Wait), a human, or an unknown caller inherits nothing', () => {
    const ask: CallerPlacement = { kind: 'ask', task: { id: 't-ask', title: 'Ask', project: 'Ask Walnut', pinned: true, focus_tier: 'wait' }, session: SESSION }
    expect(inheritedTier({}, ask)).toBeUndefined()
    expect(inheritedTier({}, { kind: 'human' })).toBeUndefined()
    expect(inheritedTier({}, { kind: 'external' })).toBeUndefined()
    expect(inheritedTier({}, { kind: 'untracked', session: SESSION })).toBeUndefined()
    // A hand-built caller that never read the board says nothing either.
    expect(inheritedTier({}, at(undefined))).toBeUndefined()
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

  // ── Subtasks (nest: true): the folder tree follows the subtask tree ──

  /** The caller filed in a folder it shares with `others` unrelated tasks. */
  async function callerInSharedFolder(others = 1) {
    const { task: me } = await seedCaller()
    const neighbours = []
    for (let i = 0; i < others; i++) neighbours.push((await addTask({ title: `Neighbour ${i}`, project: 'marina' })).task)
    const shared = await createFolder('Shared', 'marina')
    const { addToGroup } = await import('../../../src/core/task-manager.js')
    await addToGroup(shared.group_id, [me.id, ...neighbours.map((t) => t.id)])
    return { me: { ...me, group_id: shared.group_id }, shared: shared.group_id, neighbours }
  }
  const subtaskOf = async (parentId: string, title: string) =>
    (await addTask({ title, project: 'marina', parent_task_id: parentId })).task

  it('a subtask from a caller in a shared folder gets a subfolder of it holding caller + subtask', async () => {
    const { me, shared, neighbours } = await callerInSharedFolder()
    const born = await subtaskOf(me.id, 'Write the migration')
    const r = await joinOrCreateSiblingFolder(me, born.id, { eventSource: 'test', nest: true })
    expect(r).toMatchObject({ created: true, parentId: shared, label: me.title })
    const sub = (await listGroups()).find((g) => g.group_id === r.groupId)
    expect(sub).toMatchObject({ parent_id: shared, project: 'marina' })
    expect(sub?.member_ids.sort()).toEqual([me.id, born.id].sort())
    // The neighbour stays where it was; only the caller moved in.
    expect((await getTask(neighbours[0].id)).group_id).toBe(shared)
    // Created, so the label is refined like any new folder.
    await vi.waitFor(async () => {
      expect((await listGroups()).find((g) => g.group_id === r.groupId)?.label).toBe('Refined Folder')
    })
  })

  it('the caller\'s earlier subtasks filed flat beside it move into the subfolder with it', async () => {
    // The shape older flat placement left behind: the caller, its children and
    // unrelated work, all in one folder.
    const { me, shared, neighbours } = await callerInSharedFolder()
    const earlier = await subtaskOf(me.id, 'Earlier child')
    const deeper = await subtaskOf(earlier.id, 'Earlier grandchild')
    const housed = await subtaskOf(me.id, 'Child with its own folder')
    const { addToGroup } = await import('../../../src/core/task-manager.js')
    await addToGroup(shared, [earlier.id, deeper.id])
    const own = await createFolder('Its own', 'marina', shared)
    await addToGroup(own.group_id, [housed.id])
    const born = await subtaskOf(me.id, 'New child')
    const r = await joinOrCreateSiblingFolder(me, born.id, { eventSource: 'test', nest: true })
    expect(r).toMatchObject({ created: true, parentId: shared })
    const sub = (await listGroups()).find((g) => g.group_id === r.groupId)
    expect(sub?.member_ids.sort()).toEqual([me.id, earlier.id, deeper.id, born.id].sort())
    // A child already in a folder of its own and the unrelated work stay put.
    expect((await getTask(housed.id)).group_id).toBe(own.group_id)
    expect((await getTask(neighbours[0].id)).group_id).toBe(shared)
  })

  it('the next subtask joins that subfolder: it now holds only the caller and its subtasks', async () => {
    const { me, shared } = await callerInSharedFolder()
    const first = await subtaskOf(me.id, 'First part')
    const r1 = await joinOrCreateSiblingFolder(me, first.id, { eventSource: 'test', nest: true })
    const second = await subtaskOf(me.id, 'Second part')
    const r2 = await joinOrCreateSiblingFolder({ ...me, group_id: r1.groupId }, second.id, { eventSource: 'test', nest: true })
    expect(r2).toMatchObject({ created: false, groupId: r1.groupId })
    expect((await listGroups()).filter((g) => g.parent_id === shared)).toHaveLength(1)
  })

  it('a folder holding only the caller and its own subtasks (any depth, subfolders too) is joined', async () => {
    const { task: me } = await seedCaller()
    const child = await subtaskOf(me.id, 'Child')
    const grandchild = await subtaskOf(child.id, 'Grandchild')
    const own = await createFolder('Mine', 'marina')
    const inner = await createFolder('Inner', 'marina', own.group_id)
    const { addToGroup } = await import('../../../src/core/task-manager.js')
    await addToGroup(own.group_id, [me.id, child.id])
    await addToGroup(inner.group_id, [grandchild.id])
    const born = await subtaskOf(me.id, 'Another child')
    const r = await joinOrCreateSiblingFolder({ ...me, group_id: own.group_id }, born.id, { eventSource: 'test', nest: true })
    expect(r).toMatchObject({ created: false, groupId: own.group_id })
    expect((await listGroups()).filter((g) => g.parent_id === own.group_id).map((g) => g.group_id)).toEqual([inner.group_id])
  })

  it('an unrelated task in a SUBFOLDER makes the folder shared', async () => {
    const { task: me } = await seedCaller()
    const { task: stranger } = await addTask({ title: 'Stranger', project: 'marina' })
    const own = await createFolder('Mine', 'marina')
    const inner = await createFolder('Inner', 'marina', own.group_id)
    const { addToGroup } = await import('../../../src/core/task-manager.js')
    await addToGroup(own.group_id, [me.id])
    await addToGroup(inner.group_id, [stranger.id])
    const born = await subtaskOf(me.id, 'Child')
    const r = await joinOrCreateSiblingFolder({ ...me, group_id: own.group_id }, born.id, { eventSource: 'test', nest: true })
    expect(r).toMatchObject({ created: true, parentId: own.group_id })
  })

  it('a subtask of a subtask nests one level deeper, so the folder tree follows the subtask tree', async () => {
    const { me, shared } = await callerInSharedFolder()
    const child = await subtaskOf(me.id, 'Child')
    const r1 = await joinOrCreateSiblingFolder(me, child.id, { eventSource: 'test', nest: true })
    // The child now works and files its own subtask: its folder holds its parent.
    const grandchild = await subtaskOf(child.id, 'Grandchild')
    const childTask = await getTask(child.id)
    const r2 = await joinOrCreateSiblingFolder(childTask, grandchild.id, { eventSource: 'test', nest: true })
    expect(r2).toMatchObject({ created: true, parentId: r1.groupId, label: 'Child' })
    const groups = await listGroups()
    expect(groups.find((g) => g.group_id === r1.groupId)?.parent_id).toBe(shared)
    expect(groups.find((g) => g.group_id === r2.groupId)?.member_ids.sort()).toEqual([child.id, grandchild.id].sort())
    expect((await getTask(me.id)).group_id).toBe(r1.groupId)
  })

  it('at the depth cap the subtask joins the shared folder as it is', async () => {
    const { task: me } = await seedCaller()
    const { task: stranger } = await addTask({ title: 'Stranger', project: 'marina' })
    let parentId: string | undefined
    for (let d = 1; d <= 5; d++) parentId = (await createFolder(`Level ${d}`, 'marina', parentId)).group_id
    const { addToGroup } = await import('../../../src/core/task-manager.js')
    await addToGroup(parentId!, [me.id, stranger.id])
    const born = await subtaskOf(me.id, 'Child')
    const r = await joinOrCreateSiblingFolder({ ...me, group_id: parentId }, born.id, { eventSource: 'test', nest: true })
    expect(r).toMatchObject({ created: false, groupId: parentId })
  })

  it('without nest (a fork) a shared folder is joined, never nested', async () => {
    const { me, shared } = await callerInSharedFolder()
    const { task: fork } = await addTask({ title: 'Fork of it', project: 'marina' })
    const r = await joinOrCreateSiblingFolder(me, fork.id, { eventSource: 'test' })
    expect(r).toMatchObject({ created: false, groupId: shared })
  })

  it('two subtasks at once from a caller in a shared folder end in ONE subfolder', async () => {
    const { me, shared } = await callerInSharedFolder()
    const a = await subtaskOf(me.id, 'First')
    const b = await subtaskOf(me.id, 'Second')
    const [ra, rb] = await Promise.all([
      joinOrCreateSiblingFolder(me, a.id, { eventSource: 'test', nest: true }),
      joinOrCreateSiblingFolder(me, b.id, { eventSource: 'test', nest: true }),
    ])
    expect([ra.created, rb.created].sort()).toEqual([false, true])
    expect(ra.groupId).toBe(rb.groupId)
    const subs = (await listGroups()).filter((g) => g.parent_id === shared)
    expect(subs).toHaveLength(1)
    expect(subs[0].member_ids.sort()).toEqual([me.id, a.id, b.id].sort())
  })

  it('a legacy id-prefix parent link still counts as the caller\'s own subtask', async () => {
    const { task: me } = await seedCaller()
    const { task: old } = await addTask({ title: 'Old child', project: 'marina' })
    const { updateTaskRaw, addToGroup } = await import('../../../src/core/task-manager.js')
    await updateTaskRaw(old.id, { parent_task_id: me.id.slice(0, -2) })
    const own = await createFolder('Mine', 'marina')
    await addToGroup(own.group_id, [me.id, old.id])
    const born = await subtaskOf(me.id, 'New child')
    const r = await joinOrCreateSiblingFolder({ ...me, group_id: own.group_id }, born.id, { eventSource: 'test', nest: true })
    expect(r).toMatchObject({ created: false, groupId: own.group_id })
  })
})
