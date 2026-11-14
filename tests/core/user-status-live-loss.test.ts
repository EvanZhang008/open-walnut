/**
 * Only a restart loss of the session's CURRENT death reaches the user status (session-auto-recover.ts
 * turnRetrier, read through sessions/turn-run.ts and user-status-sync.ts turnWaitFacts). A loss stays
 * on the record after it is decided, so an old one must never paint a later life: a manual resume that
 * then failed for its own reasons read "Walnut could not resume it".
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants())

import { turnWaitFacts } from '../../src/core/user-status-sync.js'
import { SessionAutoRecover, startSessionAutoRecover, turnRetrier } from '../../src/core/session-auto-recover.js'
import type { TurnRun } from '../../src/core/sessions/turn-run.js'
import type { SessionRecord } from '../../src/core/types.js'

const rec = (restartLoss: Partial<NonNullable<SessionRecord['restartLoss']>> | undefined, statusRevision = 7) =>
  ({ claudeSessionId: 's1', statusRevision, process_status: 'stopped', restartLoss: restartLoss && { at: '2026-10-28T00:00:00Z', cause: 'machine_reboot', lost: [], ...restartLoss } } as unknown as SessionRecord)

let stops: Array<() => void> = []
afterEach(() => { for (const s of stops) s(); stops = []; vi.restoreAllMocks() })
/** A running recovery whose hand-back test answers `v`. */
function holds(v: boolean): void {
  vi.spyOn(SessionAutoRecover.prototype, 'holdsHandBack').mockReturnValue(v)
  stops.push(startSessionAutoRecover(undefined, { now: () => Date.now() }).stop)
}
const run = (r: SessionRecord): TurnRun => {
  const wait = turnRetrier.wait(r, { failed: true })
  const stop = turnRetrier.stop!(r)
  return { attempts: [], wait, stop, waits: wait ? [wait] : [], stops: stop ? [stop] : [] }
}

describe('the restart loss the status reads', () => {
  it('gave up: only while no status moved since the verdict', () => {
    expect(turnWaitFacts(run(rec({ state: 'gave_up', revision: 7 })), rec(undefined)).restartLoss).toEqual({ state: 'gave_up', cause: 'machine_reboot' })
    expect(turnWaitFacts(run(rec({ state: 'gave_up', revision: 5 })), rec(undefined)).restartLoss).toBeUndefined()
  })
  it('queued or sent: only while recovery still holds it (the hand-back test)', () => {
    // No recovery running: nothing holds.
    expect(turnWaitFacts(run(rec({ state: 'sent' })), rec(undefined)).restartLoss).toBeUndefined()
    holds(true)
    expect(turnWaitFacts(run(rec({ state: 'queued' })), rec(undefined)).restartLoss).toEqual({ state: 'queued', cause: 'machine_reboot' })
    vi.restoreAllMocks()
    holds(false)
    expect(turnWaitFacts(run(rec({ state: 'sent' })), rec(undefined)).restartLoss).toBeUndefined()
  })
  it('pending, skipped, resumed, none: no words (pending still holds the hand-back)', () => {
    holds(true)
    for (const state of ['pending', 'skipped', 'resumed'] as const) expect(turnWaitFacts(run(rec({ state })), rec(undefined)).restartLoss).toBeUndefined()
    expect(turnWaitFacts(run(rec(undefined)), rec(undefined)).restartLoss).toBeUndefined()
    expect(turnRetrier.wait(rec({ state: 'pending' }), { failed: true })?.reason).toBe('restart_recovery')
  })
  it('holds a failed or dead end only, and not the resumed session\'s own end after its resume went out', () => {
    holds(true)
    expect(turnRetrier.wait(rec({ state: 'queued' }), {})).toBeNull()
    expect(turnRetrier.wait(rec({ state: 'sent' }), { failed: true, ownEnd: true })).toBeNull()
    expect(turnRetrier.wait(rec({ state: 'sent', cause: 'start_died' }), { failed: true, ownEnd: true })?.reason).toBe('restart_recovery')
  })
})
