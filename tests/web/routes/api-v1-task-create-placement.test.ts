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
import { addTask, getTask, createFolder, addToGroup, updateTaskRaw, listGroups } from '../../../src/core/task-manager.js'
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
  const { task } = await addTask({
    title: `Caller ${seq}`, project, ...(opts.walnutAgent ? { walnut_agent: true } : {}),
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

  it('a Personal AI ask never files the user\'s work under its Ask project', async () => {
    const { sid } = await seedCaller('Ask Walnut', { walnutAgent: true })
    const { json } = await post({ title: 'Track the dentist call' }, sid)
    expect(json.task.project).not.toBe('Ask Walnut')
    expect(json.placement.inherited_from).toBeUndefined()
    expect(json.placement.group_id).toBeUndefined()
    expect((await getTask(json.task.id)).parent_task_id).toBeUndefined()
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

  it('naming another project: that project, and the folder does not follow', async () => {
    const folder = await createFolder('Stays', 'marina')
    const { sid } = await seedCaller('marina', { folder: folder.group_id })
    const { json } = await post({ title: 'Release notes', project: 'acme' }, sid)
    expect(json.task.project).toBe('acme')
    expect(json.placement).toEqual({ project: 'acme', folder_created: false })
    const born = await getTask(json.task.id)
    expect(born.cwd).toBeUndefined()
    // Work filed into another project is independent, not a subtask.
    expect(born.parent_task_id).toBeUndefined()
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

  it('a task in an Ask project without the flag is still an ask: nothing filed into it', async () => {
    const { sid } = await seedCaller('Ask Mentor')
    const { json } = await post({ title: 'Not a mentor chat' }, sid)
    expect(json.task.project).not.toBe('Ask Mentor')
    expect(json.placement.inherited_from).toBeUndefined()
  })

  it('a folder the caller had that no longer exists never fails the create', async () => {
    const { task: caller, sid } = await seedCaller('marina')
    // A stale membership (the folder row is gone): the inherited folder is refused
    // by the store, and the create must still land, in the project, with a warning.
    await updateTaskRaw(caller.id, { group_id: 'g_ghost' })
    const { status, json } = await post({ title: 'Still created' }, sid)
    expect(status).toBe(201)
    expect(json.task.project).toBe('marina')
    expect(json.placement.group_id).toBeUndefined()
    expect(json.placement.warning).toMatch(/could not be put in a folder/)
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
      task: { id: worker.task.id, title: worker.task.title, project: 'marina', group_id: folder.group_id, group_label: 'Where I am' },
      session: { id: worker.sid, host: '', cwd: '/repo/here' },
    })
  })
})
