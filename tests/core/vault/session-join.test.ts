/**
 * A shared session is part of the one unlock it shares (src/core/vault/sessions.ts joinSession,
 * security review of the extension's shared unlock, Medium 2): it holds only while that unlock
 * does, ends with it (its expiry, a Lock of that window, Lock all), a use of it renews that unlock,
 * and a restore never brings it back without it. A device's own lock is kept as a list a restart
 * restores (Medium 1). Fake times only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as S from '../../../src/core/vault/sessions.js'

const DEVICE = 'extension-a1b2c3'
const MIN = 60_000

function unlockHere(idleMs = MIN): string {
  return S.createSession('web', { idleMs, maxMs: 48 * 60 * MIN }, undefined, true).token
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-05T10:00:00Z'))
  S.resetSessionsForTest()
})
afterEach(() => {
  S.resetSessionsForTest()
  vi.useRealTimers()
})

describe('a shared session is part of the unlock it shares', () => {
  it('ends when that unlock expires unused', () => {
    unlockHere()
    const joined = S.joinSession(DEVICE, 'Walnut extension')!.token
    expect(S.useSession(joined, false, DEVICE)).not.toBeNull()
    vi.advanceTimersByTime(MIN + 1)
    expect(S.useSession(joined, true, DEVICE)).toBeNull()
    expect(S.liveSessionCount()).toBe(0)
  })

  it('a use of it renews that unlock, so both hold as long as either is used', () => {
    const web = unlockHere()
    const joined = S.joinSession(DEVICE, 'Walnut extension')!.token
    vi.advanceTimersByTime(40_000)
    expect(S.useSession(joined, true, DEVICE)).not.toBeNull() // a fill or a copy in the extension
    vi.advanceTimersByTime(40_000) // 80 s after the window's own last use, 40 s after the share's
    expect(S.useSession(web, false, undefined)).not.toBeNull()
    expect(S.useSession(joined, false, DEVICE)).not.toBeNull()
    vi.advanceTimersByTime(MIN)
    expect(S.useSession(joined, false, DEVICE)).toBeNull()
    expect(S.useSession(web, false, undefined)).toBeNull()
  })

  it('ends when that window locks only itself (an older client\'s Lock)', () => {
    const web = unlockHere()
    const joined = S.joinSession(DEVICE, 'Walnut extension')!.token
    S.endSession(web)
    expect(S.useSession(joined, true, DEVICE)).toBeNull()
    expect(S.liveSessionCount()).toBe(0)
  })

  it('ends with Lock all, and a shared session is never shared on', () => {
    unlockHere()
    const joined = S.joinSession(DEVICE, 'Walnut extension')!.token
    expect(S.joinSource('extension-d4e5f6')?.source).toBeUndefined()
    S.endAllSessions()
    expect(S.useSession(joined, true, DEVICE)).toBeNull()
    expect(S.joinSession(DEVICE, 'Walnut extension')).toBeNull()
  })

  it('a restore never brings it back without the unlock it shares', () => {
    unlockHere()
    S.joinSession(DEVICE, 'Walnut extension')
    const kept = S.sessionList()
    const shared = kept.find((s) => s.source)!
    expect(shared.device).toBe(DEVICE)
    S.resetSessionsForTest()
    S.restoreSessions([shared])
    expect(S.liveSessionCount()).toBe(0)
    S.restoreSessions(kept)
    expect(S.liveSessionCount()).toBe(2)
  })
})

describe('a device\'s own lock', () => {
  it('holds against every unlock made before it, a restored list too, until the person unlocks again', () => {
    unlockHere()
    const joined = S.joinSession(DEVICE, 'Walnut extension')!.token
    vi.advanceTimersByTime(1000)
    S.endSession(joined, DEVICE)
    expect(S.joinSource(DEVICE)).toBeNull()
    const kept = { sessions: S.sessionList(), locks: S.selfLockList() }
    expect(kept.locks).toEqual([{ device: DEVICE, at: Date.now() }])
    S.resetSessionsForTest() // a restart
    S.restoreSelfLocks(kept.locks)
    S.restoreSessions(kept.sessions)
    expect(S.joinSource(DEVICE)).toBeNull()
    vi.advanceTimersByTime(1000)
    unlockHere()
    expect(S.joinSource(DEVICE)).not.toBeNull()
  })

  it('is recorded even when the device held no session', () => {
    unlockHere()
    S.endSession(undefined, DEVICE)
    expect(S.joinSource(DEVICE)).toBeNull()
    expect(S.selfLockList().map((l) => l.device)).toEqual([DEVICE])
  })
})

describe('a Walnut window shares an unlock made here too', () => {
  const WIN = 'window:0123456789abcdef01234567'
  const WIN2 = 'window:fedcba9876543210fedcba98'

  function unlockInExtension(): string {
    return S.createSession('Walnut extension', { idleMs: MIN, maxMs: 48 * 60 * MIN }, DEVICE, true).token
  }

  it('gets a token of its own, bound to no device, on the clocks of the unlock it shares', () => {
    unlockInExtension()
    const joined = S.joinSession(WIN, 'Walnut web', 'window')!.token
    const copy = S.sessionList().find((s) => s.source)!
    const src = S.sessionList().find((s) => s.here)!
    expect(copy.device).toBeUndefined()
    expect(copy.here).toBeUndefined()
    expect([copy.createdAt, copy.idleMs, copy.maxMs]).toEqual([src.createdAt, src.idleMs, src.maxMs])
    // A window's own unlock is held by its token alone, as one typed there is.
    expect(S.useSession(joined, false, undefined)).not.toBeNull()
    vi.advanceTimersByTime(MIN + 1)
    expect(S.useSession(joined, false, undefined)).toBeNull()
  })

  it('a window that locked only itself shares nothing until the person unlocks again; others still may', () => {
    unlockInExtension()
    const joined = S.joinSession(WIN, 'Walnut web', 'window')!.token
    vi.advanceTimersByTime(1000)
    S.endSession(joined, WIN)
    expect(S.joinSource(WIN)).toBeNull()
    expect(S.joinSession(WIN, 'Walnut web', 'window')).toBeNull()
    expect(S.joinSource(WIN2)).not.toBeNull()
    expect(S.joinSource(DEVICE)).not.toBeNull()
    vi.advanceTimersByTime(1000)
    unlockHere()
    expect(S.joinSession(WIN, 'Walnut web', 'window')).not.toBeNull()
  })

  it('ends with the unlock it shares (the extension locking itself) and with Lock all', () => {
    const ext = unlockInExtension()
    const joined = S.joinSession(WIN, 'Walnut web', 'window')!.token
    S.endSession(ext, DEVICE)
    expect(S.useSession(joined, true, undefined)).toBeNull()
    unlockInExtension()
    const again = S.joinSession(WIN, 'Walnut web', 'window')
    // The extension's own lock came before this unlock, so it holds against nothing now.
    expect(again).not.toBeNull()
    S.endAllSessions()
    expect(S.useSession(again!.token, true, undefined)).toBeNull()
    expect(S.joinSource(WIN)).toBeNull()
  })
})

describe('a new master password shares nothing made before it', () => {
  const WIN = 'window:0123456789abcdef01234567'

  it('no unlock from before is shared with any window or extension; one made after is', () => {
    const kept = unlockHere() // the window that changes the password keeps its own unlock
    expect(S.joinSource(WIN)).not.toBeNull()
    vi.advanceTimersByTime(1000)
    S.endOtherSessions(kept)
    S.endJoinsBefore()
    expect(S.useSession(kept, false, undefined)).not.toBeNull()
    expect(S.joinSource(WIN)).toBeNull()
    expect(S.joinSession(WIN, 'Walnut web', 'window')).toBeNull()
    expect(S.joinSession(DEVICE, 'Walnut extension')).toBeNull()
    vi.advanceTimersByTime(1000)
    unlockHere() // typed with the new password
    expect(S.joinSource(WIN)).not.toBeNull()
    expect(S.joinSource(DEVICE)).not.toBeNull()
  })

  it('a restart keeps that record with the windows', () => {
    const kept = unlockHere()
    vi.advanceTimersByTime(1000)
    S.endOtherSessions(kept)
    S.endJoinsBefore()
    const saved = { sessions: S.sessionList(), locks: S.selfLockList() }
    S.resetSessionsForTest()
    S.restoreSelfLocks(saved.locks)
    S.restoreSessions(saved.sessions)
    expect(S.joinSource(DEVICE)).toBeNull()
    expect(S.joinSource(WIN)).toBeNull()
  })
})
