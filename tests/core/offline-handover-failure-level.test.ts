/**
 * Which replay failures become an error card (src/core/offline-handover.ts).
 *
 * A queued write the server refuses (validation, a guard) is the answer the same
 * call gets online: the caller is told and redoes it, so it is a warning. A write
 * the server never answered, or a record Walnut could not apply, is Walnut's own
 * failure: an error that names the session it concerns, so its card retires on
 * that session's next clean turn instead of never (2026-10-05 21:40Z).
 *
 * The op executor and the task store are stubbed: this pins the classification,
 * tests/integration/offline-handover.test.ts runs the real replay.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-level'))
const executeOp = vi.hoisted(() => vi.fn())
vi.mock('../../src/ops/index.js', () => ({ executeOp }))
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => ({ id, phase: 'IN_PROGRESS', updated_at: '2026-01-01T00:00:00.000Z' }),
}))
// The caller is gone: the notice step keeps only the log line.
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))

import { log } from '../../src/logging/index.js'
import { runOfflineHandover } from '../../src/core/offline-handover.js'
import { recoveryKeyOf } from '../../src/core/notifications/log-error-bridge.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'

const SID = 'eeeeeeee-5555-4555-8555-555555555555'

async function replay(records: OfflineRecord[]) {
  let drained = false
  return runOfflineHandover({
    hostKey: 'devbox',
    send: async (cmd) => {
      if (cmd !== 'offline.drain') return { ok: true }
      if (drained) return { ok: true, records: [] }
      drained = true
      return { ok: true, records }
    },
  })
}

const op = (seq: number): OfflineRecord => ({
  seq, at: Date.parse('2026-10-05T21:30:00.000Z'), kind: 'op', op: 'task_update',
  args: { id: 't-parked', phase: 'WAITING' }, callerSid: SID, base: '2026-01-01T00:00:00.000Z',
})

describe('offline handover failure level', () => {
  beforeEach(() => { executeOp.mockReset() })

  it('a refusal is a warning naming the write; no error line, so no card', async () => {
    executeOp.mockResolvedValue({ ok: false, message: 'Walnut API error (self_parent): a task cannot be its own parent' })
    const errors = vi.spyOn(log.session, 'error')
    const warns = vi.spyOn(log.session, 'warn')
    try {
      expect(await replay([op(1)])).toMatchObject({ failed: 1 })
      expect(errors.mock.calls.filter(([m]) => String(m).startsWith('offline handover'))).toEqual([])
      expect(warns).toHaveBeenCalledWith('offline handover: queued write refused', expect.objectContaining({
        op: 'task_update', taskId: 't-parked', callerSid: SID, error: expect.stringContaining('self_parent'),
      }))
    } finally { errors.mockRestore(); warns.mockRestore() }
  })

  it('no answer from the server is Walnut\'s failure: an error keyed to the caller\'s session', async () => {
    executeOp.mockResolvedValue({ ok: false, unreachable: true, message: 'fetch failed' })
    const errors = vi.spyOn(log.session, 'error')
    try {
      expect(await replay([op(2)])).toMatchObject({ failed: 1 })
      const lines = errors.mock.calls.filter(([m]) => String(m) === 'offline handover: record failed')
      expect(lines).toHaveLength(1)
      const meta = lines[0][1] as Record<string, unknown>
      expect(meta).toMatchObject({ kind: 'op', sessionId: SID, taskId: 't-parked', error: 'fetch failed' })
      expect(recoveryKeyOf({ subsystem: 'session', message: 'offline handover: record failed', meta })).toBe(`session:${SID}`)
    } finally { errors.mockRestore() }
  })
})
