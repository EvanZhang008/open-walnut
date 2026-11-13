/**
 * A message or a memory write a host held while the Walnut server was away
 * (offline-host-core.ts holdWrite, MAC_DRAINS `held-op`) is replayed on the server through
 * the same op, once, as the session that made it, under the record's own call id
 * (src/core/offline-handover.ts). The op executor is stubbed; the host side is
 * tests/providers/offline-host-held-writes.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-held'))
const executeOp = vi.hoisted(() => vi.fn())
const getTask = vi.hoisted(() => vi.fn(async () => { throw new Error('a held write never reads a task') }))
vi.mock('../../src/ops/index.js', () => ({ executeOp }))
vi.mock('../../src/core/task-manager.js', () => ({ getTask }))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))

import { log } from '../../src/logging/index.js'
import { runOfflineHandover } from '../../src/core/offline-handover.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'

const SID = 'eeeeeeee-6666-4666-8666-666666666666'

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

const held = (seq: number, op: string, args: Record<string, unknown>): OfflineRecord => ({
  seq, at: Date.parse('2026-11-13T04:01:00.000Z'), kind: 'op', op, args, callerSid: SID, opId: `held-call-${seq}`,
} as OfflineRecord)

describe('offline handover: writes a host held for the server', () => {
  beforeEach(() => { executeOp.mockReset(); getTask.mockClear() })

  it('replays each once through its op, as the caller, under its own call id, and acks them', async () => {
    executeOp.mockResolvedValue({ ok: true, result: {} })
    const { result, acks } = await replay([
      held(1, 'task_send', { task: 'msjfj3no', message: 'The CR is out', messageId: 'qm-host-call-1' }),
      held(2, 'task_send', { in_reply_to: ['rq-111111', 'rq-222222'], title: 'Done', text: 'Landed', messageId: 'qm-host-call-2' }),
      held(3, 'agent_memory_write', { content: 'land tonight', task: 'mtaskaaa-0001' }),
    ])
    expect(result).toMatchObject({ records: 3, replayed: 3, failed: 0 })
    expect(executeOp.mock.calls.map(([name, args, ctx]) => [name, (args as Record<string, unknown>).messageId ?? null, ctx.callerSid, ctx.callerHost])).toEqual([
      ['task_send', 'qm-host-call-1', SID, 'devbox'],
      ['task_send', 'qm-host-call-2', SID, 'devbox'],
      ['agent_memory_write', null, SID, 'devbox'],
    ])
    // Each under its own call id: a replay after a lost answer meets the first one's writes.
    const ids = executeOp.mock.calls.map(([, , ctx]) => ctx.callId)
    expect(ids.every((id) => typeof id === 'string' && id.length > 0)).toBe(true)
    expect(new Set(ids).size).toBe(3)
    expect(getTask).not.toHaveBeenCalled()
    expect(acks).toEqual([3])
  })

  it('a write held under its caller\'s call id replays under that id, so the caller\'s own retry meets it', async () => {
    executeOp.mockResolvedValue({ ok: true, result: {} })
    const rec = { ...held(6, 'agent_memory_write', { content: 'land tonight', task: 'mtaskaaa-0001' }), callId: 'oc-abcdef12_3456' } as OfflineRecord
    await replay([rec])
    expect(executeOp.mock.calls[0][2].callId).toBe('oc-abcdef12_3456')
    // A board write with a call id on it still goes under the journal's own (only held writes carry one).
    executeOp.mockClear()
    await replay([{ ...held(7, 'board_edit', { task: 'mtaskaaa-0001' }), callId: 'oc-abcdef12_3456' } as OfflineRecord])
    expect(executeOp.mock.calls[0][2].callId).not.toBe('oc-abcdef12_3456')
  })

  it('a server that cannot take it now keeps it for a retry; a refusal is told to the caller and names no target task', async () => {
    executeOp.mockResolvedValue({ ok: false, unreachable: true, message: 'fetch failed' })
    expect((await replay([held(4, 'task_send', { task: 'msjfj3no', message: 'hi' })])).acks).toEqual([])
    executeOp.mockResolvedValue({ ok: false, message: 'Walnut API error (not_found): no task msjfj3no' })
    const warns = vi.spyOn(log.session, 'warn')
    try {
      const refused = await replay([held(5, 'task_send', { task: 'msjfj3no', message: 'hi' })])
      expect(refused.result).toMatchObject({ failed: 1 })
      expect(refused.acks).toEqual([5])
      const line = warns.mock.calls.find(([m]) => String(m) === 'offline handover: queued write refused')
      expect(line?.[1]).toMatchObject({ op: 'task_send', callerSid: SID })
      expect((line?.[1] as Record<string, unknown>).taskId).toBeUndefined()
    } finally { warns.mockRestore() }
  })
})
