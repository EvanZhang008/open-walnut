/**
 * Work created FROM INSIDE a task lands beside it (POST /api/v1/tasks +
 * GET /api/v1/me + the task_create / task_list ops over the daemon gateway).
 *
 * Real startServer({ port: 0, dev: true }) with an isolated home; the caller is a
 * real session record whose task sits in a real project and folder. The only fake
 * is the background folder-label refine (a model call).
 *
 * The contract pinned here:
 *   - a caller that is not a worker session (the phone, the web UI, the Personal
 *     AI's asks, an unknown id) keeps the old defaults, byte for byte;
 *   - a worker's task_create lands in its project and folder, and a caller in no
 *     folder gets ONE new folder holding both tasks, announced on the bus;
 *   - an explicit project or folder always wins, and a folder never follows work
 *     into another project;
 *   - a folder the caller had but that vanished never fails the create.
 * The ops half (task_create's outcome, task_list's default ring) is pinned over
 * the daemon gateway in api-v1-task-create-placement-gateway.test.ts.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-apiv1-taskcreate-placement'))
vi.mock('../../../src/core/fork-title.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/core/fork-title.js')>()),
  summarizeGroupLabel: vi.fn(async () => 'Refined Folder'),
}))

// Lets a test rewrite the resolved caller, to stage the caller's task vanishing
// between resolution and the write (a race no real request can pin in time).
type Placement = import('../../../src/core/sessions/caller-placement.js').CallerPlacement
let rewriteCaller: ((c: Placement) => Placement) | undefined
vi.mock('../../../src/core/sessions/caller-placement.js', async (orig) => {
  const real = await orig<typeof import('../../../src/core/sessions/caller-placement.js')>()
  return {
    ...real,
    resolveCallerPlacement: vi.fn(async (sid: string | undefined) => {
      const c = await real.resolveCallerPlacement(sid)
      return rewriteCaller ? rewriteCaller(c) : c
    }),
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { addTask, getTask, createFolder, addToGroup, updateTaskRaw, listGroups, setFocusTier, createCustomTier, deleteCustomTier } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

let server: HttpServer
let port: number

const api = (p: string): string => `http://localhost:${port}${p}`

async function post(body: unknown, sid?: string): Promise<{ status: number; json: Record<string, any> }> {
  const res = await fetch(api('/api/v1/tasks'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(sid ? { 'x-walnut-caller-sid': sid } : {}) },
    body: JSON.stringify(body),
  })
  return { status: res.status, json: await res.json() as Record<string, any> }
}

async function me(sid?: string): Promise<Record<string, any>> {
  const res = await fetch(api('/api/v1/me'), { headers: sid ? { 'x-walnut-caller-sid': sid } : {} })
  expect(res.status).toBe(200)
  return await res.json() as Record<string, any>
}

let seq = 0
/** A worker: a task in `project` (optionally in a folder) with a live session record. */
async function seedCaller(project: string, opts: { folder?: string; walnutAgent?: boolean; cwd?: string } = {}) {
  seq += 1
  // Pinned, as every task created from the UI or the API is (newTaskPinDefault):
  // the caller's board tier is part of where its work lands.
  const { task } = await addTask({
    title: `Caller ${seq}`, project, pinned: true, ...(opts.walnutAgent ? { walnut_agent: true } : {}),
  })
  if (opts.folder) await addToGroup(opts.folder, [task.id])
  const sid = `11111111-2222-3333-4444-${String(seq).padStart(12, '0')}`
  await createSessionRecord(sid, task.id, project, opts.cwd ?? `/repo/${project || 'inbox'}`, { title: task.title })
  return { task: await getTask(task.id), sid }
}

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('callers that are not workers keep the old defaults', () => {
  it('no caller header (the phone, the web UI): Inbox, no folder, no cwd, not a subtask', async () => {
    const { status, json } = await post({ title: 'Buy oat milk' })
    expect(status).toBe(201)
    expect(['', 'Inbox']).toContain(json.task.project)
    expect(json.placement).toEqual({ project: json.task.project, folder_created: false })
    expect((await getTask(json.task.id)).group_id).toBeUndefined()
    expect((await getTask(json.task.id)).parent_task_id).toBeUndefined()
  })

  it('an unknown session id is an external caller: nothing inherited', async () => {
    const { json } = await post({ title: 'From a stranger' }, 'not-a-session')
    expect(json.placement.inherited_from).toBeUndefined()
    expect(['', 'Inbox']).toContain(json.task.project)
  })

  it('a Personal AI ask never files the user\'s work under its Ask project, but the work is its subtask', async () => {
    const { task: ask, sid } = await seedCaller('Ask Walnut', { walnutAgent: true })
    const { json } = await post({ title: 'Track the dentist call' }, sid)
    // The project default a parentless create gets, never the ask's own project
    // (which addTask would otherwise inherit through the parent).
    expect(['', 'Inbox']).toContain(json.task.project)
    expect(json.placement.inherited_from).toBeUndefined()
    expect(json.placement.group_id).toBeUndefined()
    expect(json.placement.parent_task_id).toBe(ask.id)
    expect((await getTask(json.task.id)).parent_task_id).toBe(ask.id)
    // Naming a project: that project, and still this conversation's subtask.
    const named = await post({ title: 'Rotate the token', project: 'acme' }, sid)
    expect(named.json.task.project).toBe('acme')
    // It also lists the ask's other open subtask: the dentist call.
    expect(named.json.placement).toEqual({
      project: 'acme', folder_created: false, parent_task_id: ask.id,
      open_subtasks: [{ id: json.task.id, title: 'Track the dentist call', phase: 'TODO' }],
    })
    expect((await getTask(named.json.task.id)).parent_task_id).toBe(ask.id)
  })
})

describe('a worker caller', () => {
  it('in no folder: same project, one NEW folder holding both tasks, announced', async () => {
    const { task: caller, sid } = await seedCaller('marina')
    const created: Array<Record<string, any>> = []
    const groups: Array<Record<string, any>> = []
    bus.subscribe('test-created', (e) => { if (e.name === EventNames.TASK_CREATED) created.push(e.data as Record<string, any>) }, { global: true })
    bus.subscribe('test-groups', (e) => { if (e.name === EventNames.TASK_GROUPS_CHANGED) groups.push(e.data as Record<string, any>) }, { global: true })
    try {
      const { status, json } = await post({ title: 'Fix the flake' }, sid)
      expect(status).toBe(201)
      expect(json.task.project).toBe('marina')
      const gid = json.placement.group_id as string
      expect(gid).toMatch(/^g_/)
      expect(json.placement).toMatchObject({
        project: 'marina', folder_created: true, inherited_from: caller.id, group_label: caller.title, cwd: '/repo/marina',
      })
      expect((await getTask(caller.id)).group_id).toBe(gid)
      const born = await getTask(json.task.id)
      expect(born.group_id).toBe(gid)
      expect(born.cwd).toBe('/repo/marina')
      // And it is the caller's SUBTASK: the board draws a Sub pill from this.
      expect(born.parent_task_id).toBe(caller.id)
      expect(json.placement.parent_task_id).toBe(caller.id)
      // The board learns about the folder AND the create carries it.
      await vi.waitFor(() => expect(created.find((d) => d.task?.id === json.task.id)?.task?.group_id).toBe(gid))
      expect(groups.some((g) => g.group_id === gid)).toBe(true)
      await vi.waitFor(async () => {
        expect((await listGroups()).find((g) => g.group_id === gid)?.label).toBe('Refined Folder')
      })
    } finally {
      bus.unsubscribe('test-created')
      bus.unsubscribe('test-groups')
    }
  })

  it('in a (nested) folder: joins that same folder, never makes another', async () => {
    const parent = await createFolder('Nav V2', 'marina')
    const child = await createFolder('Rail Top', 'marina', parent.group_id)
    const { task: caller, sid } = await seedCaller('marina', { folder: child.group_id })
    const before = (await listGroups()).length
    const { json } = await post({ title: 'Rail spacing', priority: 'important' }, sid)
    expect((await getTask(json.task.id)).parent_task_id).toBe(caller.id)
    expect(json.placement).toMatchObject({
      project: 'marina', group_id: child.group_id, group_label: 'Rail Top', folder_created: false, inherited_from: caller.id,
    })
    expect((await getTask(json.task.id)).group_id).toBe(child.group_id)
    expect((await listGroups()).length).toBe(before)
  })

  it('naming its own project in another case still lands beside it', async () => {
    const folder = await createFolder('Case', 'marina')
    const { sid } = await seedCaller('marina', { folder: folder.group_id })
    const { json } = await post({ title: 'Same place', project: 'MARINA' }, sid)
    expect(json.placement.group_id).toBe(folder.group_id)
  })

  it('naming another project: that project, the folder does not follow, the parent link does', async () => {
    const folder = await createFolder('Stays', 'marina')
    const { task: caller, sid } = await seedCaller('marina', { folder: folder.group_id })
    const { json } = await post({ title: 'Release notes', project: 'acme' }, sid)
    expect(json.task.project).toBe('acme')
    expect(json.placement).toEqual({ project: 'acme', folder_created: false, parent_task_id: caller.id, tier: 'satellite' })
    const born = await getTask(json.task.id)
    expect(born.cwd).toBeUndefined()
    expect(born.group_id).toBeUndefined()
    // Work filed into another project is still this task's subtask.
    expect(born.parent_task_id).toBe(caller.id)
  })

  it('naming the Inbox on purpose: Inbox, no folder', async () => {
    const { sid } = await seedCaller('marina')
    const { json } = await post({ title: 'Personal errand', project: '' }, sid)
    expect(['', 'Inbox']).toContain(json.task.project)
    expect(json.placement.group_id).toBeUndefined()
  })

  it('group_id "" keeps it out of any folder and makes none', async () => {
    const { task: caller, sid } = await seedCaller('marina')
    const before = (await listGroups()).length
    const { json } = await post({ title: 'Loose', group_id: '' }, sid)
    expect(json.task.project).toBe('marina')
    expect(json.placement).toMatchObject({ folder_created: false, inherited_from: caller.id })
    expect(json.placement.group_id).toBeUndefined()
    expect((await getTask(caller.id)).group_id).toBeUndefined()
    expect((await listGroups()).length).toBe(before)
  })

  it('an explicit folder of the project wins over the caller\'s own', async () => {
    const mine = await createFolder('Mine', 'marina')
    const other = await createFolder('Other', 'marina')
    const { sid } = await seedCaller('marina', { folder: mine.group_id })
    const { json } = await post({ title: 'Goes to other', group_id: other.group_id }, sid)
    expect(json.placement).toMatchObject({ group_id: other.group_id, group_label: 'Other' })
  })

  it('refuses a malformed folder id, an unknown folder, and another project\'s folder', async () => {
    const { sid } = await seedCaller('marina')
    const acme = await createFolder('Acme only', 'acme')
    expect((await post({ title: 'x', group_id: 'no spaces allowed' }, sid)).status).toBe(400)
    expect((await post({ title: 'x', group_id: 42 }, sid)).status).toBe(400)
    const unknown = await post({ title: 'x', group_id: 'g_nope' }, sid)
    expect(unknown.status).toBe(400)
    expect(unknown.json.error.message).toMatch(/Folder "g_nope" not found/)
    const cross = await post({ title: 'x', group_id: acme.group_id }, sid)
    expect(cross.status).toBe(400)
    expect(cross.json.error.message).toMatch(/belongs to "acme"/)
  })

  it('records a cwd only for the machine a later start would use (the pair never splits)', async () => {
    const { sid } = await seedCaller('pairing', { cwd: '/repo/pairing' })
    // task_create {host:"devbox"}: the first start runs on devbox, so the LOCAL
    // caller cwd must not be recorded (a board restart would pair it with devbox).
    const remote = await post({ title: 'On devbox', launch_host: 'devbox' }, sid)
    expect(remote.status).toBe(201)
    expect((await getTask(remote.json.task.id)).cwd).toBeUndefined()
    expect(remote.json.placement.cwd).toBeUndefined()
    // task_create {cwd:"/explicit"}: that cwd is what a retry must reuse.
    const explicit = await post({ title: 'Explicit dir', launch_cwd: '/explicit/dir' }, sid)
    expect((await getTask(explicit.json.task.id)).cwd).toBe('/explicit/dir')
    // Neither: the caller's own cwd.
    const beside = await post({ title: 'Beside me' }, sid)
    expect((await getTask(beside.json.task.id)).cwd).toBe('/repo/pairing')
    // Hints are validated, and a non-worker never records one.
    expect((await post({ title: 'x', launch_cwd: 'relative/dir' }, sid)).status).toBe(400)
    expect((await post({ title: 'x', launch_host: 7 }, sid)).status).toBe(400)
    const human = await post({ title: 'From the phone', launch_cwd: '/explicit/dir' })
    expect((await getTask(human.json.task.id)).cwd).toBeUndefined()
  })

  it('a task in an Ask project without the flag is still an ask: nothing filed into it, subtask all the same', async () => {
    const { task: ask, sid } = await seedCaller('Ask Mentor')
    const { json } = await post({ title: 'Not a mentor chat' }, sid)
    expect(json.task.project).not.toBe('Ask Mentor')
    expect(json.placement.inherited_from).toBeUndefined()
    expect(json.placement.parent_task_id).toBe(ask.id)
  })

  it('a folder the caller had that no longer exists never fails the create', async () => {
    const { task: caller, sid } = await seedCaller('marina')
    // A stale membership (the folder row is gone) counts as no folder: the create
    // lands in the project, in a fresh folder beside the caller, with no warning.
    await updateTaskRaw(caller.id, { group_id: 'g_ghost' })
    const { status, json } = await post({ title: 'Still created' }, sid)
    expect(status).toBe(201)
    expect(json.task.project).toBe('marina')
    expect(json.placement).toMatchObject({ folder_created: true })
    expect(json.placement.group_id).not.toBe('g_ghost')
    expect(json.placement.warning).toBeUndefined()
    expect((await getTask(caller.id)).group_id).toBe(json.placement.group_id)
  })

  it('in a folder shared with other work: a SUBFOLDER of it holding the caller and the new task', async () => {
    const shared = await createFolder('Pipeline', 'marina')
    const { task: caller, sid } = await seedCaller('marina', { folder: shared.group_id })
    const { task: neighbour } = await addTask({ title: 'Unrelated work', project: 'marina' })
    await addToGroup(shared.group_id, [neighbour.id])
    const groups: Array<Record<string, any>> = []
    bus.subscribe('test-nest-groups', (e) => { if (e.name === EventNames.TASK_GROUPS_CHANGED) groups.push(e.data as Record<string, any>) }, { global: true })
    try {
      const first = await post({ title: 'First part' }, sid)
      expect(first.status).toBe(201)
      const sub = first.json.placement.group_id as string
      expect(sub).toMatch(/^g_/)
      expect(sub).not.toBe(shared.group_id)
      expect(first.json.placement).toMatchObject({ folder_created: true, group_label: caller.title, parent_task_id: caller.id })
      const listed = (await listGroups()).find((g) => g.group_id === sub)
      expect(listed).toMatchObject({ parent_id: shared.group_id, project: 'marina' })
      expect(listed?.member_ids.sort()).toEqual([caller.id, first.json.task.id].sort())
      // The caller moved in; the unrelated task stayed; the board is told the parent.
      expect((await getTask(neighbour.id)).group_id).toBe(shared.group_id)
      expect(groups.find((g) => g.group_id === sub)).toMatchObject({ parent_id: shared.group_id })
      // The caller's next subtask joins the subfolder, which is now its own.
      const second = await post({ title: 'Second part' }, sid)
      expect(second.json.placement).toMatchObject({ group_id: sub, folder_created: false })
      expect((await listGroups()).filter((g) => g.parent_id === shared.group_id)).toHaveLength(1)
    } finally {
      bus.unsubscribe('test-nest-groups')
    }
  })

  it('a caller task deleted mid-create: the work is still filed, just not as its subtask', async () => {
    const { sid } = await seedCaller('marina')
    const vanish = (extra: Record<string, string>) => (c: Placement) =>
      c.kind === 'worker' ? { ...c, task: { ...c.task, id: 'mdeadbee-0000', ...extra } } : c
    try {
      rewriteCaller = vanish({})
      const lone = await post({ title: 'Parent gone' }, sid)
      expect(lone.status).toBe(201)
      expect(lone.json.task.project).toBe('marina')
      expect(lone.json.task.parent_task_id).toBeUndefined()
      expect(lone.json.placement.parent_task_id).toBeUndefined()
      expect(lone.json.placement.warning).toMatch(/not as a subtask: Parent task not found/)

      // Deleting the caller can take its folder too: both fallbacks must hold.
      rewriteCaller = vanish({ group_id: 'g_ghost' })
      const both = await post({ title: 'Parent and folder gone' }, sid)
      expect(both.status).toBe(201)
      expect(both.json.task.parent_task_id).toBeUndefined()
      expect(both.json.task.group_id).toBeFalsy()
      expect(both.json.placement.warning).toMatch(/could not be put in a folder/)
      expect(both.json.placement.warning).toMatch(/not as a subtask/)
    } finally {
      rewriteCaller = undefined
    }
  })

  it('an Inbox worker gets an Inbox folder beside it', async () => {
    const { task: caller, sid } = await seedCaller('')
    const { json } = await post({ title: 'Inbox sibling' }, sid)
    expect(['', 'Inbox']).toContain(json.task.project)
    expect(json.placement.folder_created).toBe(true)
    expect((await getTask(caller.id)).group_id).toBe(json.placement.group_id)
  })
})

describe('the board tier: a worker\'s new task is born where the caller sits', () => {
  // User report 2026-09-25: the caller was in Focus, its subtask landed in Satellite.
  it('a Focus caller: the new task is in Focus, in its project and in another one', async () => {
    const { task, sid } = await seedCaller('marina')
    await setFocusTier(task.id, 'focus')
    const here = await post({ title: 'Split off Focus work' }, sid)
    expect(here.status).toBe(201)
    expect(here.json.placement.tier).toBe('focus')
    const stored = await getTask(here.json.task.id)
    expect(stored.pinned).toBe(true)
    expect(stored.focus_tier).toBe('focus')
    // A tier is board-wide: it follows the work into another project.
    const there = await post({ title: 'Focus work elsewhere', project: 'lighthouse' }, sid)
    expect((await getTask(there.json.task.id)).focus_tier).toBe('focus')
  })

  it('a Satellite caller stays Satellite; an unpinned caller\'s task is off the board too', async () => {
    const sat = await seedCaller('marina')
    const a = await post({ title: 'From Satellite' }, sat.sid)
    expect(a.json.placement.tier).toBe('satellite')
    const stored = await getTask(a.json.task.id)
    expect(stored.pinned).toBe(true)
    expect(stored.focus_tier).toBeUndefined()
    const off = await seedCaller('marina')
    await updateTaskRaw(off.task.id, { pinned: false })
    const b = await post({ title: 'From the backlog' }, off.sid)
    expect(b.json.placement.tier).toBe('unpinned')
    expect(Boolean((await getTask(b.json.task.id)).pinned)).toBe(false)
  })

  it('an explicit focus_tier or pinned wins over the caller\'s tier', async () => {
    const { task, sid } = await seedCaller('marina')
    await setFocusTier(task.id, 'focus')
    const b = await post({ title: 'Parked on purpose', focus_tier: 'wait' }, sid)
    expect((await getTask(b.json.task.id)).focus_tier).toBe('wait')
    expect(b.json.placement.tier).toBeUndefined()
    const off = await post({ title: 'Off the board on purpose', pinned: false }, sid)
    expect(Boolean((await getTask(off.json.task.id)).pinned)).toBe(false)
  })

  it('a custom tier deleted since the caller was read: created in Satellite with a warning, never a 400', async () => {
    const { task, sid } = await seedCaller('marina')
    const { tier } = await createCustomTier('Launch week')
    await setFocusTier(task.id, tier.id)
    // The caller was resolved while its tier existed; the tier is gone by the write.
    rewriteCaller = (c) => c
    const { resolveCallerPlacement } = await import('../../../src/core/sessions/caller-placement.js')
    const read = await resolveCallerPlacement(sid)
    await deleteCustomTier(tier.id)
    rewriteCaller = () => read
    try {
      const r = await post({ title: 'Born in a tier that vanished' }, sid)
      expect(r.status).toBe(201)
      expect(r.json.placement.warning).toMatch(/created in Satellite, not your tier/)
      expect(r.json.placement.tier).toBeUndefined()
      const stored = await getTask(r.json.task.id)
      expect(stored.pinned).toBe(true)
      expect(stored.focus_tier).toBeUndefined()
    } finally {
      rewriteCaller = undefined
    }
  })

  it('an ask never passes on its tier (asks are often parked in Wait)', async () => {
    const ask = await seedCaller('Ask Walnut', { walnutAgent: true })
    await setFocusTier(ask.task.id, 'wait')
    const r = await post({ title: 'Work asked for in a parked chat', project: 'marina' }, ask.sid)
    expect(r.status).toBe(201)
    expect(r.json.placement.tier).toBeUndefined()
    expect((await getTask(r.json.task.id)).focus_tier).toBeUndefined()
  })

  it('no caller (the phone, the web UI): Satellite as before', async () => {
    const r = await post({ title: 'Quick add from the phone' })
    const stored = await getTask(r.json.task.id)
    expect(stored.pinned).toBe(true)
    expect(stored.focus_tier).toBeUndefined()
    expect(r.json.placement.tier).toBeUndefined()
  })
})

describe('the team a session already leads (placement.open_subtasks)', () => {
  // 2026-10-01: a leader filed a fourth task for its third one's follow-up, in
  // the second one's area. Every create from a session names the caller's other
  // open subtasks, so the owner of an area is in view at the next create.
  it('the first create lists none; later creates list the open ones, newest first, never the new task', async () => {
    const { sid } = await seedCaller('bakery')
    const first = await post({ title: 'Bake the tasting box' }, sid)
    expect(first.json.placement.open_subtasks).toBeUndefined()
    const second = await post({ title: 'Print the flyers', project: 'flyers' }, sid)
    expect(second.json.placement.open_subtasks).toEqual([{ id: first.json.task.id, title: 'Bake the tasting box', phase: 'TODO' }])
    expect(second.json.placement.more_open_subtasks).toBeUndefined()
    const third = await post({ title: 'Book the market stall' }, sid)
    expect(third.json.placement.open_subtasks.map((t: { id: string }) => t.id))
      .toEqual(expect.arrayContaining([first.json.task.id, second.json.task.id]))
    expect(third.json.placement.open_subtasks).toHaveLength(2)
  })

  it('a finished subtask is not listed', async () => {
    const { sid } = await seedCaller('bakery')
    const done = await post({ title: 'Order the oven part' }, sid)
    const open = await post({ title: 'Fix the oven door' }, sid)
    await updateTaskRaw(done.json.task.id, { phase: 'COMPLETE' })
    const next = await post({ title: 'Clean the oven' }, sid)
    expect(next.json.placement.open_subtasks).toEqual([{ id: open.json.task.id, title: 'Fix the oven door', phase: 'TODO' }])
  })

  it('lists at most 10 and counts the rest', async () => {
    const { sid } = await seedCaller('bakery')
    for (let i = 0; i < 12; i += 1) await post({ title: `Shelf ${i}` }, sid)
    const last = await post({ title: 'Shelf labels' }, sid)
    expect(last.json.placement.open_subtasks).toHaveLength(10)
    expect(last.json.placement.more_open_subtasks).toBe(2)
  })

  it('no caller (the phone, the web UI): no list, even for a task that has subtasks', async () => {
    const { task: caller, sid } = await seedCaller('bakery')
    await post({ title: 'Sweep the floor' }, sid)
    const human = await post({ title: 'Buy flour' })
    expect(human.json.placement.open_subtasks).toBeUndefined()
    // A human filing a subtask by hand names the parent; no team list either.
    const byHand = await post({ title: 'Mop the floor', parent_task_id: caller.id })
    expect(byHand.json.placement.open_subtasks).toBeUndefined()
  })
})

describe('GET /api/v1/me', () => {
  it('answers human, external, ask and worker callers', async () => {
    expect(await me()).toEqual({ kind: 'human' })
    expect(await me('not-a-session')).toEqual({ kind: 'external' })
    const ask = await seedCaller('Ask Walnut', { walnutAgent: true })
    expect((await me(ask.sid)).kind).toBe('ask')
    const folder = await createFolder('Where I am', 'marina')
    const worker = await seedCaller('marina', { folder: folder.group_id, cwd: '/repo/here' })
    expect(await me(worker.sid)).toEqual({
      kind: 'worker',
      task: { id: worker.task.id, title: worker.task.title, project: 'marina', group_id: folder.group_id, group_label: 'Where I am', pinned: true },
      session: { id: worker.sid, host: '', cwd: '/repo/here' },
    })
  })
})
