/**
 * A server on a host (WALNUT_HOST_SERVER=1, not the cloud companion) keeps the
 * task copy too (docs/plan/walnut-replica-servers-impl.md, C1 and WP3): the
 * leader's real round (core/replication/task-replica.ts, targets form) reaches
 * the real follower route (web/routes/bridge-replica.ts createLinkedReplicaRouter,
 * what the leader door serves) over HTTP, mapped exactly as the host target of
 * core/host-server/index.ts maps it. The store is the real task store on a temp
 * data dir, a copy: its shared handle reads only, the apply connection writes.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { createMockConstants } from '../helpers/mock-constants.js'
import { snapshotFiles } from '../helpers/replica-host-env.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-host-target', { CLOUD_MODE: false }))

import { WALNUT_HOME, TASKS_DIR, TASK_QUEUE_DIR } from '../../src/constants.js'
import * as tm from '../../src/core/task-manager.js'
import * as taskDb from '../../src/core/task-db.js'
import { followerKind, isHostReplica, _resetServerRoleForTesting } from '../../src/core/server-role.js'
import { syncTaskReplica, forgetTaskReplica, _resetTaskReplicaForTesting, type TaskReplicaDeps } from '../../src/core/replication/task-replica.js'
import * as store from '../../src/core/replication/task-replica-store.js'
import type { CloudReplicaReply } from '../../src/core/cloud-ingest.js'
import type { ReplicaTarget } from '../../src/core/replication/replica-targets.js'
import type { Task } from '../../src/core/types.js'
import type { TaskReplicaRegistry } from '../../src/core/task-manager.js'

const NOW = '2026-10-14T08:00:00.000Z'
let server: Server | null = null
let port = 0
let primary: Task[] = []
let registry: TaskReplicaRegistry = { projects: {}, task_groups: {}, custom_tiers: [] }
let calls: Array<{ op: string; kind: string; n: number }> = []

function row(id: string, extra: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, status: 'todo', phase: 'TODO', priority: 'none', project: 'Marina', source: 'local',
    session_ids: [], description: '', summary: '', note: '', created_at: NOW, updated_at: NOW, ...extra,
  } as Task
}

/** core/host-server/index.ts registerTarget, with the stream replaced by a local HTTP request. */
const host: ReplicaTarget = {
  id: 'host:devbox',
  kind: 'host',
  label: 'devbox',
  available: async () => true,
  post: async (payload, opts): Promise<CloudReplicaReply> => {
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    calls.push({ op: String(body.op), kind: String(body.kind), n: Array.isArray(body.rows) ? body.rows.length : Array.isArray(body.entries) ? body.entries.length : 1 })
    try {
      const res = await fetch(`http://127.0.0.1:${port}/bridge/replica`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.timeout(opts?.timeoutMs ?? 60_000),
      })
      const json = await res.json().catch(() => null) as Record<string, unknown> | null
      if (res.ok && json) return { ok: true, reply: json }
      if (res.status === 404 || res.status === 405) return { ok: false, outcome: 'unsupported', status: res.status, ...(typeof json?.error === 'string' ? { error: json.error } : {}) }
      return { ok: false, outcome: 'failed', status: res.status, error: typeof json?.error === 'string' ? json.error : undefined }
    } catch (err) {
      return { ok: false, outcome: 'failed', error: err instanceof Error ? err.message : String(err) }
    }
  },
}

const deps: TaskReplicaDeps = { view: async () => ({ tasks: primary, registry }), targets: () => [host] }
const hostIds = async () => (await tm.listTasks()).map((t) => t.id)
const sent = () => calls.filter((c) => c.op === 'put' && c.kind === 'tasks').reduce((s, c) => s + c.n, 0)

async function resetStore(): Promise<void> {
  taskDb.closeDb()
  tm._resetForTesting()
  store._resetTaskReplicaStoreForTesting()
  _resetTaskReplicaForTesting()
}

beforeAll(async () => {
  process.env.WALNUT_HOST_SERVER = '1'
  _resetServerRoleForTesting()
  const [{ default: express }, { createLinkedReplicaRouter }] = await Promise.all([import('express'), import('../../src/web/routes/bridge-replica.js')])
  const app = express()
  app.use('/bridge/replica', createLinkedReplicaRouter())
  server = await new Promise<Server>((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)) })
  port = (server.address() as AddressInfo).port
})

afterAll(async () => {
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()))
  await resetStore()
  delete process.env.WALNUT_HOST_SERVER
  _resetServerRoleForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

beforeEach(async () => {
  await resetStore()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
  calls = []
  registry = { projects: { Marina: { source: 'local', order_index: 0 } }, task_groups: { g_rel: { label: 'Release', project: 'Marina' } }, custom_tiers: [{ id: 'ct_now', label: 'Now' }] }
  primary = [
    row('lead', { description: 'Ship on Friday.', note: '- drill passed', session_ids: ['s-1'], group_id: 'g_rel', pinned: true, focus_tier: 'ct_now' } as Partial<Task>),
    row('worker', { parent_task_id: 'lead', group_id: 'g_rel', phase: 'IN_PROGRESS', status: 'in_progress' } as Partial<Task>),
    row('old-done', { status: 'done', phase: 'COMPLETE', completed_at: '2025-01-01T00:00:00.000Z' }),
  ]
})

describe('a host server keeps the task copy too', () => {
  it('is a host follower whose task store is a read-only copy', async () => {
    expect(followerKind()).toBe('host')
    expect(isHostReplica()).toBe(true)
    await tm.listTasks()
    expect(taskDb.getDb()!.pragma('query_only', { simple: true })).toBe(1)
  })

  it('a round through the host target lands every row, the order and the registry; the next sends nothing', async () => {
    const results = await syncTaskReplica(deps)
    expect(results.map((r) => `${r.target}:${r.kind}:${r.action}`)).toEqual(['host:devbox:tasks:synced', 'host:devbox:registry:synced'])
    expect(results[0]).toMatchObject({ entries: 3, sent: 3, held: 0 })
    expect(await hostIds()).toEqual(['lead', 'worker', 'old-done'])
    expect(await tm.getTask('lead')).toMatchObject({ description: 'Ship on Friday.', note: '- drill passed', session_ids: ['s-1'], group_id: 'g_rel', pinned: true, focus_tier: 'ct_now' })
    expect(await tm.getTask('old-done')).toMatchObject({ phase: 'COMPLETE' })
    expect(await tm.getCustomTiers()).toEqual([{ id: 'ct_now', label: 'Now' }])
    calls = []
    expect((await syncTaskReplica(deps)).map((r) => r.action)).toEqual(['unchanged', 'unchanged'])
    expect(calls).toEqual([])
  })

  it('a change, a removal and a reorder arrive through the apply connection; a stray write still throws', async () => {
    await syncTaskReplica(deps)
    primary = [{ ...primary[1], phase: 'COMPLETE', status: 'done' } as Task, primary[0]]
    calls = []
    await syncTaskReplica(deps)
    expect(sent()).toBe(1)
    expect(await hostIds()).toEqual(['worker', 'lead'])
    expect((await tm.getTask('worker')).phase).toBe('COMPLETE')
    // Anything but the copy's own steps meets the read-only handle.
    await expect(tm.updateTask('lead', { title: 'written on the host' })).rejects.toThrow(/readonly/i)
    expect((await tm.getTask('lead')).title).toBe('Task lead')
  })

  it('the companion\'s held sources do not apply on a host: a queued op file holds nothing (the journal overlay holds nothing until WP10)', async () => {
    await syncTaskReplica(deps)
    await fsp.mkdir(TASK_QUEUE_DIR, { recursive: true })
    await fsp.writeFile(path.join(TASK_QUEUE_DIR, '000000000000001-0000.json'), JSON.stringify({ opId: '000000000000001-0000', type: 'update', at: NOW, task: { ...primary[0], title: 'queued' } }))
    store.noteLocalTaskWrite('lead')
    primary = primary.map((t) => (t.id === 'lead' ? { ...t, summary: 'leader side' } : t))
    const [tasks] = await syncTaskReplica(deps)
    expect(tasks).toMatchObject({ action: 'synced', held: 0, sent: 1 })
    expect((await tm.getTask('lead')).summary).toBe('leader side')
  })

  it('a leader that lost most of its store does not empty the host copy', async () => {
    primary = Array.from({ length: 60 }, (_, i) => row(`m-${i}`))
    await syncTaskReplica(deps)
    primary = primary.slice(0, 10)
    const [tasks] = await syncTaskReplica(deps)
    expect(tasks).toMatchObject({ target: 'host:devbox', kind: 'tasks', action: 'failed', error: 'manifest_removes_most_rows' })
    expect((await hostIds()).length).toBe(60)
  })

  it('copy file hashes are unchanged across a replica boot (no migration, backfill or checkpoint on the copy)', async () => {
    primary = [...primary, row('no-stamp', { source: 'acme-sync', created_at: '', updated_at: '' } as Partial<Task>), row('tags', { tags: ['Label:Release', 'label:release'] } as Partial<Task>)]
    await syncTaskReplica(deps)
    const before = await quiescedSnapshot()
    expect(Object.keys(before)).toEqual(expect.arrayContaining(['tasks/tasks.sqlite', 'cache/task-replica.json']))
    // The boot: every module forgets, the store opens again and is read.
    await resetStore()
    expect(await hostIds()).toContain('no-stamp')
    await store.taskReplicaSupersedes(undefined)
    taskDb.closeDb()
    expect(snapshotCopy()).toEqual(before)
  })
})

/** The copy files with the WAL folded in by a connection of the test's own, so a later open cannot change them. */
async function quiescedSnapshot(): Promise<Record<string, string>> {
  await new Promise((r) => setTimeout(r, 50))
  taskDb.closeDb()
  const file = path.join(TASKS_DIR, 'tasks.sqlite')
  const h = new Database(file)
  h.pragma('wal_checkpoint(TRUNCATE)')
  h.close()
  return snapshotCopy()
}

function snapshotCopy(): Record<string, string> {
  return snapshotFiles(WALNUT_HOME, (rel) => rel === 'cache/task-replica.json' || rel === path.join('tasks', 'tasks.sqlite'))
}

describe('at the real store size (src/core/host-slice.ts: 6,500 tasks)', () => {
  const big = () => Array.from({ length: 6_500 }, (_, i) => row(`big-${String(i).padStart(5, '0')}`, {
    description: `Marina task ${i}: rotate the cedar gateway, then file the lantern report.`, note: `- ${i} step one\n- ${i} step two`, session_ids: [`s-${i}`],
  } as Partial<Task>))

  it('the first round lands in under 10 s; an unchanged round sends no put', async () => {
    primary = big()
    const t0 = Date.now()
    const results = await syncTaskReplica(deps)
    const ms = Date.now() - t0
    expect(results[0]).toMatchObject({ action: 'synced', entries: 6_500, sent: 6_500, held: 0 })
    expect(ms).toBeLessThan(10_000)
    expect((await hostIds()).length).toBe(6_500)
    calls = []
    expect((await syncTaskReplica(deps)).map((r) => r.action)).toEqual(['unchanged', 'unchanged'])
    forgetTaskReplica() // the sweep: a manifest, and still no put
    calls = []
    await syncTaskReplica(deps)
    expect(calls.map((c) => `${c.op}:${c.kind}`)).toEqual(['sync:tasks', 'sync:registry'])
  }, 60_000)

  it('the leader\'s side of a round never holds its event loop over 50 ms', async () => {
    primary = big()
    // A follower that asks for every row and takes them without storing: only the leader's work is timed.
    const sink: ReplicaTarget = {
      id: 'host:sink', kind: 'host', label: 'sink', available: async () => true,
      post: async (payload) => {
        const body = JSON.parse(JSON.stringify(payload)) as { op: string; entries?: Array<{ k: string }>; rows?: unknown[] }
        if (body.op === 'sync') return { ok: true, reply: { ok: true, need: (body.entries ?? []).map((e) => e.k), held: 0, removed: 0 } }
        return { ok: true, reply: { ok: true, stored: body.rows?.length ?? 1, held: 0 } }
      },
    }
    const h = monitorEventLoopDelay({ resolution: 5 })
    h.enable()
    const results = await syncTaskReplica({ view: deps.view, targets: () => [sink] })
    h.disable()
    expect(results[0]).toMatchObject({ action: 'synced', sent: 6_500 })
    expect(h.max / 1e6).toBeLessThan(50)
  }, 60_000)
})

describe('what a host server writes, and whose copy it is', () => {
  afterAll(() => {
    delete process.env.WALNUT_WALNUT_ID
    delete process.env.WALNUT_LEADER_HOME
  })
  const asLeader = (walnutId: string, home: string) => {
    process.env.WALNUT_WALNUT_ID = walnutId
    process.env.WALNUT_LEADER_HOME = home
    store._resetTaskReplicaStoreForTesting() // another host server process: no stamp in memory
  }
  const tree = () => {
    const out: string[] = []
    const walk = (d: string) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const rel = path.relative(WALNUT_HOME, path.join(d, e.name))
        out.push(e.isDirectory() ? `${rel}/` : rel)
        if (e.isDirectory()) walk(path.join(d, e.name))
      }
    }
    walk(WALNUT_HOME)
    return out.sort()
  }

  it('the first copy round on a fresh host data dir makes only the task store and the copy state (no init tree, no seeded config)', async () => {
    asLeader('wacme01', '/Users/acme/.open-walnut')
    await syncTaskReplica(deps)
    expect(await hostIds()).toEqual(['lead', 'worker', 'old-done'])
    const made = tree()
    expect(made.filter((p) => !/^(tasks|cache)\//.test(p))).toEqual([])
    expect(made).toEqual(expect.arrayContaining(['cache/task-replica.json', 'cache/task-replica-leader.json', 'tasks/tasks.sqlite']))
  })

  it('a second Walnut (another home) on the same data dir is 409 other_leader, rests, and changes nothing', async () => {
    asLeader('wacme01', '/Users/acme/.open-walnut')
    await syncTaskReplica(deps)
    const before = await hostIds()
    asLeader('wmarina2', '/Users/marina/.open-walnut')
    _resetTaskReplicaForTesting()
    primary = [row('marina-only')]
    const results = await syncTaskReplica(deps)
    expect(results[0]).toMatchObject({ target: 'host:devbox', kind: 'tasks', action: 'unsupported', error: 'other_leader' })
    expect(await hostIds()).toEqual(before)
    // The owner's steps still go through.
    asLeader('wacme01', '/Users/acme/.open-walnut')
    _resetTaskReplicaForTesting()
    primary = [...primary, row('acme-new')]
    expect((await syncTaskReplica(deps))[0]).toMatchObject({ action: 'synced' })
  })

  it('the same home set up again (a new id) takes the copy over and asks for every row again', async () => {
    asLeader('wacme01', '/Users/acme/.open-walnut')
    await syncTaskReplica(deps)
    asLeader('wacme02', '/Users/acme/.open-walnut')
    _resetTaskReplicaForTesting()
    calls = []
    const results = await syncTaskReplica(deps)
    expect(results[0]).toMatchObject({ kind: 'tasks', action: 'synced', sent: 3 })
    expect(JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'task-replica-leader.json'), 'utf8'))).toEqual({ walnutId: 'wacme02', home: '/Users/acme/.open-walnut' })
  })
})
