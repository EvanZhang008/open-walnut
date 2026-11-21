/**
 * A follower that knows nothing of the rule (core/replication/host-private.ts) still never holds a
 * task kept local: the filter is the leader's. The receiving side here is the follower's store as
 * it is (task-replica-store.ts -> task-manager.applyTaskReplica -> its tasks.sqlite), unchanged by
 * the rule, behind a host target; the leader's rounds are the real ones (task-replica.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fsp from 'node:fs/promises'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-private-old', { CLOUD_MODE: true }))

import { WALNUT_HOME, TASKS_DIR } from '../../../src/constants.js'
import * as tm from '../../../src/core/task-manager.js'
import { closeDb } from '../../../src/core/task-db.js'
import { closeDb as closeSessionDb } from '../../../src/core/session-db.js'
import { _resetSessionTrackerForTesting } from '../../../src/core/session-tracker.js'
import { syncTaskReplica, _resetTaskReplicaForTesting, type TaskReplicaDeps } from '../../../src/core/replication/task-replica.js'
import * as store from '../../../src/core/replication/task-replica-store.js'
import { hostPrivacyOf } from '../../../src/core/replication/host-private.js'
import type { ReplicaTarget } from '../../../src/core/replication/replica-targets.js'
import type { Task } from '../../../src/core/types.js'

const NOW = '2026-11-21T08:00:00.000Z'
const HOLD = { target: 'acme', state: 'chosen', by: 'user', at: NOW } as const

function row(id: string, extra: Partial<Task> = {}): Task {
  return {
    id, title: `Task ${id}`, status: 'todo', phase: 'TODO', priority: 'none', project: 'Acme', source: 'local',
    session_ids: [], description: '', summary: '', note: '', created_at: NOW, updated_at: NOW, ...extra,
  } as Task
}

let primary: Task[] = []
/** Every row a put carried to the follower. */
let carried: string[] = []

const host: ReplicaTarget = {
  id: 'host:devbox', kind: 'host', label: 'devbox', available: async () => true,
  post: async (payload) => {
    const body = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
    if (Array.isArray(body.rows)) carried.push(...(body.rows as Task[]).map((t) => t.id))
    const r = body.op === 'sync' ? await store.replicaSync(body) : body.op === 'status' ? await store.replicaStatus(body) : await store.replicaPut(body)
    return r.ok ? { ok: true, reply: r } : { ok: false, outcome: 'failed', status: r.status, error: r.error }
  },
}

const deps: TaskReplicaDeps = {
  view: async () => ({ tasks: primary, registry: { projects: { Acme: { source: 'local', order_index: 0 } }, task_groups: {}, custom_tiers: [] } }),
  targets: () => [host],
  privacy: async (tasks) => hostPrivacyOf(tasks, []),
}

const held = async () => (await tm.listTasks()).map((t) => t.id).sort()

beforeEach(async () => {
  closeSessionDb()
  _resetSessionTrackerForTesting()
  closeDb()
  tm._resetForTesting()
  await fsp.rm(WALNUT_HOME, { recursive: true, force: true })
  await fsp.mkdir(TASKS_DIR, { recursive: true })
  store._resetTaskReplicaStoreForTesting()
  _resetTaskReplicaForTesting()
  carried = []
  primary = [row('open'), row('secret', { sync_hold: { ...HOLD } }), row('later')]
})

afterEach(() => {
  closeSessionDb()
  _resetSessionTrackerForTesting()
  closeDb()
  tm._resetForTesting()
})

describe('a follower of any build behind a host target', () => {
  it('never receives a task kept local; one made local after it was copied leaves at the next round', async () => {
    await syncTaskReplica(deps)
    expect(await held()).toEqual(['later', 'open'])
    expect(carried).not.toContain('secret')
    // Made local on the Mac: the next manifest no longer names it, and the follower's own removal takes it.
    primary = primary.map((t) => (t.id === 'later' ? { ...t, sync_hold: { ...HOLD }, updated_at: '2026-11-21T09:00:00.000Z' } : t))
    const r = await syncTaskReplica(deps)
    expect(r.find((x) => x.kind === 'tasks')).toMatchObject({ target: 'host:devbox', action: 'synced', removed: 1 })
    expect(await held()).toEqual(['open'])
    expect(carried.filter((id) => id !== 'open' && id !== 'later')).toEqual([])
    // Released (sent to its service again): back in the copy.
    primary = primary.map((t) => (t.id === 'later' ? { ...t, sync_hold: undefined, updated_at: '2026-11-21T10:00:00.000Z' } : t))
    await syncTaskReplica(deps)
    expect(await held()).toEqual(['later', 'open'])
  })
})
