/**
 * A trigger pause, resume or delete a host took while the server was away
 * (offline-triggers-v1) is replayed on the server through the same op, in the
 * host's order, with the caller's identity (src/core/offline-handover.ts).
 *
 * A trigger id is a routine's, not a task's: the replay must not go through the
 * task write path (which looks the id up as a task, finds nothing, and drops the
 * write as "the task no longer exists"), and a failed one must not name a task.
 * The op executor is stubbed; tests/integration/offline-triggers-twins.test.ts
 * runs the host side for real.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-triggers'))
const executeOp = vi.hoisted(() => vi.fn())
const getTask = vi.hoisted(() => vi.fn(async () => { throw new Error('a trigger write never reads a task') }))
vi.mock('../../src/ops/index.js', () => ({ executeOp }))
vi.mock('../../src/core/task-manager.js', () => ({ getTask }))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))

import { log } from '../../src/logging/index.js'
import { runOfflineHandover } from '../../src/core/offline-handover.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'

const SID = 'eeeeeeee-6666-4666-8666-666666666666'
const def = { id: 'mtrigpr0-0001', name: 'PR watch', everyMs: 300_000, check: { run: 'sh check.sh' } }

async function replay(records: OfflineRecord[]) {
  let drained = false
  const acks: number[] = []
  const result = await runOfflineHandover({
    hostKey: 'devbox',
    send: async (cmd, params) => {
      if (cmd === 'offline.ack') { acks.push(Number(params?.upTo)); return { ok: true } }
      if (cmd !== 'offline.drain') return { ok: true }
      if (drained) return { ok: true, records: [] }
      drained = true
      return { ok: true, records }
    },
  })
  return { result, acks }
}

const rec = (seq: number, op: string, id = def.id): OfflineRecord => ({
  seq, at: Date.parse('2026-10-13T21:30:00.000Z'), kind: 'op', op, args: { id }, callerSid: SID, trigger: { ...def, id },
})

describe('offline handover: trigger changes made on a host', () => {
  beforeEach(() => { executeOp.mockReset(); getTask.mockClear() })

  it('replays each through its op, in order, as the caller, and acks them', async () => {
    executeOp.mockResolvedValue({ ok: true, result: {} })
    const { result, acks } = await replay([rec(1, 'trigger_pause'), rec(2, 'trigger_resume'), rec(3, 'trigger_delete', 'mtrigci0-0002')])
    expect(result).toMatchObject({ records: 3, replayed: 3, failed: 0 })
    expect(executeOp.mock.calls.map(([name, args, ctx]) => [name, args, ctx.callerSid, ctx.callerHost])).toEqual([
      ['trigger_pause', { id: def.id }, SID, 'devbox'],
      ['trigger_resume', { id: def.id }, SID, 'devbox'],
      ['trigger_delete', { id: 'mtrigci0-0002' }, SID, 'devbox'],
    ])
    expect(getTask).not.toHaveBeenCalled()
    expect(acks).toEqual([3])
  })

  it('a refusal (the routine is gone) is the caller\'s to hear, and names no task', async () => {
    executeOp.mockResolvedValue({ ok: false, message: 'Walnut API error (not_found): no routine mtrigpr0-0001' })
    const warns = vi.spyOn(log.session, 'warn')
    try {
      expect((await replay([rec(4, 'trigger_delete')])).result).toMatchObject({ failed: 1 })
      expect(warns).toHaveBeenCalledWith('offline handover: queued write refused', expect.objectContaining({ op: 'trigger_delete', callerSid: SID }))
    } finally { warns.mockRestore() }
  })

  it('no answer is Walnut\'s own failure, keyed to the caller\'s session and not to a task', async () => {
    executeOp.mockResolvedValue({ ok: false, unreachable: true, message: 'fetch failed' })
    const errors = vi.spyOn(log.session, 'error')
    try {
      await replay([rec(5, 'trigger_pause')])
      const line = errors.mock.calls.find(([m]) => String(m) === 'offline handover: record failed')
      expect(line?.[1]).toMatchObject({ kind: 'op', sessionId: SID })
      expect((line?.[1] as Record<string, unknown>).taskId).toBeUndefined()
    } finally { errors.mockRestore() }
  })
})
