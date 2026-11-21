/**
 * The copies a host's daemon takes go through the one kept-local filter too
 * (core/replication/host-private.ts; every such copy is listed in providers/daemon-twin-state.ts and
 * held to it by host-private-guard.test.ts):
 *   host.slice          (core/host-slice.ts) the daemon's read copy: no row of a kept task, nor of a
 *                       subtask under one, nor its Board or a request of its own; only a kept task
 *                       whose own session runs on the host keeps its row and its session there
 *   triggers.configure  (core/routines/trigger-push.ts) a check still runs on its host, but what it
 *                       delivers to a kept task (the target and the prompt) stays off a host none of
 *                       that task's sessions run on
 * The stores are real; only which tasks hold a hold is set here (sync_hold is the private-tasks
 * module's own field, written by its flows).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-private-daemon', { CLOUD_MODE: false }))

const HOLD = { target: 'acme', state: 'chosen', at: '2026-11-21T00:00:00.000Z' }
const held = new Set<string>()
vi.mock('../../../src/core/replication/host-private.js', async (orig) => {
  const actual = await orig<typeof import('../../../src/core/replication/host-private.js')>()
  return {
    ...actual,
    hostPrivacyNow: async () => {
      const { taskStoreForReplica } = await import('../../../src/core/task-manager.js')
      return actual.hostPrivacyNow((await taskStoreForReplica()).tasks.map((t) => (held.has(t.id) ? { ...t, sync_hold: HOLD } : t)))
    },
  }
})

import { WALNUT_HOME } from '../../../src/constants.js'
import { addTask } from '../../../src/core/task-manager.js'
import { createSessionRecord } from '../../../src/core/session-tracker.js'
import { createSessionRequest } from '../../../src/core/session-requests.js'
import { setBoardHtml } from '../../../src/core/boards/board-store.js'
import { buildHostSlice } from '../../../src/core/host-slice.js'
import { compileTriggerDefs } from '../../../src/core/routines/trigger-push.js'
import type { CronJob } from '../../../src/core/cron/types.js'

beforeEach(async () => {
  held.clear()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
})

describe('the daemon\'s read copy (host.slice) leaves a kept task out', () => {
  it('its row, its subtasks, its Board and its requests; a kept task whose own session runs here keeps its row', async () => {
    const lead = (await addTask({ title: 'Team lead', project: 'Work' })).task
    const kept = (await addTask({ title: 'Appraisal notes', project: 'Work', parent_task_id: lead.id, description: 'private words' })).task
    const keptChild = (await addTask({ title: 'Appraisal follow-up', project: 'Work', parent_task_id: kept.id })).task
    const open = (await addTask({ title: 'Open worker', project: 'Work', parent_task_id: lead.id })).task
    const keptHere = (await addTask({ title: 'Kept, runs here', project: 'Work', parent_task_id: lead.id })).task
    const [sLead, sOpen, sKeptHere, sKeptMac] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    await createSessionRecord(sLead, lead.id, 'Work', WALNUT_HOME, { host: 'devbox' })
    await createSessionRecord(sOpen, open.id, 'Work', WALNUT_HOME, { host: 'devbox' })
    await createSessionRecord(sKeptHere, keptHere.id, 'Work', WALNUT_HOME, { host: 'devbox' })
    await createSessionRecord(sKeptMac, kept.id, 'Work', WALNUT_HOME)
    await setBoardHtml(keptHere.id, '<html><body>kept board</body></html>', { by: `task:${keptHere.id}` })
    await setBoardHtml(lead.id, '<html><body>team board</body></html>', { by: `task:${lead.id}` })
    const toKept = await createSessionRequest({ fromSessionId: sLead, toSessionId: sKeptMac, toTaskId: kept.id, text: 'about the appraisal' })
    const fromKeptHere = await createSessionRequest({ fromSessionId: sKeptHere, toSessionId: sLead, text: 'kept asks' })
    const toOpen = await createSessionRequest({ fromSessionId: sLead, toSessionId: sOpen, toTaskId: open.id, text: 'open ask' })

    const before = await buildHostSlice('devbox')
    expect(before.tasks.map((t) => t.id)).toEqual(expect.arrayContaining([kept.id, keptChild.id, keptHere.id]))

    held.add(kept.id).add(keptHere.id)
    const slice = await buildHostSlice('devbox')
    const ids = slice.tasks.map((t) => t.id)
    expect(ids).toEqual(expect.arrayContaining([lead.id, open.id, keptHere.id]))
    expect(ids, 'a kept task and its subtask with no hold of its own').not.toContain(kept.id)
    expect(ids).not.toContain(keptChild.id)
    expect(JSON.stringify(slice), 'no word of the kept task').not.toContain('private words')
    expect(slice.sessions.map((s) => s.sid).sort()).toEqual([sLead, sOpen, sKeptHere].sort())
    expect(slice.boards.map((b) => b.taskId), 'the kept task\'s board stays off, the team\'s goes').toEqual([lead.id])
    expect(slice.boardOf[keptHere.id]).toBeUndefined()
    expect(slice.boardOf[open.id]).toBe(lead.id)
    expect(slice.requests.map((r) => r.id)).toEqual([toOpen.id])
    expect(slice.requests.map((r) => r.id)).not.toContain(toKept.id)
    expect(slice.requests.map((r) => r.id)).not.toContain(fromKeptHere.id)

    // Its hold cleared: everything comes back with the next copy.
    held.clear()
    const back = await buildHostSlice('devbox')
    expect(back.tasks.map((t) => t.id)).toEqual(expect.arrayContaining([kept.id, keptChild.id]))
    expect(back.requests.map((r) => r.id).sort()).toEqual([toKept.id, fromKeptHere.id, toOpen.id].sort())
  })
})

describe('the daemon\'s checks (triggers.configure) deliver nothing of a kept task', () => {
  const job = (id: string, target: string): CronJob => ({
    id, name: `check ${id}`, enabled: true, schedule: { kind: 'every', everyMs: 60_000 },
    check: { run: 'test -f /tmp/x', host: 'devbox' },
    executor: { type: 'session', config: { target, prompt: 'look at it' } },
    state: {},
  } as unknown as CronJob)

  it('the check still runs on its host, without the target and the prompt of a kept task', () => {
    const { payload } = compileTriggerDefs([job('a', 'kept-task'), job('b', 'open-task')], 'devbox', [], (id) => id === 'kept-task')
    const byId = Object.fromEntries(payload.triggers.map((d) => [d.id, d]))
    expect(byId.a!.check.run).toBe('test -f /tmp/x')
    expect(byId.a!.deliver).toBeUndefined()
    expect(byId.b!.deliver).toMatchObject({ taskId: 'open-task', prompt: 'look at it' })
    // Nothing kept: the very set as before, hash included.
    const plain = compileTriggerDefs([job('a', 'kept-task'), job('b', 'open-task')], 'devbox')
    expect(plain.payload.triggers.find((d) => d.id === 'a')!.deliver).toMatchObject({ taskId: 'kept-task' })
    expect(compileTriggerDefs([job('a', 'kept-task'), job('b', 'open-task')], 'devbox', [], () => false).hash).toBe(plain.hash)
  })
})
