/**
 * A pressed locked engine's note offers its setup only when a setup lifts the lock
 * (web/src/components/sessions/LockedEngineNote.tsx). 2026-11-25: Antigravity read "Not installed
 * here" on the Mac with nothing to do. Every short reason shortLockReason can give is judged here,
 * so a new kind of lock has to say which side it is on.
 */
import { describe, it, expect } from 'vitest'
import { setupLiftsLock } from '../../web/src/components/sessions/LockedEngineNote'
import { shortLockReason } from '../../web/src/utils/engines'

describe('the setup a locked engine offers', () => {
  it('an engine Walnut sets up, not on the host or not signed in there: the setup is offered', () => {
    expect(setupLiftsLock({ engine: 'antigravity', why: shortLockReason('agy is not installed') })).toBe(true)
    expect(setupLiftsLock({ engine: 'antigravity', why: shortLockReason('Not available on devbox: agy is not installed') })).toBe(true)
    expect(setupLiftsLock({ engine: 'antigravity', why: shortLockReason('configure it in Settings') })).toBe(true)
  })

  it("a lock of the caller's own, or a machine the engine never runs on: no setup", () => {
    for (const reason of [
      'This session runs on Claude Code — start a new session to use Antigravity',
      'A fork keeps the source session provider',
      'A quick question runs on the claude engine',
      'Antigravity runs on this Mac only',
    ]) expect(setupLiftsLock({ engine: 'antigravity', why: shortLockReason(reason) }), reason).toBe(false)
  })

  it('an engine Walnut cannot set up itself: no setup', () => {
    expect(setupLiftsLock({ engine: 'goose', why: shortLockReason('goose is not installed') })).toBe(false)
  })
})
