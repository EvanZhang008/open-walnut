/**
 * Which extension unlock may hand the Walnut window beside it a browser key (src/core/vault/sessions.ts
 * handingSource, POST /vault/browser-key), and what a new key carries from the one it replaces
 * (carryJoiner): only a live session the extension holds itself, of an unlock made on this computer
 * after the last new master password; a window's own lock goes with it to its new key. Fake times only.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as S from '../../../src/core/vault/sessions.js'

const DEVICE = 'extension-a1b2c3'
const OTHER = 'extension-d4e5f6'
const MIN = 60_000
const LONG = { idleMs: MIN, maxMs: 48 * 60 * MIN }

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
  S.resetSessionsForTest()
})
afterEach(() => {
  S.resetSessionsForTest()
  vi.useRealTimers()
})

describe('handingSource', () => {
  it('the extension\'s own unlock made here hands; one not made here, another device\'s or none does not', () => {
    const own = S.createSession('ext', LONG, DEVICE, true).token
    expect(S.handingSource(own, DEVICE)?.device).toBe(DEVICE)
    expect(S.handingSource(own, OTHER)).toBeNull()
    expect(S.handingSource(undefined, DEVICE)).toBeNull()
    expect(S.handingSource('no-such-token', DEVICE)).toBeNull()
    // An unlock by this device that was not made on this computer (no Origin, or from elsewhere).
    const away = S.createSession('ext', LONG, DEVICE, false).token
    expect(S.handingSource(away, DEVICE)).toBeNull()
    // A window's session (no device) never hands, whoever presents it.
    const win = S.createSession('web', LONG, undefined, true).token
    expect(S.handingSource(win, DEVICE)).toBeNull()
  })

  it('a session the extension shares from a window here hands, and only while that unlock lives', () => {
    const web = S.createSession('web', LONG, undefined, true).token
    const joined = S.joinSession(DEVICE, 'Walnut extension')!.token
    expect(S.handingSource(joined, DEVICE)?.device).toBeUndefined() // the window's unlock
    S.endSession(web)
    expect(S.handingSource(joined, DEVICE)).toBeNull()
  })

  it('an expired session hands nothing', () => {
    const own = S.createSession('ext', LONG, DEVICE, true).token
    vi.advanceTimersByTime(MIN + 1)
    expect(S.handingSource(own, DEVICE)).toBeNull()
  })

  it('an unlock made before a new master password hands nothing; one made after does', () => {
    const before = S.createSession('ext', LONG, DEVICE, true).token
    vi.advanceTimersByTime(10)
    S.endJoinsBefore()
    expect(S.useSession(before, false, DEVICE)).not.toBeNull() // still the extension's own unlock
    expect(S.handingSource(before, DEVICE)).toBeNull()
    vi.advanceTimersByTime(10)
    const after = S.createSession('ext', LONG, DEVICE, true).token
    expect(S.handingSource(after, DEVICE)).not.toBeNull()
  })
})

describe('carryJoiner', () => {
  it('a window\'s own lock carries to its new key, so the new key shares no unlock the old one would not', () => {
    S.createSession('web', LONG, undefined, true)
    vi.advanceTimersByTime(10)
    S.endSession(undefined, 'window:old')
    expect(S.joinSource('window:new')).not.toBeNull()
    S.carryJoiner({ from: 'window:old', to: 'window:new', handedBy: DEVICE })
    expect(S.joinSource('window:new')).toBeNull()
    expect(S.selfLockList().find((l) => l.device === 'window:new')).toBeTruthy()
    // The person unlocks again: shared again.
    vi.advanceTimersByTime(10)
    S.createSession('web', LONG, undefined, true)
    expect(S.joinSource('window:new')).not.toBeNull()
  })

  it('no record to carry: nothing changes', () => {
    S.createSession('web', LONG, undefined, true)
    S.carryJoiner({ to: 'window:fresh' })
    S.carryJoiner({ from: 'window:never-locked', to: 'window:fresh' })
    expect(S.joinSource('window:fresh')).not.toBeNull()
    expect(S.selfLockList()).toEqual([])
  })
})

describe('in the Playwright fixture\'s named mode', () => {
  it('a key handed by a named extension is that spec\'s window too; one handed by an unnamed one is not', async () => {
    vi.resetModules()
    vi.stubEnv('WALNUT_TEST_VAULT_JOIN', 'named')
    try {
      const N = await import('../../../src/core/vault/sessions.js')
      N.resetSessionsForTest()
      N.nameJoinDeviceForTest(DEVICE, true)
      N.createSession('web', LONG, undefined, true)
      expect(N.joinSource('window:handed')).toBeNull()
      N.carryJoiner({ to: 'window:handed', handedBy: DEVICE })
      expect(N.joinSource('window:handed')).not.toBeNull()
      N.carryJoiner({ to: 'window:stranger', handedBy: OTHER })
      expect(N.joinSource('window:stranger')).toBeNull()
      N.nameJoinDeviceForTest(DEVICE, false)
      N.nameJoinDeviceForTest('window:handed', false)
      N.resetSessionsForTest()
    } finally {
      vi.unstubAllEnvs()
      vi.resetModules()
    }
  })
})
