/**
 * The task copy's round scheduler (src/core/replication/task-replica.ts
 * startTaskReplicaSync; docs/plan/walnut-replica-servers-impl.md, section 4):
 * push, never poll. A task event leads to one round after the 3 s debounce;
 * rows a follower held lead to one more after HELD_RETRY_MS; the 5 minute
 * sweep forgets every memo and sends the manifests again; a follower that
 * joins, or one registered while it was not reachable yet that becomes
 * reachable (a host server that was still starting), gets a round within the
 * debounce, and one that restarted under the same registration a real step
 * (its memo and rests forgotten); the user's confirm rides on a round within
 * the debounce, and a confirm whose step was lost goes again within seconds,
 * backing off; a follower starts nothing. Real rounds (kind-leader.ts) against registered
 * targets (replica-targets.ts), the real event bus; only the clock is fake
 * (setTimeout and setInterval; setImmediate stays real).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-task-replica-scheduler', { CLOUD_MODE: false }))

import { confirmTaskReplicaRemoval, startTaskReplicaSync, _resetTaskReplicaForTesting, type TaskReplicaDeps } from '../../../src/core/replication/task-replica.js'
import { registerReplicaTarget, replicaTargetAvailable, replicaTargets, _resetReplicaTargetsForTesting, type ReplicaTarget } from '../../../src/core/replication/replica-targets.js'
import { CONFIRM_RETRY_MAX_MS, CONFIRM_RETRY_MS, CONFIRM_TTL_MS, HELD_RETRY_MS, confirmRetryMs } from '../../../src/core/replication/kind.js'
import { peekKindState } from '../../../src/core/replication/replica-status.js'
import { _resetServerRoleForTesting } from '../../../src/core/server-role.js'
import { bus } from '../../../src/core/event-bus.js'
import type { Task } from '../../../src/core/types.js'

const DEBOUNCE_MS = 3_000
const FIRST_ROUND_MS = 15_000
const SWEEP_MS = 5 * 60_000
const NOW = '2026-10-14T08:00:00.000Z'

let tasks: Task[] = []
let views = 0
let steps: Array<{ target: string; op: string; kind: string; confirm?: boolean; confirmFor?: unknown; lost?: boolean }> = []
let stop: (() => void) | null = null

const deps: TaskReplicaDeps = {
  view: async () => { views++; return { tasks, registry: { projects: {}, task_groups: {}, custom_tiers: [] } } },
  targets: () => replicaTargets().filter((t) => t.kind === 'host'),
}

interface FakeFollower {
  /** Rows the next sync answers as held (then 0). */
  holdOnce: number
  /** Refuse a tasks manifest without a confirm (the half rule). */
  refuse: boolean
  up: boolean
  /** Lose this many confirm steps on the way (a stream reset, the host not connected). */
  loseConfirm?: number
  /** A kind this follower's build does not keep (404 unknown_kind). */
  unknown?: string
}

function follower(id: string, f: FakeFollower): ReplicaTarget {
  return {
    id, kind: 'host', label: id.replace('host:', ''), available: async () => f.up,
    post: async (payload) => {
      const lost = payload.confirm === true && (f.loseConfirm ?? 0) > 0
      steps.push({ target: id, op: String(payload.op), kind: String(payload.kind), ...(payload.confirm === true ? { confirm: true, confirmFor: payload.confirmFor } : {}), ...(lost ? { lost } : {}) })
      if (lost) {
        f.loseConfirm = f.loseConfirm! - 1
        return { ok: false, outcome: 'failed', error: 'the host is not connected' }
      }
      if (payload.kind === f.unknown) return { ok: false, outcome: 'unsupported', status: 404, error: 'unknown_kind' }
      if (payload.op === 'sync' && payload.kind === 'tasks' && f.refuse && payload.confirm !== true) {
        return { ok: false, outcome: 'failed', status: 400, error: 'manifest_removes_most_rows', body: { ok: false, error: 'manifest_removes_most_rows', local: 100, removing: 97 } }
      }
      if (payload.op === 'sync') {
        const held = f.holdOnce
        f.holdOnce = 0
        const entries = (payload.entries as Array<{ k: string }> | undefined) ?? []
        return { ok: true, reply: { ok: true, need: entries.map((e) => e.k), held, removed: 0 } }
      }
      return { ok: true, reply: { ok: true, stored: Array.isArray(payload.rows) ? payload.rows.length : 1, held: 0 } }
    },
  }
}

/** Let a round run to its end: its steps are promise chains, and the imports it waits on resolve on I/O. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

async function advance(ms: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(ms)
  await settle()
}

const syncsTo = (id: string, kind = 'tasks') => steps.filter((s) => s.target === id && s.op === 'sync' && s.kind === kind)

function taskEvent(name = 'task:updated'): void {
  bus.emit(name, { task: tasks[0] }, ['*'], { source: 'test' })
}

async function start(): Promise<void> {
  stop = startTaskReplicaSync(deps).stop
  await settle() // the bus and targets subscriptions are made on dynamic imports
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
  _resetTaskReplicaForTesting()
  _resetReplicaTargetsForTesting()
  _resetServerRoleForTesting()
  tasks = Array.from({ length: 3 }, (_, i) => ({ id: `t-${i}`, title: `acme ${i}`, created_at: NOW, updated_at: NOW }) as Task)
  views = 0
  steps = []
})

afterEach(async () => {
  stop?.()
  stop = null
  await settle()
  vi.useRealTimers()
  delete process.env.WALNUT_HOST_SERVER
  _resetServerRoleForTesting()
  _resetReplicaTargetsForTesting()
})

describe('the task copy round scheduler', () => {
  it('a task write the companion forwarded here gets its round at once, not after the debounce (WP13)', async () => {
    const { noteForwardedTaskWrite } = await import('../../../src/web/v1-forward/policy.js')
    registerReplicaTarget(follower('host:marina', { holdOnce: 0, refuse: false, up: true }))
    await start()
    await advance(FIRST_ROUND_MS)
    expect(views).toBe(1)
    // The write's own event arms the debounce; the forward's answer runs the round now.
    tasks = tasks.map((t, j) => (j === 0 ? { ...t, title: 'acme from the phone' } : t))
    taskEvent()
    noteForwardedTaskWrite('PATCH', '/tasks/t-0', 200)
    await advance(0)
    await settle()
    expect(views).toBe(2)
    await advance(DEBOUNCE_MS + 10)
    const settled = views
    // A read, a failed write, or a write outside the copy runs nothing early.
    noteForwardedTaskWrite('GET', '/tasks', 200)
    noteForwardedTaskWrite('PATCH', '/tasks/t-0', 409)
    noteForwardedTaskWrite('POST', '/tasks/t-0/board/post', 200)
    noteForwardedTaskWrite('POST', '/projects', 201)
    await advance(0)
    await settle()
    expect(views).toBe(settled)
  })

  it('a follower starts nothing: no timer, no round on any event', async () => {
    process.env.WALNUT_HOST_SERVER = '1'
    _resetServerRoleForTesting()
    const before = vi.getTimerCount()
    registerReplicaTarget(follower('host:marina', { holdOnce: 0, refuse: false, up: true }))
    await start()
    expect(vi.getTimerCount()).toBe(before)
    taskEvent()
    await advance(SWEEP_MS + FIRST_ROUND_MS)
    expect(views).toBe(0)
    expect(steps).toEqual([])
  })

  it('a first round shortly after boot, then a burst of task events is one round after the debounce', async () => {
    registerReplicaTarget(follower('host:marina', { holdOnce: 0, refuse: false, up: true }))
    await start()
    await advance(FIRST_ROUND_MS - 1)
    expect(views).toBe(0)
    await advance(1)
    expect(views).toBe(1)
    expect(syncsTo('host:marina').length).toBe(1)
    // Five changes inside a second: one round, DEBOUNCE_MS after the first of them.
    for (let i = 0; i < 5; i++) {
      tasks = tasks.map((t, j) => (j === 0 ? { ...t, title: `acme edit ${i}` } : t))
      taskEvent(i % 2 ? 'project:updated' : 'task:updated')
      await advance(200)
    }
    await advance(DEBOUNCE_MS - 1_000 - 1)
    expect(views).toBe(1)
    await advance(1)
    expect(views).toBe(2)
    expect(syncsTo('host:marina').length).toBe(2)
    // An event the copy does not care about starts nothing.
    taskEvent('session:status-changed')
    await advance(DEBOUNCE_MS * 2)
    expect(views).toBe(2)
  })

  it('rows a follower held run one more round after HELD_RETRY_MS, and no more once nothing is held', async () => {
    const f: FakeFollower = { holdOnce: 2, refuse: false, up: true }
    registerReplicaTarget(follower('host:marina', f))
    await start()
    await advance(FIRST_ROUND_MS)
    expect(views).toBe(1)
    await advance(HELD_RETRY_MS - 1)
    expect(views).toBe(1)
    await advance(1)
    expect(views).toBe(2)
    // The held rows' manifest went again (its memo was not kept).
    expect(syncsTo('host:marina').length).toBe(2)
    await advance(HELD_RETRY_MS * 3)
    expect(views).toBe(2)
  })

  it('the sweep forgets the memos every 5 minutes and sends the manifests again', async () => {
    registerReplicaTarget(follower('host:marina', { holdOnce: 0, refuse: false, up: true }))
    await start()
    await advance(FIRST_ROUND_MS)
    expect(syncsTo('host:marina').length).toBe(1)
    // A round with nothing changed sends no manifest.
    taskEvent()
    await advance(DEBOUNCE_MS)
    expect(views).toBe(2)
    expect(syncsTo('host:marina').length).toBe(1)
    await advance(SWEEP_MS - FIRST_ROUND_MS - DEBOUNCE_MS - 1)
    expect(syncsTo('host:marina').length).toBe(1)
    await advance(1)
    expect(syncsTo('host:marina').length).toBe(2)
    expect(syncsTo('host:marina', 'registry').length).toBe(2)
  })
})

describe('the scheduler and followers that join, and the user\'s confirm', () => {
  it('a follower that joins gets its first round within the debounce', async () => {
    await start()
    await advance(FIRST_ROUND_MS)
    expect(views).toBe(0) // nobody to copy to: the round builds no manifest
    registerReplicaTarget(follower('host:marina', { holdOnce: 0, refuse: false, up: true }))
    await advance(DEBOUNCE_MS)
    expect(syncsTo('host:marina').length).toBe(1)
  })

  it('a follower registered before it answers gets its round within the debounce once it does', async () => {
    // A host server's target is registered while it starts (core/host-server/manager.ts);
    // the manager says when it runs (replicaTargetAvailable), with no task event at all.
    const f: FakeFollower = { holdOnce: 0, refuse: false, up: false }
    await start()
    await advance(FIRST_ROUND_MS) // past the boot round: only the events below start one
    registerReplicaTarget(follower('host:marina', f))
    await advance(DEBOUNCE_MS)
    expect(steps).toEqual([]) // not reachable yet: unsupported, no step
    await advance(5_000)
    f.up = true
    replicaTargetAvailable('host:marina')
    await advance(DEBOUNCE_MS - 1)
    expect(steps).toEqual([])
    await advance(1)
    expect(syncsTo('host:marina').length).toBe(1)
    expect(syncsTo('host:marina', 'registry').length).toBe(1)
    // A name nobody registered starts nothing.
    const seen = views
    replicaTargetAvailable('host:acme')
    await advance(DEBOUNCE_MS * 2)
    expect(views).toBe(seen)
  })

  it('the user\'s confirm rides on a round within the debounce, long before it expires', async () => {
    const f: FakeFollower = { holdOnce: 0, refuse: true, up: true }
    registerReplicaTarget(follower('host:marina', f))
    await start()
    await advance(FIRST_ROUND_MS)
    for (let i = 0; i < 2; i++) { taskEvent(); await advance(DEBOUNCE_MS) }
    expect(syncsTo('host:marina').length).toBe(3)
    expect(syncsTo('host:marina').some((s) => s.confirm)).toBe(false)
    expect(await confirmTaskReplicaRemoval('host:marina', 'tasks', { entries: 3 })).toBe(true)
    await advance(DEBOUNCE_MS - 1)
    expect(syncsTo('host:marina').length).toBe(3)
    await advance(1)
    const sent = syncsTo('host:marina')
    expect(sent.length).toBe(4)
    expect(sent[3]).toMatchObject({ confirm: true, confirmFor: { entries: 3, keys: expect.stringMatching(/^[0-9a-f]{12}$/) } })
    expect(DEBOUNCE_MS).toBeLessThan(CONFIRM_TTL_MS)
  })

  it('an older scheduler that stops does not take the newer one\'s confirm hook with it', async () => {
    const f: FakeFollower = { holdOnce: 0, refuse: true, up: true }
    registerReplicaTarget(follower('host:marina', f))
    const older = startTaskReplicaSync(deps)
    await start()
    older.stop()
    await advance(FIRST_ROUND_MS)
    for (let i = 0; i < 2; i++) { taskEvent(); await advance(DEBOUNCE_MS) }
    expect(await confirmTaskReplicaRemoval('host:marina', 'tasks')).toBe(true)
    await advance(DEBOUNCE_MS)
    expect(syncsTo('host:marina').at(-1)).toMatchObject({ confirm: true })
  })

  it('a newer scheduler that stops leaves the older one its confirm and round-now hooks', async () => {
    const f: FakeFollower = { holdOnce: 0, refuse: true, up: true }
    registerReplicaTarget(follower('host:marina', f))
    await start()
    const newer = startTaskReplicaSync(deps)
    await settle()
    newer.stop()
    await advance(FIRST_ROUND_MS)
    for (let i = 0; i < 2; i++) { taskEvent(); await advance(DEBOUNCE_MS) }
    expect(syncsTo('host:marina').length).toBe(3)
    expect(await confirmTaskReplicaRemoval('host:marina', 'tasks')).toBe(true)
    await advance(DEBOUNCE_MS - 1)
    expect(syncsTo('host:marina').length).toBe(3)
    await advance(1)
    expect(syncsTo('host:marina').at(-1)).toMatchObject({ confirm: true })
    // A write the companion forwarded still gets its round at once (WP13).
    const { noteForwardedTaskWrite } = await import('../../../src/web/v1-forward/policy.js')
    const seen = views
    noteForwardedTaskWrite('PATCH', '/tasks/t-0', 200)
    await advance(0)
    expect(views).toBe(seen + 1)
  })

  it('a confirm whose step was lost on the way goes again within seconds, backing off, until one is answered', async () => {
    const f: FakeFollower = { holdOnce: 0, refuse: true, up: true, loseConfirm: Infinity }
    registerReplicaTarget(follower('host:marina', f))
    await start()
    await advance(FIRST_ROUND_MS)
    for (let i = 0; i < 2; i++) { taskEvent(); await advance(DEBOUNCE_MS) }
    expect(await confirmTaskReplicaRemoval('host:marina', 'tasks')).toBe(true)
    await advance(DEBOUNCE_MS)
    const tries = () => syncsTo('host:marina').filter((s) => s.confirm)
    expect(tries().map((s) => s.lost)).toEqual([true])
    // No task event, no sweep: the scheduler itself sends it again, waiting longer each time.
    let waited = 0
    for (let n = 1; n <= 6; n++) {
      const wait = confirmRetryMs(n)
      await advance(wait - 1)
      expect(tries().length).toBe(n)
      await advance(1)
      expect(tries().length).toBe(n + 1)
      waited += wait
    }
    expect([confirmRetryMs(1), confirmRetryMs(2), confirmRetryMs(5), confirmRetryMs(9)]).toEqual([CONFIRM_RETRY_MS, 2 * CONFIRM_RETRY_MS, CONFIRM_RETRY_MAX_MS, CONFIRM_RETRY_MAX_MS])
    expect(waited).toBeLessThan(SWEEP_MS - FIRST_ROUND_MS - 3 * DEBOUNCE_MS)
    // The link is back: the next try is answered, the confirm is used, and nothing more goes.
    f.loseConfirm = 0
    await advance(CONFIRM_RETRY_MAX_MS)
    expect(tries().at(-1)).toMatchObject({ confirm: true, confirmFor: { entries: 3 } })
    expect(tries().at(-1)?.lost).toBeUndefined()
    expect(peekKindState('host:marina', 'tasks')).toMatchObject({ confirmNext: false, refusals: 0 })
    const after = tries().length
    await advance(CONFIRM_RETRY_MAX_MS * 3)
    expect(tries().length).toBe(after)
    // A confirm outlives the sweep that would send it at the latest, and every retry before it.
    expect(CONFIRM_TTL_MS).toBeGreaterThan(SWEEP_MS + CONFIRM_RETRY_MAX_MS)
  })

  it('a follower that restarted under the same registration gets a real step: its memo and its rests are forgotten', async () => {
    // A host server back with its copy gone, on a newer build that keeps the registry now.
    const f: FakeFollower = { holdOnce: 0, refuse: false, up: true, unknown: 'registry' }
    registerReplicaTarget(follower('host:marina', f))
    await start()
    await advance(FIRST_ROUND_MS)
    expect(syncsTo('host:marina').length).toBe(1)
    expect(syncsTo('host:marina', 'registry').length).toBe(1)
    expect(peekKindState('host:marina', 'registry')?.restUntil).toBeGreaterThan(0)
    f.unknown = undefined
    // The same server answering again (a phase flap) changes nothing: memo and rest hold.
    replicaTargetAvailable('host:marina')
    await advance(DEBOUNCE_MS)
    expect(views).toBe(2)
    expect(syncsTo('host:marina').length).toBe(1)
    expect(syncsTo('host:marina', 'registry').length).toBe(1)
    // Another process answers: the next round sends the manifest and asks the rested kind.
    replicaTargetAvailable('host:marina', { restarted: true })
    await advance(DEBOUNCE_MS)
    expect(syncsTo('host:marina').length).toBe(2)
    expect(syncsTo('host:marina', 'registry').length).toBe(2)
    expect(peekKindState('host:marina', 'registry')).toMatchObject({ restUntil: 0, action: 'synced' })
  })

  it('stop clears every timer: no round after it, from any source', async () => {
    const f: FakeFollower = { holdOnce: 1, refuse: false, up: true }
    const before = vi.getTimerCount()
    registerReplicaTarget(follower('host:marina', f))
    await start()
    await advance(FIRST_ROUND_MS) // held: the retry timer is armed
    taskEvent() // and the debounce timer
    expect(vi.getTimerCount()).toBeGreaterThan(before)
    stop!()
    stop = null
    await settle()
    expect(vi.getTimerCount()).toBe(before)
    const seen = views
    taskEvent()
    replicaTargetAvailable('host:marina')
    registerReplicaTarget(follower('host:acme', { holdOnce: 0, refuse: false, up: true }))
    await advance(SWEEP_MS * 2)
    expect(views).toBe(seen)
  })
})
