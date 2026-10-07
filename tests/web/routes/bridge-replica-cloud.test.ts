/**
 * POST /bridge/replica on a real CLOUD_MODE server (src/web/routes/bridge-replica.ts),
 * driven by the primary's real rounds (core/replication/task-replica.ts) over
 * the real client (cloud-ingest.ts postToCloudReplica, gzip + machine token).
 *
 * Pinned: only the primary's machine credential reaches the copy (a phone
 * token or another machine's get 403, none 401, before the body is read); a
 * round lands every row in this server's own task store; this box's own task
 * writes are never sent to the primary as ops (the replica writes are not its
 * writes); a bad body is a 400, not a 500.
 *
 * auth.json is written fresh (tokens known to the test); nothing is copied.
 */
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { Server as HttpServer } from 'node:http'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-bridge-replica-cloud', { CLOUD_MODE: true }))

let bridgeCfg: { enabled: boolean; url?: string; token?: string } = { enabled: false }
vi.mock('../../../src/integrations/cloud-bridge-config.js', async (orig) => ({
  ...(await orig<typeof import('../../../src/integrations/cloud-bridge-config.js')>()),
  getBridgeConfigForHost: async () => bridgeCfg,
}))

import { WALNUT_HOME, TASK_QUEUE_DIR } from '../../../src/constants.js'
import { startServer, stopServer } from '../../../src/web/server.js'
import { _resetDeviceAuthForTesting } from '../../../src/core/device-auth.js'
import { _resetAuthRateLimitForTesting } from '../../../src/web/middleware/auth-rate-limit.js'
import { _resetCloudIngestForTesting, postToCloudReplica } from '../../../src/core/cloud-ingest.js'
import { syncTaskReplica, _resetTaskReplicaForTesting } from '../../../src/core/replication/task-replica.js'
import * as tm from '../../../src/core/task-manager.js'
import type { Task } from '../../../src/core/types.js'

let server: HttpServer
let port = 0
const sha = (t: string) => crypto.createHash('sha256').update(t, 'utf-8').digest('hex')
const tok = () => crypto.randomBytes(16).toString('hex')
const T = { local: tok(), devbox: tok(), phone: tok() }
const NOW = '2026-10-07T08:00:00.000Z'

const primaryRows: Task[] = [
  { id: 'mrep01-aaaa', title: 'Leader: ship the release', status: 'in_progress', phase: 'IN_PROGRESS', priority: 'none', project: 'Acme', source: 'local', session_ids: ['s-lead'], description: 'Ship on Friday.', summary: '', note: '- drill passed', created_at: NOW, updated_at: NOW } as Task,
  { id: 'mrep02-bbbb', title: 'Worker: fix the build', status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', source: 'local', session_ids: [], description: '', summary: '', note: '', created_at: NOW, updated_at: NOW, parent_task_id: 'mrep01-aaaa' } as Task,
]
const view = async () => ({ tasks: primaryRows, registry: { projects: { Acme: { source: 'local' as const, order_index: 0 } }, task_groups: {}, custom_tiers: [] } })

async function post(bearer: string | null, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (bearer) headers.Authorization = `Bearer ${bearer}`
  const r = await fetch(`http://127.0.0.1:${port}/bridge/replica`, { method: 'POST', headers, body: JSON.stringify(body) })
  return { status: r.status, body: await r.json().catch(() => ({})) as Record<string, unknown> }
}

beforeAll(async () => {
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  const now = new Date().toISOString()
  await fs.writeFile(path.join(WALNUT_HOME, 'auth.json'), JSON.stringify({ devices: [
    { name: 'my-phone', id: 'd00000000000000c3', tokenHash: sha(T.phone), createdAt: now },
    { name: 'bridge-local', id: 'd00000000000000d4', tokenHash: sha(T.local), createdAt: now, kind: 'machine' },
    { name: 'bridge-devbox', id: 'd00000000000000e5', tokenHash: sha(T.devbox), createdAt: now, kind: 'machine' },
  ] }), { mode: 0o600 })
  _resetDeviceAuthForTesting()
  server = await startServer({ port: 0, dev: true })
  const addr = server.address()
  if (!addr || typeof addr === 'string') throw new Error('no port')
  port = addr.port
  bridgeCfg = { enabled: true, url: `ws://127.0.0.1:${port}/bridge`, token: T.local }
}, 60_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(() => {
  _resetAuthRateLimitForTesting()
  _resetCloudIngestForTesting()
  _resetTaskReplicaForTesting()
})

describe('who may write the copy', () => {
  const body = { op: 'sync', kind: 'tasks', entries: [{ k: 'x', h: '0123456789ab' }], asOf: Date.now() }
  it.each([
    ['no token', null, 401],
    ['a phone device token', T.phone, 403],
    ["another host's machine token", T.devbox, 403],
  ] as const)('%s is refused (%i)', async (_label, bearer, status) => {
    expect((await post(bearer, body)).status).toBe(status)
  })

  it('a bad step is a 400', async () => {
    expect((await post(T.local, { op: 'sync', kind: 'tasks', entries: [{ k: 'x', h: 'nothex' }] })).status).toBe(400)
    expect((await post(T.local, { op: 'put', kind: 'tasks', rows: [{ id: 'no-title' }] })).status).toBe(400)
    expect((await post(T.local, { op: 'drop' })).status).toBe(400)
  })
})

describe('a round from the primary', () => {
  it('lands every row in this server\'s own store, and none of it goes back to the primary as an op', async () => {
    const results = await syncTaskReplica({ view, post: postToCloudReplica })
    expect(results.map((r) => `${r.kind}:${r.action}`)).toEqual(['tasks:synced', 'registry:synced'])
    expect(results[0]).toMatchObject({ entries: 2, sent: 2, held: 0 })
    expect(await tm.getTask('mrep01-aaaa')).toMatchObject({ description: 'Ship on Friday.', note: '- drill passed', session_ids: ['s-lead'] })
    expect(await tm.getTask('mrep02-bbbb')).toMatchObject({ parent_task_id: 'mrep01-aaaa' })
    // The replica's writes are not this box's writes: the task-op queue is empty.
    await new Promise((r) => setTimeout(r, 200))
    expect(await fs.readdir(TASK_QUEUE_DIR).catch(() => [])).toEqual([])
    // A second round sends nothing.
    expect((await syncTaskReplica({ view, post: postToCloudReplica })).map((r) => r.action)).toEqual(['unchanged', 'unchanged'])
  })
})
