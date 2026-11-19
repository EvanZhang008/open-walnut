/**
 * A task made on a host while the Mac was away lands, once drained, exactly where the
 * same caller's create lands online (POST /api/v1/tasks; apply-v2.ts createTask with
 * journal-actor.ts createCaller), against the real task store, session tracker and the
 * real route of a dev server in this process:
 *   - a session's create: its caller's subtask, in its caller's project, beside it in its
 *     folder (a subfolder when that folder holds other work), on its caller's tier, with
 *     the folder its caller works in;
 *   - a plugin job's create: an outside caller's (no parent, pinned by default), and for a
 *     plugin that keeps its tasks to its own view, kept there (`plugin_only`) as online.
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
import { createSessionRecord } from '../../../src/core/session-tracker.js'
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
})
