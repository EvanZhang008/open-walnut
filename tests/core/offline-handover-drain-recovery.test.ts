/**
 * An error a host's journal drain logs while a record waits for its retry is retired by the
 * drain itself once no record waits (src/core/offline-merge/drain-recovery.ts).
 *
 * 2026-11-21: a queued trigger_create timed out once on a busy server (POST /routines/trigger
 * over 10 s) and applied on its retry 10 s later, but its card was keyed to the caller's session,
 * which had parked on the trigger it made: no clean turn ever retired it, and Walnut Health
 * raised "Background errors keep happening" for 40 minutes over an error that had healed.
 *
 * The real log-error bridge and notification store run here; only the op executor is stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-handover-drain-recovery'))
const executeOp = vi.hoisted(() => vi.fn())
vi.mock('../../src/ops/index.js', () => ({ executeOp }))
vi.mock('../../src/core/task-manager.js', () => ({
  getTask: async (id: string) => ({ id, phase: 'IN_PROGRESS', updated_at: '2026-01-01T00:00:00.000Z' }),
}))
vi.mock('../../src/core/session-tracker.js', () => ({ getSessionByClaudeId: async () => null }))
vi.mock('../../src/core/sessions/session-send-core.js', () => ({ deliverToSession: vi.fn() }))

import { readFileSync } from 'node:fs'
import { runOfflineHandover, _setHandoverBackoffForTesting, _resetOfflineHandoverForTesting } from '../../src/core/offline-handover.js'
import { _resetDrainRecoveryForTesting, drainRecoveryKey, noteDrainSettled } from '../../src/core/offline-merge/drain-recovery.js'
import { installLogErrorNotifications, uninstallLogErrorNotifications } from '../../src/core/notifications/log-error-bridge.js'
import { listNotifications } from '../../src/core/notifications/store.js'
import { RefusedWrite, replayFailure } from '../../src/core/offline-merge/patch-check.js'
import type { OfflineRecord } from '../../src/providers/offline-host-core.js'

const SID = 'eeeeeeee-7777-4777-8777-777777777777'
const SID_B = 'eeeeeeee-7777-4777-8777-77777777777b'
const SID_C = 'eeeeeeee-7777-4777-8777-77777777777c'
const HOST = 'devbox'
const TIMEOUT = { ok: false, lost: true, message: 'Walnut request timed out after 10000ms: POST /routines/trigger' }

const op = (seq: number, callerSid = SID): OfflineRecord => ({
  seq, at: Date.parse('2026-11-21T08:03:00.000Z'), kind: 'op', op: 'task_update',
  args: { id: `t-${seq}`, phase: 'WAITING' }, callerSid, base: '2026-01-01T00:00:00.000Z',
})

/** A host that hands over `records` until they are acked, and counts its drains. */
function host(records: OfflineRecord[]) {
  let pending = [...records]
  const conn = {
    hostKey: HOST,
    drains: 0,
    alive: () => true,
    send: async (cmd: string, params?: Record<string, unknown>) => {
      if (cmd === 'offline.ack') {
        const upTo = Number(params?.upTo)
        pending = pending.filter((r) => r.seq > upTo)
        return { ok: true }
      }
      if (cmd !== 'offline.drain') return { ok: true }
      conn.drains++
      return { ok: true, records: pending }
    },
  }
  return conn
}

/** The drain's error cards, of one caller's session when named. */
async function cards(sid?: string) {
  return (await listNotifications()).feed.filter((n) => n.kind === 'operation-error'
    && /record failed/i.test(n.title + (n.detail ?? '')) && (!sid || n.sessionId === sid))
}

describe('offline handover: the drain retires the errors its retries raised', () => {
  beforeEach(() => {
    executeOp.mockReset()
    _resetOfflineHandoverForTesting()
    // The retry here comes 20 ms after the failure; the bridge's card write gets 300 ms first.
    _resetDrainRecoveryForTesting(300)
    _setHandoverBackoffForTesting([20, 20, 20])
    installLogErrorNotifications()
  })
  afterEach(() => {
    uninstallLogErrorNotifications()
    _setHandoverBackoffForTesting(null)
  })

  it('a record that timed out once and applied on its retry leaves no open card', async () => {
    executeOp.mockResolvedValueOnce(TIMEOUT).mockResolvedValue({ ok: true, result: {} })
    const conn = host([op(4716)])
    expect(await runOfflineHandover(conn)).toMatchObject({ failed: 1 })
    // The bridge wrote the card, keyed to the drain of this host (not only to the caller's session).
    await vi.waitFor(async () => expect(await cards(SID)).toHaveLength(1), { timeout: 5000 })
    const [card] = await cards(SID)
    expect(card).toMatchObject({ recoveryKey: drainRecoveryKey(HOST), sessionId: SID })
    expect(card.resolved).toBeFalsy()
    // The scheduled retry applies it; that drain ends with nothing waiting.
    await vi.waitFor(async () => expect((await cards(SID))[0]?.resolved).toBe('recovered'), { timeout: 5000 })
    expect(conn.drains).toBeGreaterThanOrEqual(2)
  })

  it('while the record still waits, its card stays open', async () => {
    executeOp.mockResolvedValue(TIMEOUT)
    _setHandoverBackoffForTesting([60_000, 60_000, 60_000])
    await runOfflineHandover(host([op(1, SID_C)]))
    await vi.waitFor(async () => expect(await cards(SID_C)).toHaveLength(1), { timeout: 5000 })
    // That drain ended with the record waiting: nothing retires its card (noteDrainSettled never runs).
    expect((await cards(SID_C))[0].resolved).toBeFalsy()
  })

  it('a record given up logs its error under the session, which no drain retires', async () => {
    // In production the give-up comes minutes after attempt 1 and refreshes the same card
    // (recoveryKey is a refreshable key, notifications/store.ts), so the card follows the session.
    const { log } = await import('../../src/logging/index.js')
    const { recoveryKeyOf } = await import('../../src/core/notifications/log-error-bridge.js')
    const errors = vi.spyOn(log.session, 'error')
    try {
      executeOp.mockResolvedValue(TIMEOUT)
      _setHandoverBackoffForTesting([5])
      const conn = host([op(2, SID_B)])
      await runOfflineHandover(conn)
      await vi.waitFor(() => expect(errors.mock.calls.filter(([m]) => m === 'offline handover: record failed')).toHaveLength(2), { timeout: 5000 })
      const [retrying, givenUp] = errors.mock.calls.filter(([m]) => m === 'offline handover: record failed')
        .map(([message, meta]) => recoveryKeyOf({ subsystem: 'session', message: String(message), meta: meta as Record<string, unknown> }))
      expect(retrying).toBe(drainRecoveryKey(HOST))
      expect(givenUp).toBe(`session:${SID_B}`)
    } finally { errors.mockRestore() }
  })

  it('a card an earlier process left is retired by the first clean drain after boot, then the check costs nothing', async () => {
    const { upsertNotification } = await import('../../src/core/notifications/store.js')
    await upsertNotification({
      kind: 'operation-error', severity: 'error', title: 'Offline handover: record failed', body: 'x',
      dedupKey: 'logerr:session:earlier', recoveryKey: drainRecoveryKey(HOST), category: 'Sessions',
    })
    const earlier = async () => (await listNotifications()).feed.find((n) => n.dedupKey === 'logerr:session:earlier')
    executeOp.mockResolvedValue({ ok: true, result: {} })
    await runOfflineHandover(host([op(3)]))
    await vi.waitFor(async () => expect((await earlier())?.resolved).toBe('recovered'), { timeout: 5000 })
    const store = await import('../../src/core/notifications/store.js')
    const spy = vi.spyOn(store, 'recoverNotifications')
    await noteDrainSettled(HOST)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

/**
 * The class guard: every error the drain logs while a record waits for a retry (`retryInMs` in
 * its meta) names the drain's condition, or nothing retires it once the retry succeeds. Read from
 * the source, so a new retrying error line without it fails here.
 */
describe('offline handover: retrying error lines name the drain condition', () => {
  it('every log.session.error with retryInMs in src/core/offline-handover.ts carries recoveryKey: drainRecoveryKey(host)', () => {
    const src = readFileSync(new URL('../../src/core/offline-handover.ts', import.meta.url), 'utf8')
    const calls = errorCalls(src)
    const retrying = calls.filter((c) => /\bretryInMs\b/.test(c))
    expect(retrying.length).toBeGreaterThanOrEqual(2)
    for (const c of retrying) expect(c, c.slice(0, 160)).toMatch(/recoveryKey:\s*drainRecoveryKey\(host\)/)
  })
})

/**
 * A replayed op that got no answer, a lost one (a timeout) or one a retry may change (a 5xx) is
 * tried again, never lettered as the server's refusal; only the server's own answer is one.
 */
describe('offline handover: which failed answers are refusals', () => {
  it('replayFailure: lost, unreachable and retry are tried again; a plain answer is a refusal', () => {
    const msg = 'Walnut request timed out after 10000ms: POST /messages'
    expect(replayFailure({ message: msg, lost: true })).not.toBeInstanceOf(RefusedWrite)
    expect(replayFailure({ message: msg, unreachable: true })).not.toBeInstanceOf(RefusedWrite)
    expect(replayFailure({ message: 'Walnut API error (503): busy', retry: true })).not.toBeInstanceOf(RefusedWrite)
    expect(replayFailure({ message: 'Walnut API error (validation_error): bad phase' })).toBeInstanceOf(RefusedWrite)
  })

  it('a held task_send that timed out is retried, not lettered refused', async () => {
    executeOp.mockReset()
    _resetOfflineHandoverForTesting()
    _setHandoverBackoffForTesting([60_000])
    executeOp.mockResolvedValue({ ok: false, lost: true, message: 'Walnut request timed out after 10000ms: POST /messages' })
    const rec: OfflineRecord = { seq: 4701, at: Date.now(), kind: 'op', op: 'task_send', args: { to: 't-x', text: 'hi' }, callerSid: SID } as OfflineRecord
    const conn = host([rec])
    expect(await runOfflineHandover(conn)).toMatchObject({ failed: 1 })
    // Not acked: the record waits for its retry instead.
    expect((await conn.send('offline.drain')).records).toHaveLength(1)
    _setHandoverBackoffForTesting(null)
  })

  it('no replay site builds its own refusal from an op answer: all go through replayFailure', () => {
    for (const f of ['src/core/offline-handover.ts', 'src/core/offline-merge/apply-v2.ts']) {
      const src = readFileSync(new URL(`../../${f}`, import.meta.url), 'utf8')
      expect(src, f).not.toMatch(/new RefusedWrite\(r\.message\)/)
      expect(src, f).not.toMatch(/r\.unreachable\s*\?/)
    }
  })
})

/** The text of every `log.<x>.error(...)` call, bracket-matched. */
function errorCalls(src: string): string[] {
  const out: string[] = []
  const re = /log\.\w+\.error\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    let depth = 0
    let i = m.index + m[0].length - 1
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++
      else if (src[i] === ')' && --depth === 0) break
    }
    out.push(src.slice(m.index, i + 1))
  }
  return out
}
