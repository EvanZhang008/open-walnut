/**
 * Only a restart loss of the session's CURRENT death reaches the user status (user-status-sync.ts
 * liveRestartLoss). A loss stays on the record after it is decided, so an old one must never paint
 * a later life: a manual resume that then failed for its own reasons read "Walnut could not resume it".
 */
import { describe, it, expect } from 'vitest'
import { liveRestartLoss } from '../../src/core/user-status-sync.js'
import type { SessionRecord } from '../../src/core/types.js'

const rec = (restartLoss: Partial<NonNullable<SessionRecord['restartLoss']>> | undefined, statusRevision = 7) =>
  ({ claudeSessionId: 's1', statusRevision, restartLoss: restartLoss && { at: '2026-10-28T00:00:00Z', cause: 'machine_reboot', lost: [], ...restartLoss } } as unknown as SessionRecord)
const holds = (v: boolean) => ({ holdsHandBack: () => v })

describe('liveRestartLoss', () => {
  it('gave up: only while no status moved since the verdict', () => {
    expect(liveRestartLoss(rec({ state: 'gave_up', revision: 7 }), holds(false))).toEqual({ state: 'gave_up', cause: 'machine_reboot' })
    expect(liveRestartLoss(rec({ state: 'gave_up', revision: 5 }), holds(false))).toBeUndefined()
  })
  it('queued or sent: only while recovery still holds it (the hand-back test)', () => {
    expect(liveRestartLoss(rec({ state: 'queued' }), holds(true))).toEqual({ state: 'queued', cause: 'machine_reboot' })
    expect(liveRestartLoss(rec({ state: 'sent' }), holds(false))).toBeUndefined()
    expect(liveRestartLoss(rec({ state: 'sent' }), null)).toBeUndefined()
  })
  it('pending, skipped, resumed, none: nothing', () => {
    for (const state of ['pending', 'skipped', 'resumed'] as const) expect(liveRestartLoss(rec({ state }), holds(true))).toBeUndefined()
    expect(liveRestartLoss(rec(undefined), holds(true))).toBeUndefined()
  })
})
