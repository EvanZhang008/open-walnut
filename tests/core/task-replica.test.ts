/**
 * The companion's copy of the primary's task store: the primary's rounds
 * (core/replication/task-replica.ts) against the REAL companion side
 * (task-replica-store.ts → task-manager.applyTaskReplica → its tasks.sqlite),
 * joined by an in-process transport. The primary's store is a plain array the
 * test edits; the companion's store is the real one, in cloud mode.
 *
 * What it pins: every field and every row arrives (no slim projection, no
 * retention window), only what changed is sent, removals and order follow, a
 * row the companion wrote itself is held until the primary has it, a restart
 * asks for nothing again, and the projection import stands down meanwhile.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-task-replica', { CLOUD_MODE: true }))

import { WALNUT_HOME, TASKS_DIR, TASK_QUEUE_DIR } from '../../src/constants.js'
import * as tm from '../../src/core/task-manager.js'
import { closeDb } from '../../src/core/task-db.js'
import { syncTaskReplica, forgetTaskReplica, _resetTaskReplicaForTesting, type TaskReplicaDeps } from '../../src/core/replication/task-replica.js'
import * as store from '../../src/core/replication/task-replica-store.js'
import { recordDeleteTombstone, _resetDeleteTombstonesForTesting } from '../../src/core/task-queue.js'
import type { Task } from '../../src/core/types.js'
import type { TaskReplicaRegistry } from '../../src/core/task-manager.js'

const NOW = '2026-10-07T08:00:00.000Z'

function row(id: string, extra: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', source: 'local',
    session_ids: [], description: '', summary: '', note: '', created_at: NOW, updated_at: NOW, ...extra,
  } as Task
}

let primary: Task[] = []
let registry: TaskReplicaRegistry = { projects: {}, task_groups: {}, custom_tiers: [] }
let calls: Array<{ op: string; kind: string; n: number }> = []
let unsupported = false

const deps: TaskReplicaDeps = {
  view: async () => ({ tasks: primary, registry }),
  post: async (payload) => {
    if (unsupported) return { ok: false, outcome: 'unsupported', status: 404 }
    // The wire: the companion sees what JSON carries, never the primary's objects.
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    const n = Array.isArray(body.rows) ? body.rows.length : Array.isArray(body.entries) ? body.entries.length : 1
    calls.push({ op: String(body.op), kind: String(body.kind), n })
    const r = body.op === 'sync' ? await store.replicaSync(body) : await store.replicaPut(body)
    return r.ok ? { ok: true, reply: r } : { ok: false, outcome: 'failed', status: r.status, error: r.error }
  },
}

/** A primary write: a NEW row object, as the primary's store makes one. */
function edit(id: string, patch: Partial<Task>): void {
  primary = primary.map((t) => (t.id === id ? { ...t, ...patch } : t))
}

const companionIds = async () => (await tm.listTasks()).map((t) => t.id)
const sent = () => calls.filter((c) => c.op === 'put' && c.kind === 'tasks').reduce((s, c) => s + c.n, 0)

beforeEach(async () => {
  closeDb()
  tm._resetForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
  store._resetTaskReplicaStoreForTesting()
  _resetTaskReplicaForTesting()
  _resetDeleteTombstonesForTesting()
  calls = []
  unsupported = false
  registry = { projects: { Acme: { source: 'local', order_index: 0 } }, task_groups: { g_rel: { label: 'Release', project: 'Acme' } }, custom_tiers: [{ id: 'ct_now', label: 'Now' }] }
  primary = [
    row('lead', { description: 'Ship the release on Friday.', note: '- 08:00 drill passed', session_ids: ['s-1'], group_id: 'g_rel', pinned: true, focus_tier: 'ct_now' } as Partial<Task>),
    row('worker', { parent_task_id: 'lead', group_id: 'g_rel', phase: 'IN_PROGRESS', status: 'in_progress' } as Partial<Task>),
    row('old-done', { status: 'done', phase: 'COMPLETE', completed_at: '2025-01-01T00:00:00.000Z', updated_at: '2025-01-01T00:00:00.000Z' }),
  ]
})

afterEach(async () => {
  closeDb()
  tm._resetForTesting()
})

describe('the companion copy of the tasks', () => {
  it('the first round brings every row with every field, the order and the registry; the next sends nothing', async () => {
    const results = await syncTaskReplica(deps)
    expect(results.map((r) => `${r.kind}:${r.action}`)).toEqual(['tasks:synced', 'registry:synced'])
    expect(await companionIds()).toEqual(['lead', 'worker', 'old-done'])
    const lead = await tm.getTask('lead')
    expect(lead).toMatchObject({ description: 'Ship the release on Friday.', note: '- 08:00 drill passed', session_ids: ['s-1'], group_id: 'g_rel', pinned: true, focus_tier: 'ct_now' })
    expect(await tm.getTask('worker')).toMatchObject({ parent_task_id: 'lead', phase: 'IN_PROGRESS' })
    // A done task from last year: the projection's 14-day window would have left it out.
    expect(await tm.getTask('old-done')).toMatchObject({ phase: 'COMPLETE' })
    expect(await tm.getCustomTiers()).toEqual([{ id: 'ct_now', label: 'Now' }])
    calls = []
    expect((await syncTaskReplica(deps)).map((r) => r.action)).toEqual(['unchanged', 'unchanged'])
    expect(calls).toEqual([])
  })

  it('a changed row is sent alone, even a change that leaves updated_at alone; a removed row goes; the order follows', async () => {
    await syncTaskReplica(deps)
    calls = []
    edit('worker', { phase: 'COMPLETE', status: 'done' }) // the session machine's raw write: no clock bump
    primary = [primary[1], primary[0]] // removed old-done, and worker moved first
    await syncTaskReplica(deps)
    expect(sent()).toBe(1)
    expect(await companionIds()).toEqual(['worker', 'lead'])
    expect((await tm.getTask('worker')).phase).toBe('COMPLETE')
  })

  it('a field the primary cleared is cleared on the companion too', async () => {
    edit('lead', { due_date: '2026-10-10', tags: ['label:release'] } as Partial<Task>)
    await syncTaskReplica(deps)
    expect(await tm.getTask('lead')).toMatchObject({ due_date: '2026-10-10', group_id: 'g_rel', pinned: true })
    primary = primary.map((t) => {
      if (t.id !== 'lead') return t
      const { due_date: _d, group_id: _g, focus_tier: _f, ...rest } = t as Task & { group_id?: string }
      return { ...rest, pinned: false, tags: [] } as Task
    })
    await syncTaskReplica(deps)
    const lead = await tm.getTask('lead') as Task & { group_id?: string }
    expect(lead.due_date ?? null).toBeNull()
    expect(lead.group_id ?? null).toBeNull()
    expect(!!lead.pinned).toBe(false)
    expect(lead.tags ?? []).toEqual([])
  })

  it('more than one batch of rows is sent in several puts', async () => {
    primary = Array.from({ length: 40 }, (_, i) => row(`big-${i}`, { note: 'x'.repeat(30_000) }))
    await syncTaskReplica(deps)
    const puts = calls.filter((c) => c.op === 'put' && c.kind === 'tasks')
    expect(puts.length).toBeGreaterThan(1)
    expect(sent()).toBe(40)
    expect(await companionIds()).toEqual(primary.map((t) => t.id))
  })

  it('rows that arrive over several batches end in the primary\'s order, whatever order the companion had', async () => {
    primary = Array.from({ length: 30 }, (_, i) => row(`r-${String(i).padStart(2, '0')}`, { note: 'y'.repeat(40_000) }))
    await syncTaskReplica(deps)
    // The primary moves the last ten first and adds two in the middle.
    primary = [...primary.slice(20), ...primary.slice(0, 10), row('new-a'), row('new-b'), ...primary.slice(10, 20)]
    await syncTaskReplica(deps)
    expect(await companionIds()).toEqual(primary.map((t) => t.id))
  })

  it('a row the companion wrote itself is held: not replaced, not removed; the primary sends the manifest again until it has it', async () => {
    await syncTaskReplica(deps)
    // The companion edits `lead` (the leader writing while the Mac is away); its op waits in the queue.
    await tm.updateTask('lead', { title: 'Lead (edited on the companion)' })
    store.noteLocalTaskWrite('lead')
    await fsp.mkdir(TASK_QUEUE_DIR, { recursive: true })
    await fsp.writeFile(path.join(TASK_QUEUE_DIR, '000000000000001-0000.json'), JSON.stringify({ opId: '000000000000001-0000', type: 'update', at: NOW, task: { ...(await tm.getTask('lead')) } }))
    // Meanwhile the primary changed it too, and removed old-done.
    edit('lead', { summary: 'primary side' })
    primary = primary.filter((t) => t.id !== 'old-done')
    calls = []
    const [tasks] = await syncTaskReplica(deps)
    expect(tasks).toMatchObject({ action: 'synced', held: 1 })
    expect((await tm.getTask('lead')).title).toBe('Lead (edited on the companion)')
    expect(await companionIds()).not.toContain('old-done')
    // Held, so not remembered: the next round asks again.
    calls = []
    await syncTaskReplica(deps)
    expect(calls.some((c) => c.op === 'sync' && c.kind === 'tasks')).toBe(true)
  })

  it('a row the companion deleted does not come back from a manifest built before the primary applied the delete', async () => {
    await syncTaskReplica(deps)
    await tm.deleteTask('worker')
    recordDeleteTombstone('worker')
    edit('worker', { summary: 'still on the primary' })
    await syncTaskReplica(deps)
    expect(await companionIds()).not.toContain('worker')
  })

  it('a companion restart keeps its copy and asks for nothing; a lost copy asks for every row again', async () => {
    await syncTaskReplica(deps)
    store._resetTaskReplicaStoreForTesting() // the companion restarted: state comes back from disk
    forgetTaskReplica() // the sweep sends the manifest anyway
    calls = []
    await syncTaskReplica(deps)
    expect(sent()).toBe(0)
    fs.rmSync(path.join(WALNUT_HOME, 'cache', 'task-replica.json'))
    store._resetTaskReplicaStoreForTesting()
    forgetTaskReplica()
    calls = []
    await syncTaskReplica(deps)
    expect(sent()).toBe(3)
  })

  it('a primary that lost most of its store does not empty the companion', async () => {
    primary = Array.from({ length: 60 }, (_, i) => row(`m-${i}`))
    await syncTaskReplica(deps)
    primary = primary.slice(0, 10)
    const [tasks] = await syncTaskReplica(deps)
    expect(tasks).toMatchObject({ kind: 'tasks', action: 'failed', error: 'manifest_removes_most_rows' })
    expect((await companionIds()).length).toBe(60)
    // An ordinary delete still goes.
    primary = Array.from({ length: 60 }, (_, i) => row(`m-${i}`)).slice(0, 55)
    await syncTaskReplica(deps)
    expect((await companionIds()).length).toBe(55)
  })

  it('no companion set up: the round builds no manifest at all', async () => {
    let viewed = 0
    const results = await syncTaskReplica({ ...deps, view: async () => { viewed++; return deps.view() }, available: async () => false })
    expect(results).toEqual([{ kind: 'tasks', action: 'unsupported' }])
    expect(viewed).toBe(0)
    expect(calls).toEqual([])
  })

  it('a companion without the route: nothing changes there and the round says so', async () => {
    unsupported = true
    const results = await syncTaskReplica(deps)
    expect(results).toEqual([{ kind: 'tasks', action: 'unsupported', error: 'HTTP 404' }])
    expect(await companionIds()).toEqual([])
  })

  it('the projection import stands down while the copy is fresh, and for a projection older than it', async () => {
    await syncTaskReplica(deps)
    expect(await store.taskReplicaSupersedes(new Date(Date.now() + 60_000).toISOString())).toBe(true)
    // An older primary that only sends projections: after 15 quiet minutes a newer projection is imported again.
    const state = JSON.parse(fs.readFileSync(path.join(WALNUT_HOME, 'cache', 'task-replica.json'), 'utf8'))
    state.at = Date.now() - 16 * 60_000
    fs.writeFileSync(path.join(WALNUT_HOME, 'cache', 'task-replica.json'), JSON.stringify(state))
    store._resetTaskReplicaStoreForTesting()
    expect(await store.taskReplicaSupersedes(new Date(state.asOf - 60_000).toISOString())).toBe(true)
    expect(await store.taskReplicaSupersedes(new Date(state.asOf + 60_000).toISOString())).toBe(false)
  })

  it('a stale projection does not bring back a row the copy removed', async () => {
    await syncTaskReplica(deps)
    // A projection built before old-done was removed (it names it), arriving after.
    const { writeProjectionCache } = await import('../../src/core/projection-cache.js')
    await writeProjectionCache('tasks', { version: 2, exportedAt: new Date(Date.now() - 60_000).toISOString(), tasks: primary.map((t) => ({ id: t.id, title: t.title, status: t.status, phase: t.phase, priority: t.priority, project: t.project, created_at: t.created_at, updated_at: t.updated_at })) })
    primary = primary.filter((t) => t.id !== 'old-done')
    await syncTaskReplica(deps)
    const { importProjectionOnCloud } = await import('../../src/core/task-outbox.js')
    expect(await importProjectionOnCloud()).toBe(0)
    expect(await companionIds()).toEqual(['lead', 'worker'])
  })
})
