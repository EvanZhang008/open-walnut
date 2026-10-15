/**
 * GET /api/replicas/status and POST /api/replicas/confirm-removal
 * (src/web/routes/replicas-status.ts; docs/plan/walnut-replica-servers-impl.md,
 * section 4, WP3), on the real router in a small express app, driven by the
 * real task copy rounds (core/replication/task-replica.ts) against registered
 * targets: one that takes the copy, one whose half rule refuses it.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-replicas-status', { CLOUD_MODE: false }))

import { replicasStatusRouter } from '../../../src/web/routes/replicas-status.js'
import { syncTaskReplica, _resetTaskReplicaForTesting, type TaskReplicaDeps } from '../../../src/core/replication/task-replica.js'
import { registerReplicaTarget, replicaTargets, _resetReplicaTargetsForTesting, type ReplicaTarget } from '../../../src/core/replication/replica-targets.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import type { Task } from '../../../src/core/types.js'

let server: Server | null = null
let port = 0
let syncs: Array<Record<string, unknown>> = []
const NOW = '2026-10-14T08:00:00.000Z'
const tasks = Array.from({ length: 3 }, (_, i) => ({ id: `t-${i}`, title: `acme ${i}`, created_at: NOW, updated_at: NOW }) as Task)
const deps: TaskReplicaDeps = {
  view: async () => ({ tasks, registry: { projects: {}, task_groups: {}, custom_tiers: [] } }),
  targets: () => replicaTargets().filter((t) => t.kind === 'host'),
}

function target(id: string, refuse: () => boolean): ReplicaTarget {
  return {
    id, kind: 'host', label: id.replace('host:', ''), available: async () => true,
    post: async (payload) => {
      if (payload.op === 'sync') syncs.push(payload)
      if (payload.op === 'sync' && payload.kind === 'tasks' && refuse() && payload.confirm !== true) {
        return { ok: false, outcome: 'failed', status: 400, error: 'manifest_removes_most_rows' }
      }
      const entries = (payload.entries as Array<{ k: string }> | undefined) ?? []
      return { ok: true, reply: payload.op === 'sync' ? { ok: true, need: entries.map((e) => e.k), held: 0, removed: 0 } : { ok: true, stored: Array.isArray(payload.rows) ? payload.rows.length : 1, held: 0 } }
    },
  }
}

async function api(method: string, p: string, body?: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const r = await fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) })
  return { status: r.status, body: await r.json() as Record<string, unknown> }
}

beforeAll(async () => {
  const { default: express } = await import('express')
  const app = express()
  app.use(express.json())
  app.use('/api', replicasStatusRouter)
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
})

beforeEach(() => {
  _resetTaskReplicaForTesting()
  _resetReplicaTargetsForTesting()
  _resetServerRoleForTesting()
  syncs = []
})

afterEach(() => {
  delete process.env.WALNUT_HOST_SERVER
  _resetServerRoleForTesting()
})

describe('the leader\'s view of its followers', () => {
  it('lists each target kind by kind; three refusals raise needsConfirm; the confirm is sent once', async () => {
    registerReplicaTarget(target('host:acme', () => false))
    registerReplicaTarget(target('host:marina', () => true))
    for (let i = 0; i < 3; i++) await syncTaskReplica(deps)
    const { status, body } = await api('GET', '/replicas/status')
    expect(status).toBe(200)
    const byId = Object.fromEntries((body.targets as Array<{ id: string; kinds: Array<Record<string, unknown>> }>).map((t) => [t.id, t]))
    expect(byId['host:acme'].kinds).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tasks', action: 'unchanged', entries: 3, refusals: 0, needsConfirm: false })]))
    expect(byId['host:marina'].kinds).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'tasks', action: 'failed', refusals: 3, needsConfirm: true, lastRefusal: expect.objectContaining({ error: 'manifest_removes_most_rows', entries: 3 }) })]))
    expect((await api('POST', '/replicas/confirm-removal', { target: 'host:acme' })).status).toBe(409)
    expect(await api('POST', '/replicas/confirm-removal', { target: 'host:marina', kind: 'tasks' })).toEqual({ status: 200, body: { ok: true } })
    syncs = []
    const results = await syncTaskReplica(deps)
    expect(results.filter((r) => r.target === 'host:marina').map((r) => `${r.kind}:${r.action}`)).toEqual(['tasks:synced', 'registry:synced'])
    expect(syncs.filter((s) => s.kind === 'tasks').map((s) => s.confirm ?? false)).toEqual([true])
    const after = await api('GET', '/replicas/status')
    const marina = (after.body.targets as Array<{ id: string; kinds: Array<Record<string, unknown>> }>).find((t) => t.id === 'host:marina')!
    expect(marina.kinds.find((k) => k.kind === 'tasks')).toMatchObject({ refusals: 0, needsConfirm: false })
  })

  it('a bad confirm request is a 400', async () => {
    expect((await api('POST', '/replicas/confirm-removal', { kind: 'tasks' })).status).toBe(400)
    expect((await api('POST', '/replicas/confirm-removal', { target: 'host:acme', kind: 'acme' })).status).toBe(400)
    expect((await api('POST', '/replicas/confirm-removal', { target: 'host:acme', entries: 'three' })).status).toBe(400)
  })

  it('only the user confirms: a session caller is 403 human_only and arms nothing; the count the user saw binds the confirm', async () => {
    registerReplicaTarget(target('host:marina', () => true))
    for (let i = 0; i < 3; i++) await syncTaskReplica(deps)
    const asSession = await api('POST', '/replicas/confirm-removal', { target: 'host:marina' }, { 'x-walnut-caller-sid': 'session-acme-1' })
    expect(asSession).toMatchObject({ status: 403, body: { ok: false, error: 'human_only' } })
    const still = await api('GET', '/replicas/status')
    const kinds = () => ((still.body.targets as Array<{ id: string; kinds: Array<Record<string, unknown>> }>)[0].kinds)
    expect(kinds().find((k) => k.kind === 'tasks')).toMatchObject({ needsConfirm: true })
    // The user saw an older count: nothing to confirm for it.
    expect((await api('POST', '/replicas/confirm-removal', { target: 'host:marina', entries: 7 })).status).toBe(409)
    // ...or another key set at the same count (the keys of the lastRefusal it read).
    const seen = kinds().find((k) => k.kind === 'tasks')!.lastRefusal as { entries: number; keys: string }
    expect(seen.keys).toMatch(/^[0-9a-f]{12}$/)
    expect((await api('POST', '/replicas/confirm-removal', { target: 'host:marina', entries: 3, keys: '000000000000' })).status).toBe(409)
    expect((await api('POST', '/replicas/confirm-removal', { target: 'host:marina', entries: 3, keys: 'not-a-hash' })).status).toBe(400)
    expect((await api('POST', '/replicas/confirm-removal', { target: 'host:marina', entries: 3, keys: seen.keys })).status).toBe(200)
    const armed = await api('GET', '/replicas/status')
    const tasksRow = (armed.body.targets as Array<{ kinds: Array<Record<string, unknown>> }>)[0].kinds.find((k) => k.kind === 'tasks')
    expect(tasksRow).toMatchObject({ needsConfirm: false, confirmArmed: { entries: 3, keys: expect.any(String), expiresAt: expect.any(Number) } })
  })

  it('a follower answers 404 leader_only', async () => {
    process.env.WALNUT_HOST_SERVER = '1'
    _resetServerRoleForTesting()
    expect(await api('GET', '/replicas/status')).toEqual({ status: 404, body: { ok: false, error: 'leader_only' } })
    expect((await api('POST', '/replicas/confirm-removal', { target: 'host:acme' })).status).toBe(404)
  })
})
