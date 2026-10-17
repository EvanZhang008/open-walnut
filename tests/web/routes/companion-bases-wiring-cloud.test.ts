/**
 * The companion's per-field bases through their production wiring (replica plan WP13),
 * on a real CLOUD_MODE server in this process (startServer, a temp home):
 *
 *   the Mac's copy round  POST /bridge/replica (the real client, postToCloudReplica)
 *                          -> task-replica-store.ts applyToStore -> noteKnownTaskRows
 *   a console create      POST /api/tasks -> the server.ts task-outbox subscriber
 *                          -> noteKnownTaskRows([created])
 *   a console edit        PATCH /api/tasks/:id -> the same subscriber
 *                          -> companionFieldWrites -> dispatchTaskOp
 *
 * The Mac is away (no bridge, never heard), so the console's writes apply here and
 * their ops land in the queue (cache/task-queue/), where this test reads each op's
 * `fields`. Each of the three calls above is pinned: without the copy's call the edit
 * of a copied task goes with base 'unknown'; without the create's call the first edit
 * of a task born here does; without the subscriber's call the op carries no fields.
 *
 * auth.json is written fresh (tokens known to the test); nothing is copied.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-companion-bases-wiring', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { WALNUT_HOME, TASK_QUEUE_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { syncTaskReplica } from '../../../src/core/replication/task-replica.js'
import { _closeCompanionBasesForTesting } from '../../../src/core/companion-bases.js'
import * as tm from '../../../src/core/task-manager.js'
import type { TaskOp } from '../../../src/core/task-outbox.js'
import type { Task } from '../../../src/core/types.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), phone: tok() }
const MAC_AT = '2026-10-07T08:00:00.000Z'

const macRows: Task[] = [
  { id: 'mbase01-aaaa', title: 'Marina harbour plan', status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', source: 'local', session_ids: [], description: 'From the Mac.', summary: '', note: '', created_at: MAC_AT, updated_at: MAC_AT } as Task,
]
const view = async () => ({ tasks: macRows, registry: { projects: { Acme: { source: 'local' as const, order_index: 0 } }, task_groups: {}, custom_tiers: [] } })

async function phone(p: string, init: { method: string; body?: unknown }): Promise<{ status: number; by: string | null; json: Record<string, any> }> {
  const r = await fetch(`http://127.0.0.1:${port}${p}`, {
    method: init.method,
    headers: { Authorization: `Bearer ${T.phone}`, 'Content-Type': 'application/json' },
    ...(init.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  })
  return { status: r.status, by: r.headers.get('x-walnut-answered-by'), json: await r.json().catch(() => ({})) as Record<string, any> }
}

async function queuedOps(): Promise<TaskOp[]> {
  const names = (await fs.readdir(TASK_QUEUE_DIR).catch(() => [] as string[])).filter((n) => n.endsWith('.json')).sort()
  const out: TaskOp[] = []
  for (const n of names) {
    try { out.push(JSON.parse(await fs.readFile(path.join(TASK_QUEUE_DIR, n), 'utf-8')) as TaskOp) } catch { /* being written */ }
  }
  return out
}

/** The first queued op `pick` takes, once the subscriber's dispatch has queued it. */
async function queued<O extends TaskOp>(pick: (o: TaskOp) => o is O, what: string): Promise<O> {
  for (let i = 0; i < 200; i++) {
    const hit = (await queuedOps()).find(pick)
    if (hit) return hit
    await new Promise((r) => setTimeout(r, 25))
  }
  throw new Error(`no queued ${what}; queued: ${JSON.stringify((await queuedOps()).map((o) => o.type))}`)
}

type UpdateOp = Extract<TaskOp, { type: 'update' }>
const queuedUpdate = (id: string, field: string): Promise<UpdateOp> =>
  queued((o): o is UpdateOp => o.type === 'update' && o.task.id === id && (o.touched ?? []).includes(field), `update of ${id} touching ${field}`)

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  // The copy round's client posts to this server as the Mac would (gzip, machine token).
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
}, 60_000)

afterAll(async () => {
  await stopServer()
  _closeCompanionBasesForTesting()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

describe('the bases of the companion\'s queued writes, through the real wiring (the Mac away)', () => {
  it('a task the copy took: the console edit is queued with the copied value as its base', async () => {
    const results = await syncTaskReplica({ view, post: postToCloudReplica })
    expect(results[0]).toMatchObject({ kind: 'tasks', action: 'synced', sent: 1 })
    expect((await tm.getTask('mbase01-aaaa')).title).toBe('Marina harbour plan')

    const edit = await phone('/api/tasks/mbase01-aaaa', { method: 'PATCH', body: { title: 'Marina harbour plan, phase two' } })
    expect(edit.status).toBe(200)
    // The Mac is away: the console write ran here.
    expect(edit.by).toBe('companion')
    expect((await tm.getTask('mbase01-aaaa')).title).toBe('Marina harbour plan, phase two')

    const op = await queuedUpdate('mbase01-aaaa', 'title')
    expect(op.fields?.title).toMatchObject({ base: 'Marina harbour plan', value: 'Marina harbour plan, phase two' })
    expect(typeof op.fields?.title?.at).toBe('number')
  })

  it('a task born here: its first edit goes with the created value as its base', async () => {
    const created = await phone('/api/tasks', { method: 'POST', body: { title: 'Acme launch checklist', project: 'Acme' } })
    expect(created.status).toBe(201)
    expect(created.by).toBe('companion')
    const id = created.json.task.id as string
    await queued((o): o is Extract<TaskOp, { type: 'create' }> => o.type === 'create' && o.task.id === id, `create of ${id}`)

    const edit = await phone(`/api/tasks/${encodeURIComponent(id)}`, { method: 'PATCH', body: { title: 'Acme launch checklist v2' } })
    expect(edit.status).toBe(200)
    const op = await queuedUpdate(id, 'title')
    expect(op.fields?.title).toMatchObject({ base: 'Acme launch checklist', value: 'Acme launch checklist v2' })
  })
})
