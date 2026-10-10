/**
 * A model or effort the cloud companion applied to a live session on a host
 * while it led (a `settings` record in the host's journal) is kept on the
 * session's record when the Mac drains that host (src/core/offline-handover.ts),
 * and a live session object on the Mac adopts it rather than write the older
 * values back.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-settings'))
const updateSessionRecord = vi.hoisted(() => vi.fn(async () => undefined))
const adoptAppliedSettings = vi.hoisted(() => vi.fn())
const findByClaudeId = vi.hoisted(() => vi.fn())
const record = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))
const persistSessionModeChange = vi.hoisted(() => vi.fn(async () => undefined))
const flush = vi.hoisted(() => vi.fn(async () => undefined))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => record.current, updateSessionRecord }))
vi.mock('../../src/providers/claude-code-session.js', () => ({ sessionRunner: { findByClaudeId } }))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))
vi.mock('../../src/core/sessions/session-lifecycle.js', () => ({ persistSessionModeChange }))
vi.mock('../../src/core/sessions/session-stop.js', () => ({ sessionStops: { flush } }))

import { runOfflineHandover } from '../../src/core/offline-handover.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'

const SID = 'bbbbbbbb-2222-4222-8222-222222222222'

async function replay(records: OfflineRecord[]) {
  let drained = false
  const acks: number[] = []
  const result = await runOfflineHandover({
    hostKey: 'devbox',
    send: async (cmd, params) => {
      if (cmd === 'offline.ack') { acks.push(Number(params?.upTo)); return { ok: true } }
      if (drained) return { ok: true, records: [] }
      drained = true
      return { ok: true, records }
    },
  })
  return { result, acks }
}

const settings = (seq: number, over: Partial<Extract<OfflineRecord, { kind: 'settings' }>>): OfflineRecord =>
  ({ seq, at: Date.parse('2026-10-07T21:30:00.000Z'), kind: 'settings', sid: SID, ...over }) as OfflineRecord

describe('offline handover: settings the companion applied', () => {
  beforeEach(() => {
    updateSessionRecord.mockClear()
    adoptAppliedSettings.mockClear()
    findByClaudeId.mockReset()
    persistSessionModeChange.mockClear()
    flush.mockClear()
    record.current = null
  })

  it('a model and an effort land on the record, in order, and are acked', async () => {
    findByClaudeId.mockReturnValue(undefined)
    const { result, acks } = await replay([settings(1, { cliModel: 'sonnet[1m]' }), settings(2, { effort: 'low' })])
    expect(result).toMatchObject({ records: 2, replayed: 2, failed: 0 })
    expect(updateSessionRecord.mock.calls).toEqual([[SID, { cliModel: 'sonnet[1m]' }], [SID, { effort: 'low' }]])
    expect(acks).toEqual([2])
  })

  it('a live session object here adopts them, so it never writes the older values back, and reads back what the CLI runs', async () => {
    const refreshAppliedSettings = vi.fn(async () => null)
    findByClaudeId.mockReturnValue({ adoptAppliedSettings, refreshAppliedSettings })
    await replay([settings(1, { cliModel: 'haiku', effort: 'high' })])
    expect(adoptAppliedSettings).toHaveBeenCalledWith({ cliModel: 'haiku', effort: 'high' })
    expect(refreshAppliedSettings).toHaveBeenCalledWith('companion-settings')
  })

  it('a read-back that fails changes nothing and fails nothing', async () => {
    findByClaudeId.mockReturnValue({ adoptAppliedSettings, refreshAppliedSettings: vi.fn(async () => { throw new Error('cli gone') }) })
    const { result } = await replay([settings(1, { effort: 'low' })])
    expect(result).toMatchObject({ replayed: 1, failed: 0 })
  })

  it('an unknown effort is dropped, and a record with nothing valid writes nothing', async () => {
    findByClaudeId.mockReturnValue(undefined)
    const { result } = await replay([settings(1, { effort: 'turbo' }), settings(2, { cliModel: 'opus', effort: 'turbo' })])
    expect(updateSessionRecord.mock.calls).toEqual([[SID, { cliModel: 'opus' }]])
    expect(result).toMatchObject({ failed: 0 })
  })
})

describe('offline handover: a mode and a stop the companion sent', () => {
  const STOP = 'aaaaaaaa-1111-4111-8111-111111111111'
  const stop = (seq: number, requestedAt = '2026-10-10T10:00:00.000Z'): OfflineRecord =>
    ({ seq, at: Date.parse(requestedAt), kind: 'stop', sid: SID, stopRequestId: STOP, requestedAt }) as OfflineRecord

  beforeEach(() => {
    updateSessionRecord.mockClear()
    adoptAppliedSettings.mockClear()
    findByClaudeId.mockReset()
    persistSessionModeChange.mockClear()
    flush.mockClear()
    record.current = { claudeSessionId: SID, host: 'devbox', mode: 'default' }
  })

  it('a mode goes the way of the Mac\'s own mode change, and a live object here takes it', async () => {
    findByClaudeId.mockReturnValue({ adoptAppliedSettings, refreshAppliedSettings: vi.fn(async () => null) })
    const { result } = await replay([settings(1, { mode: 'plan' })])
    expect(result).toMatchObject({ replayed: 1, failed: 0 })
    expect(persistSessionModeChange).toHaveBeenCalledWith(record.current, SID, 'plan')
    expect(updateSessionRecord).not.toHaveBeenCalled()
    expect(adoptAppliedSettings).toHaveBeenCalledWith({ mode: 'plan' })
  })

  it('an unknown mode is dropped', async () => {
    findByClaudeId.mockReturnValue(undefined)
    await replay([settings(1, { mode: 'yolo' })])
    expect(persistSessionModeChange).not.toHaveBeenCalled()
  })

  it('a stop becomes this server\'s own pending stop (same id and time), and the host\'s stops then run', async () => {
    findByClaudeId.mockReturnValue(undefined)
    const { result, acks } = await replay([stop(1)])
    expect(result).toMatchObject({ replayed: 1, failed: 0 })
    expect(updateSessionRecord).toHaveBeenCalledWith(SID, { stopRequest: { id: STOP, requestedAt: '2026-10-10T10:00:00.000Z', state: 'pending' } })
    expect(flush).toHaveBeenCalledWith('devbox')
    expect(acks).toEqual([1])
  })

  it('a stop this server already has, or an older one than its own, is skipped and runs nothing', async () => {
    findByClaudeId.mockReturnValue(undefined)
    record.current = { claudeSessionId: SID, host: 'devbox', stopRequest: { id: STOP, requestedAt: '2026-10-10T10:00:00.000Z', state: 'confirmed' } }
    expect((await replay([stop(1)])).result).toMatchObject({ skipped: 1, replayed: 0 })
    record.current = { claudeSessionId: SID, host: 'devbox', stopRequest: { id: 'other', requestedAt: '2026-10-10T11:00:00.000Z', state: 'confirmed' } }
    expect((await replay([stop(1)])).result).toMatchObject({ skipped: 1, replayed: 0 })
    expect(updateSessionRecord).not.toHaveBeenCalled()
    expect(flush).not.toHaveBeenCalled()
  })

  it('stops that cannot run yet fail nothing: they stay pending on the record', async () => {
    findByClaudeId.mockReturnValue(undefined)
    flush.mockRejectedValueOnce(new Error('host gone'))
    const { result } = await replay([stop(1)])
    expect(result).toMatchObject({ replayed: 1, failed: 0 })
  })
})
