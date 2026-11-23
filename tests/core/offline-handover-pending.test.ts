/**
 * A drain says whether this home's journal is empty after it (HandoverResult.pending,
 * src/core/offline-handover.ts; review round 3, S2). A service set move flips only on an
 * empty journal: a record the shared daemon still keeps is never drained once the link
 * reaches the set, a lost offline write.
 *
 * Pending: a record waiting out its retry backoff, a kind this Mac does not take, the rounds
 * running out. Not pending: everything applied, or refused into the letter and acked (counted
 * in `failed`, but off the journal: review round 3, L-M1).
 *
 * What's real: the handover's rounds and takes against a fake host journal that keeps every
 * record until it is acked (v1 watermark acks). The op executor and the task store are stubbed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-pending'))
const executeOp = vi.hoisted(() => vi.fn())
vi.mock('../../src/ops/index.js', () => ({ executeOp }))
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => ({ id, phase: 'IN_PROGRESS', updated_at: '2026-01-01T00:00:00.000Z' }),
}))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))

import { runOfflineHandover, _resetOfflineHandoverForTesting } from '../../src/core/offline-handover.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'

const SID = 'ffffffff-6666-4666-8666-666666666666'
let hostN = 0

/** A host journal: drain hands over what is not acked yet, an ack by watermark removes it. */
function host(records: OfflineRecord[], more?: () => OfflineRecord[]) {
  let kept = records.slice()
  const conn = {
    hostKey: `pending-host-${++hostN}`,
    // The scheduled retry of a waiting record never runs here.
    alive: () => false,
    send: async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === 'offline.drain') { if (more) kept.push(...more()); return { ok: true, records: kept } }
      if (cmd === 'offline.ack') { const upTo = Number(params?.upTo); kept = kept.filter((r) => r.seq > upTo) }
      return { ok: true }
    },
  }
  return { conn, kept: () => kept }
}

const op = (seq: number, task = `t-${seq}`): OfflineRecord => ({
  seq, at: Date.parse('2026-10-05T21:30:00.000Z'), kind: 'op', op: 'task_update',
  args: { id: task, phase: 'WAITING' }, callerSid: SID, base: '2026-01-01T00:00:00.000Z',
})

describe('S2: a drain says whether records of this home are still on the host', () => {
  beforeEach(() => { executeOp.mockReset(); _resetOfflineHandoverForTesting() })
  afterEach(() => _resetOfflineHandoverForTesting())

  it('everything applied: the last read found it empty, nothing pending', async () => {
    executeOp.mockResolvedValue({ ok: true })
    const h = host([op(1), op(2)])
    const r = await runOfflineHandover(h.conn)
    expect(r).toMatchObject({ records: 2, failed: 0 })
    expect(r.pending).toBeUndefined()
    expect(h.kept()).toEqual([])
  })

  it('L-M1: a write the server refused is lettered and acked: counted failed, yet the journal is empty', async () => {
    executeOp.mockResolvedValue({ ok: false, message: 'Walnut API error (self_parent): a task cannot be its own parent' })
    const h = host([op(3)])
    const r = await runOfflineHandover(h.conn)
    expect(r).toMatchObject({ failed: 1 })
    expect(r.pending).toBeUndefined()
    expect(h.kept()).toEqual([])
  })

  it('a record waiting out its retry backoff keeps the journal pending', async () => {
    executeOp.mockResolvedValue({ ok: false, unreachable: true, message: 'fetch failed' })
    const h = host([op(4), op(5)])
    const first = await runOfflineHandover(h.conn)
    expect(first.pending).toBe(true)
    expect(h.kept().map((r) => r.seq)).toEqual([4, 5])
    // The next drain inside the backoff takes nothing and counts nothing failed: still pending.
    executeOp.mockResolvedValue({ ok: true })
    const again = await runOfflineHandover(h.conn)
    expect(again).toMatchObject({ failed: 0 })
    expect(again.pending).toBe(true)
    expect(h.kept().map((r) => r.seq)).toEqual([4, 5])
  })

  it('a kind this Mac does not take is left on the host: pending', async () => {
    executeOp.mockResolvedValue({ ok: true })
    const h = host([op(6), { seq: 7, at: Date.now(), kind: 'from-a-newer-build' } as unknown as OfflineRecord])
    const r = await runOfflineHandover(h.conn)
    expect(r.failed).toBe(0)
    expect(r.pending).toBe(true)
    expect(h.kept().map((r) => r.seq)).toEqual([7])
  })

  it('a host that keeps handing new records outlasts the rounds: pending', async () => {
    executeOp.mockResolvedValue({ ok: true })
    let seq = 100
    const h = host([], () => [op(++seq)])
    const r = await runOfflineHandover(h.conn)
    expect(r.rounds).toBe(10)
    expect(r.failed).toBe(0)
    expect(r.pending).toBe(true)
  })
})
