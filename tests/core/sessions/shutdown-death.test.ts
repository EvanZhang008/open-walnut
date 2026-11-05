/**
 * Which death edges are held for the host-shutdown check
 * (src/core/sessions/shutdown-death.ts), what counts as the shutdown, and a
 * ratchet that keeps the check in the one gate every hand-back passes.
 *
 * 2026-11-03: the Mac rebooted with four sessions mid-turn; the server, still
 * running through the shutdown, wrote each death and handed the task back, so
 * the next boot resumed none. tests/e2e/restart-recovery-local-shutdown.test.ts
 * runs that drill end to end.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import type { SessionRecord } from '../../../src/core/types.js'

let linkLost: number | null = null
vi.mock('../../../src/providers/daemon-connection.js', () => ({ daemonLinkLostSince: () => linkLost }))

const {
  shutdownCheckApplies, shutdownWitness, markServerStopping, resetServerStopping, shutdownCheckMs,
} = await import('../../../src/core/sessions/shutdown-death.js')

const ROOT = path.resolve(__dirname, '../../..')
const rec = (over: Partial<SessionRecord> = {}): SessionRecord => ({
  claudeSessionId: 's1', taskId: 't1', type: 'interactive', process_status: 'stopped', ...over,
} as SessionRecord)

beforeEach(() => {
  process.env.WALNUT_SHUTDOWN_CHECK = '1'
  delete process.env.WALNUT_SHUTDOWN_CHECK_MS
  linkLost = null
  resetServerStopping()
})
afterEach(() => { process.env.WALNUT_SHUTDOWN_CHECK = '0'; resetServerStopping() })

describe('shutdownCheckApplies', () => {
  it('checks a death nobody asked for', () => {
    expect(shutdownCheckApplies(rec())).toBe(true)
    expect(shutdownCheckApplies(rec({ process_status: 'error', status_reason: 'daemon_reported_exit' } as Partial<SessionRecord>))).toBe(true)
  })
  it('never a stop someone meant, an archived record, a session with no task or not interactive', () => {
    for (const over of [
      { archived: true }, { taskId: undefined }, { type: 'triage' },
      { status_changed_by: 'user' }, { stopRequest: { at: 'x' } },
      { status_reason: 'remote_unreachable' },
      { status_reason: 'expected_teardown' }, { status_reason: 'idle_timeout' },
      { status_reason: 'user_stopped' }, { status_reason: 'user_terminated' },
    ] as Array<Partial<SessionRecord>>) expect(shutdownCheckApplies(rec(over)), JSON.stringify(over)).toBe(false)
  })
  it("checks a turn-end label the runner wrote for a death the edge reports", () => {
    expect(shutdownCheckApplies(rec({ status_reason: 'normal_completion' } as Partial<SessionRecord>))).toBe(false)
    expect(shutdownCheckApplies(rec({ status_reason: 'normal_completion' } as Partial<SessionRecord>), true)).toBe(true)
    expect(shutdownCheckApplies(rec({ status_reason: 'turn_completed' } as Partial<SessionRecord>), true)).toBe(true)
    expect(shutdownCheckApplies(rec({ status_reason: 'user_stopped' } as Partial<SessionRecord>), true)).toBe(false)
    expect(shutdownCheckApplies(rec({ status_reason: 'normal_completion', errorKind: 'terminal' } as Partial<SessionRecord>), true)).toBe(false)
  })
  it('is off with WALNUT_SHUTDOWN_CHECK=0', () => {
    process.env.WALNUT_SHUTDOWN_CHECK = '0'
    expect(shutdownCheckApplies(rec())).toBe(false)
  })
  it('waits 15 s unless told otherwise', () => {
    expect(shutdownCheckMs()).toBe(15_000)
    process.env.WALNUT_SHUTDOWN_CHECK_MS = '2000'
    expect(shutdownCheckMs()).toBe(2000)
  })
})

describe('shutdownWitness', () => {
  it('is nothing while this server runs and its host link is up', async () => {
    expect(await shutdownWitness({ host: undefined })).toBeNull()
    expect(await shutdownWitness({ host: 'devbox' })).toBeNull()
  })
  it("is this server's own stop, for this computer's sessions only", async () => {
    markServerStopping()
    expect(await shutdownWitness({ host: undefined })).toBe('server_stopping')
    expect(await shutdownWitness({ host: '__local__' })).toBe('server_stopping')
    expect(await shutdownWitness({ host: 'devbox' })).toBeNull()
  })
  it("is the host's daemon link going down with the session", async () => {
    const lastActiveAt = new Date(Date.now() - 20_000).toISOString()
    linkLost = Date.now() - 1000
    expect(await shutdownWitness({ host: 'devbox', lastActiveAt })).toBe('host_link_down')
    expect(await shutdownWitness({ host: undefined, lastActiveAt })).toBe('host_link_down')
  })
  it('never a link that was down long before the session last did anything, or with no activity known', async () => {
    linkLost = Date.now() - 3 * 3_600_000
    expect(await shutdownWitness({ host: 'devbox', lastActiveAt: new Date(Date.now() - 60_000).toISOString() })).toBeNull()
    linkLost = Date.now() - 1000
    expect(await shutdownWitness({ host: 'devbox' })).toBeNull()
  })
})

describe('where the check runs', () => {
  it('the hand-back gate falls through to the shutdown check after recovery declines', () => {
    const phase = fs.readFileSync(path.join(ROOT, 'src/core/phase.ts'), 'utf8')
    const fn = phase.slice(phase.indexOf('async function restartRecoveryHolds('), phase.indexOf('export async function applySessionPhase('))
    expect(fn.indexOf('recovery.holdsHandBack(rec)')).toBeGreaterThan(0)
    expect(fn.indexOf('recovery.holdForShutdownCheck(')).toBeGreaterThan(fn.indexOf('recovery.holdsHandBack(rec)'))
  })
  it('stopServer marks the stop before it tears anything down', () => {
    const server = fs.readFileSync(path.join(ROOT, 'src/web/server.ts'), 'utf8')
    const stop = server.indexOf('export async function stopServer(')
    const mark = server.indexOf('markServerStopping()', stop)
    expect(mark).toBeGreaterThan(stop)
    expect(mark - stop).toBeLessThan(500)
    expect(server.indexOf('resetServerStopping()')).toBeGreaterThan(server.indexOf('export async function startServer('))
  })
})
