/**
 * A task made on a host while the Mac was away lands, once drained, exactly where the
 * same caller's create lands online (POST /api/v1/tasks; apply-v2.ts createTask with
 * journal-actor.ts createCaller), against the real task store, session tracker and the
 * real route of a dev server in this process:
 *   - a session's create: its caller's subtask, in its caller's project, beside it in its
 *     folder (a subfolder when that folder holds other work), on its caller's tier, with
 *     the folder its caller works in;
 *   - a plugin job's create: an outside caller's (no parent, pinned by default), and for a
 *     plugin that keeps its tasks to its own view, kept there (`plugin_only`) as online;
 *   - a parent the record names: honoured for a paired device as before; for a session's and a
 *     plugin job's create ignored, as the online create routes read none from the body;
 *   - the session a lead's away start ran on the host (`run: 'task'`): adopted as its task's
 *     own for a task that host's journal made, refused for a task the Mac made (why the
 *     replica starts only the first kind alone: away-starts.ts `task_made_on_mac`).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import type { Server as HttpServer } from 'node:http'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-drain-create-placement'))
vi.mock('../../../src/core/sessions/session-send-core.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/core/sessions/session-send-core.js')>()),
  deliverToSession: vi.fn(async () => ({ delivery: 'queued' })),
}))

import { WALNUT_HOME } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { runOfflineHandover, _resetOfflineHandoverForTesting, _setHandoverBackoffForTesting } from '../../../src/core/offline-handover.js'
import { addTask, createFolder, getTask, type Task } from '../../../src/core/task-manager.js'
import { createSessionRecord, getSessionByClaudeId } from '../../../src/core/session-tracker.js'
import { _resetHostClocksForTesting } from '../../../src/core/offline-merge/host-clock.js'
import { registerPluginKeepsTasks } from '../../../src/core/plugins/plugin-task-visibility.js'

const HOST = 'devbox'
let server: HttpServer
let port = 0
let seqN = 9000
let n = 0
const minted = (): string => `mtaskplace${(++n).toString(16).padStart(11, '0')}`

/** A host journal holding `records` until each is acked. */
function journal(records: Array<Record<string, unknown>>) {
  const pending = [...records]
  return {
    pending,
    conn: {
      hostKey: HOST, journalV2: true,
      send: async (cmd: string, p?: Record<string, unknown>) => {
        if (cmd === 'offline.drain') return { ok: true, records: pending.slice(), now: Date.now() }
        if (cmd === 'offline.ack') for (const s of (p?.seqs as number[]) ?? []) { const i = pending.findIndex((r) => r.seq === s); if (i !== -1) pending.splice(i, 1) }
        return { ok: true }
      },
      rescue: async () => {},
    },
  }
}

/** The create a host's replica journals for `actor` (write-port.ts taskCreate: the placement keys apart). */
const createRec = (taskId: string, actor: Record<string, unknown>, fields: Record<string, unknown>, placement: Record<string, unknown> = {}) => ({
  v: 2, seq: ++seqN, at: Date.now() - 60_000, kind: 'task-create', opId: `op-place-${seqN}`, rev: 1, actor, op: 'task_create', taskId, fields, placement,
})

/** The same caller's create online. */
async function direct(body: Record<string, unknown>, headers: Record<string, string>): Promise<Task> {
  const res = await fetch(`http://127.0.0.1:${port}/api/v1/tasks`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ confirm_new: true, new_reason: 'a separate deliverable', ...body }),
  })
  const text = await res.text()
  expect(res.status, text).toBe(201)
  return getTask((JSON.parse(text) as { task: { id: string } }).task.id)
}

async function drained(actor: Record<string, unknown>, fields: Record<string, unknown>, placement: Record<string, unknown> = {}): Promise<Task> {
  const id = minted()
  const j = journal([createRec(id, actor, fields, placement)])
  await runOfflineHandover(j.conn as never)
  expect(j.pending).toHaveLength(0)
  return getTask(id)
}

/** Where a task stands: what "lands where a direct create lands" compares. */
const whereOf = (t: Task) => ({
  parent_task_id: t.parent_task_id ?? '', project: t.project ?? '', group_id: t.group_id ?? '',
  pinned: !!t.pinned, focus_tier: t.focus_tier ?? '', plugin_only: t.plugin_only ?? '', cwd: t.cwd ?? '',
})

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
}, 60_000)

afterAll(async () => {
  _setHandoverBackoffForTesting(null)
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  _resetOfflineHandoverForTesting()
  _resetHostClocksForTesting()
  _setHandoverBackoffForTesting([1, 1])
})

describe('a task made away lands where the same caller\'s create lands online', () => {
  it('a session\'s: its caller\'s subtask, project, folder (nested beside other work) and tier', async () => {
    const folder = await createFolder('Venue work', 'Acme')
    const lead = (await addTask({ title: 'Venue lead', project: 'Acme', group_id: folder.group_id, pinned: true, focus_tier: 'focus' })).task
    await addTask({ title: 'Other venue work', project: 'Acme', group_id: folder.group_id })
    const sid = '44444444-5555-4666-8777-000000000001'
    await createSessionRecord(sid, lead.id, 'Acme', '/repo/acme', { title: 'Venue lead' })
    const online = await direct({ title: 'Book the hall' }, { 'x-walnut-caller-sid': sid })
    const away = await drained({ kind: 'session', sid }, { title: 'Book the stage' })
    expect(online.parent_task_id).toBe(lead.id)
    expect(whereOf(away)).toEqual(whereOf(online))
    // Named project (the caller's own): the same again.
    const online2 = await direct({ title: 'Print the badges', project: 'Acme' }, { 'x-walnut-caller-sid': sid })
    const away2 = await drained({ kind: 'session', sid }, { title: 'Print the menus' }, { project: 'Acme' })
    expect(whereOf(away2)).toEqual(whereOf(online2))
  })

  it('a session\'s create the host placed by the caller rule (project, parent, tier, pin in the record): where online puts it, once', async () => {
    // replica/away-create-placement.ts journals what the caller rule decided on the host's copy;
    // the drain derives the same again, and files it beside the caller in its folder itself.
    const folder = await createFolder('Badge work', 'Acme')
    const lead = (await addTask({ title: 'Badge lead', project: 'Acme', group_id: folder.group_id, pinned: true, focus_tier: 'focus' })).task
    await addTask({ title: 'Other badge work', project: 'Acme', group_id: folder.group_id })
    const sid = '44444444-5555-4666-8777-000000000004'
    await createSessionRecord(sid, lead.id, 'Acme', '/repo/acme', { title: 'Badge lead' })
    const online = await direct({ title: 'Print the lanyards' }, { 'x-walnut-caller-sid': sid })
    const away = await drained({ kind: 'session', sid }, { title: 'Print the stickers', pinned: true }, { project: 'Acme', parentTaskId: lead.id, tier: 'focus' })
    expect(online.parent_task_id).toBe(lead.id)
    expect(whereOf(away)).toEqual(whereOf(online))
    // A custom tier the caller had, deleted before the drain: Satellite, as an inherited one (never refused).
    const gone = await drained({ kind: 'session', sid }, { title: 'Print the menus', pinned: true }, { project: 'Acme', parentTaskId: lead.id, tier: 'ct_deleted_tier' })
    expect(gone).toMatchObject({ project: 'Acme', parent_task_id: lead.id, pinned: true })
    expect(gone.focus_tier ?? '').not.toBe('ct_deleted_tier')
  })

  it('a plugin job\'s: an outside caller\'s create; a plugin that keeps its tasks keeps it to its own view', async () => {
    const online = await direct({ title: 'Imported row one', project: 'Marina' }, { 'x-walnut-caller-sid': 'external', 'x-walnut-plugin-id': 'acme-sync' })
    const away = await drained({ kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' }, { title: 'Imported row two' }, { project: 'Marina' })
    expect(away.parent_task_id ?? '').toBe('')
    expect(whereOf(away)).toEqual(whereOf(online))
    const release = registerPluginKeepsTasks('acme-tracker')
    try {
      const keptOnline = await direct({ title: 'Tracked one', project: 'Marina' }, { 'x-walnut-caller-sid': 'external', 'x-walnut-plugin-id': 'acme-tracker' })
      const keptAway = await drained({ kind: 'plugin-job', plugin: 'acme-tracker', job: 'poll' }, { title: 'Tracked two' }, { project: 'Marina' })
      expect(keptOnline.plugin_only).toBe('acme-tracker')
      expect(whereOf(keptAway)).toEqual(whereOf(keptOnline))
    } finally {
      release()
    }
  })

  it('a named parent: a paired device\'s is honoured; a session\'s and a plugin job\'s is not, as online', async () => {
    const lead = (await addTask({ title: 'Catering lead', project: 'Acme' })).task
    const elsewhere = (await addTask({ title: 'Unrelated work', project: 'Acme' })).task
    const leadSid = '44444444-5555-4666-8777-000000000003'
    await createSessionRecord(leadSid, lead.id, 'Acme', '/repo/acme', { title: 'Catering lead' })
    const online = await direct({ title: 'Order the coffee', parent_task_id: elsewhere.id }, { 'x-walnut-caller-sid': leadSid })
    expect(online.parent_task_id).toBe(lead.id)
    const away = await drained({ kind: 'session', sid: leadSid }, { title: 'Order the tea' }, { parentTaskId: elsewhere.id })
    expect(away.parent_task_id).toBe(lead.id)
    const job = await drained({ kind: 'plugin-job', plugin: 'acme-sync', job: 'poll' }, { title: 'Imported row three' }, { project: 'Acme', parentTaskId: elsewhere.id })
    expect(job.parent_task_id ?? '').toBe('')
    const { createDevice, listDeviceRecords } = await import('../../../src/core/device-auth.js')
    await createDevice('acme-phone')
    const deviceId = (await listDeviceRecords()).find((d) => d.name === 'acme-phone')!.id
    const phone = await drained({ kind: 'device', deviceId, name: 'acme-phone' }, { title: 'Phone child' }, { project: 'Acme', parentTaskId: elsewhere.id })
    expect(phone.parent_task_id).toBe(elsewhere.id)
  })

  it('a lead\'s away start: adopted for a task that host\'s journal made, refused for one the Mac made', async () => {
    const lead = (await addTask({ title: 'Stage lead', project: 'Acme' })).task
    const leadSid = '44444444-5555-4666-8777-000000000002'
    await createSessionRecord(leadSid, lead.id, 'Acme', '/repo/acme', { title: 'Stage lead' })
    const actor = { kind: 'session', sid: leadSid }
    const sessionRec = (sid: string, taskId: string) => ({
      v: 2, seq: ++seqN, at: Date.now() - 50_000, kind: 'session', opId: `op-place-${seqN}`, rev: 1, actor,
      sid, taskId, host: HOST, cwd: '/repo/acme', mode: 'default', title: 'Rig the stage', startedAt: Date.now() - 50_000,
      firstMessage: 'Rig the stage', run: 'task',
    })
    // Made by this host's journal, then started there: the Mac takes both, the session as the task's own.
    const id = minted()
    const create = createRec(id, actor, { title: 'Rig the stage' })
    const made = '66666666-7777-4888-9999-000000000001'
    const j = journal([create, sessionRec(made, id)])
    await runOfflineHandover(j.conn as never)
    expect(j.pending).toHaveLength(0)
    const task = await getTask(id)
    expect(task.parent_task_id).toBe(lead.id)
    expect(task.session_ids ?? []).toContain(made)
    expect(await getSessionByClaudeId(made)).toMatchObject({ taskId: id, host: HOST })
    // Made on the Mac (a record_only subtask), started on the host alone: never adopted.
    const macMade = (await addTask({ title: 'Light the stage', project: 'Acme', parent_task_id: lead.id } as never)).task
    const orphan = '66666666-7777-4888-9999-000000000002'
    const k = journal([sessionRec(orphan, macMade.id)])
    await runOfflineHandover(k.conn as never)
    expect(await getSessionByClaudeId(orphan)).toBeNull()
    expect((await getTask(macMade.id)).session_ids ?? []).not.toContain(orphan)
  })
})
