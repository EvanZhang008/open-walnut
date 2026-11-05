/**
 * An op call's id end to end through the real server: the daemon gateway's tools.call
 * (capability-router.ts), the op executor's self-calls, the op-id middleware and its
 * ledger, and op_result.
 *
 * 2026-11-04: task_send came back `hub_timeout` though its message was delivered, and other
 * writes in the same window came back with nothing to read them by. A resend of a call under
 * its id now runs it once (also while the first copy still runs, and after a restart that
 * forgot the call), and op_result answers what it did.
 *
 * Real startServer({ port: 0, dev: true }); the gateway's executeOp reaches it through the
 * server's own API root.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs/promises'
import { vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-op-call-gateway-e2e'))

import { WALNUT_HOME } from '../../src/constants.js'
import { startServer, stopServer } from '../../src/web/server.js'
import { addTask, getTask } from '../../src/core/task-manager.js'
import { createSessionRecord } from '../../src/core/session-tracker.js'
import { handleGatewayCapability } from '../../src/core/peers/capability-router.js'
import { PeerThrottle } from '../../src/core/peers/peer-throttle.js'
import { _resetOpCallsForTesting } from '../../src/ops/op-calls.js'
import { newCallId } from '../../src/lib/op-call-id.js'

const SID = '33333333-2222-3333-4444-000000000001'
let taskId = ''

beforeAll(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  await startServer({ port: 0, dev: true })
  const { task } = await addTask({ title: 'Caller', project: 'acme' })
  taskId = task.id
  await createSessionRecord(SID, task.id, 'acme', '/repo/acme', { title: task.title })
}, 30_000)

afterAll(async () => {
  await stopServer()
  await fs.rm(WALNUT_HOME, { recursive: true, force: true }).catch(() => {})
})

const deps = () => ({ throttle: new PeerThrottle(), cloudMode: false })
const call = (name: string, args: Record<string, unknown>, callId?: string) =>
  handleGatewayCapability('tools.call', SID, { name, args, ...(callId ? { callId } : {}) }, '__local__', deps())
const entries = async () => ((await getTask(taskId)).note ?? '').split('\n').filter((l) => l.includes('entry-'))

describe('a gateway call under one id runs once', () => {
  it('twice in a row, at once, and after a restart that forgot the call: one note entry', async () => {
    const id = newCallId()
    const args = { id: taskId, content: 'entry-once', mode: 'append' }
    const first = await call('task_note_write', args, id)
    expect(first.ok).toBe(true)
    expect(await call('task_note_write', args, id)).toEqual(first)

    _resetOpCallsForTesting()
    const afterRestart = await call('task_note_write', args, id)
    expect(afterRestart.ok).toBe(true)
    expect((await entries()).filter((l) => l.includes('entry-once'))).toHaveLength(1)

    const id2 = newCallId()
    const both = await Promise.all([call('task_note_write', { ...args, content: 'entry-twin' }, id2), call('task_note_write', { ...args, content: 'entry-twin' }, id2)])
    expect(both[0]).toEqual(both[1])
    expect((await entries()).filter((l) => l.includes('entry-twin'))).toHaveLength(1)

    // Without an id, every call runs: nothing changes for an older client.
    await call('task_note_write', { ...args, content: 'entry-plain' })
    await call('task_note_write', { ...args, content: 'entry-plain' })
    expect((await entries()).filter((l) => l.includes('entry-plain'))).toHaveLength(2)
  })

  it('op_result reads the call: done with its answer, applied after a restart, unknown for one never sent', async () => {
    const id = newCallId()
    await call('task_note_write', { id: taskId, content: 'entry-read', mode: 'append' }, id)
    const done = await call('op_result', { call_id: id })
    expect(done.ok && done.result).toMatchObject({ call_id: id, state: 'done', op: 'task_note_write', ok: true })
    expect(done.ok && (done.result as { outcome: string }).outcome).toMatch(/ran and succeeded/)
    expect(done.ok && (done.result as { writes: unknown[] }).writes).toHaveLength(1)

    _resetOpCallsForTesting()
    const applied = await call('op_result', { call_id: id })
    expect(applied.ok && applied.result).toMatchObject({ state: 'applied', writes: [{ status: 200, outcome: 'applied' }] })

    const never = await call('op_result', { call_id: newCallId() })
    expect(never.ok && never.result).toMatchObject({ state: 'unknown', writes: [] })
    expect(never.ok && (never.result as { next: string }).next).toMatch(/Run it again/)
  })

  it('the same id with other arguments is refused and changes nothing', async () => {
    const id = newCallId()
    await call('task_note_write', { id: taskId, content: 'entry-a', mode: 'append' }, id)
    const other = await call('task_note_write', { id: taskId, content: 'entry-b', mode: 'append' }, id)
    expect(other.ok).toBe(false)
    expect((await entries()).some((l) => l.includes('entry-b'))).toBe(false)
  })

  it('a caller re-running a lost call with "_call_id" in the arguments gets the first answer', async () => {
    const id = newCallId()
    const first = await call('task_note_write', { id: taskId, content: 'entry-arg', mode: 'append' }, id)
    const again = await call('task_note_write', { id: taskId, content: 'entry-arg', mode: 'append', _call_id: id })
    expect(again).toEqual(first)
    expect((await entries()).filter((l) => l.includes('entry-arg'))).toHaveLength(1)
  })
})
