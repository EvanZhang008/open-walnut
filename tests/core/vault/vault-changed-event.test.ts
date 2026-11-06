/**
 * Every change of who holds a Passwords unlock is announced to every open Walnut window as
 * `vault:changed` (src/core/vault/sessions.ts), so a Lock in the extension locks an open Passwords
 * page at once and an unlock there is shared at once (review 2026-11-06: an extension Lock reached
 * an open, unlocked Passwords page only after 13.6 s, which kept listing every item meanwhile).
 *
 * The class is every export of sessions.ts that changes the sessions or the self-lock records: each
 * is listed here with a call that makes it change something, and the test fails on a new export
 * that is in neither list, so a new way to change an unlock cannot skip the announcement. A mere
 * use (the idle clock) is no change. A burst is one event. The event carries nothing of the vault.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as S from '../../../src/core/vault/sessions.js'
import { bus, EventNames } from '../../../src/core/event-bus.js'

const DEVICE = 'extension-a1b2c3'
const MIN = 60_000

function unlockHere(idleMs = MIN): string {
  return S.createSession('web', { idleMs, maxMs: 48 * 60 * MIN }, undefined, true).token
}

const seen: unknown[] = []
const SUB = 'vault-changed-event-test'

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-11-06T10:00:00Z'))
  S.resetSessionsForTest()
  seen.length = 0
  bus.subscribe(SUB, (e) => { if (e.name === EventNames.VAULT_CHANGED) seen.push(e.data) }, { global: true, interest: [EventNames.VAULT_CHANGED] })
})
afterEach(() => {
  bus.unsubscribe(SUB)
  S.resetSessionsForTest()
  vi.useRealTimers()
})

/** Settle the debounce and count what went out. */
function announced(): number {
  vi.advanceTimersByTime(500)
  const n = seen.length
  seen.length = 0
  return n
}

/** Every export that changes who holds an unlock, with a setup (not counted) and the change. */
const CHANGES: Record<string, { setup?: () => unknown; change: (ctx: unknown) => unknown }> = {
  createSession: { change: () => unlockHere() },
  joinSession: { setup: () => unlockHere(), change: () => expect(S.joinSession(DEVICE, 'ext')).not.toBeNull() },
  endSession: { setup: () => unlockHere(), change: (t) => S.endSession(t as string) },
  endJoinsBefore: { change: () => S.endJoinsBefore() },
  endOtherSessions: { setup: () => { unlockHere(); return unlockHere() }, change: (t) => S.endOtherSessions(t as string) },
  endDeviceSessions: { setup: () => { unlockHere(); return S.joinSession(DEVICE, 'ext') }, change: () => S.endDeviceSessions(DEVICE) },
  endAllSessions: { setup: () => unlockHere(), change: () => S.endAllSessions() },
  retimeSessions: { setup: () => unlockHere(10 * MIN), change: () => S.retimeSessions({ idleMs: 5 * MIN, maxMs: 0 }) },
  // An expiry found when read: the one that lapsed ends, and windows hear it.
  liveSessionCount: { setup: () => unlockHere(MIN), change: () => { vi.setSystemTime(Date.now() + 2 * MIN); S.liveSessionCount() } },
  useSession: { setup: () => unlockHere(MIN), change: (t) => { vi.setSystemTime(Date.now() + 2 * MIN); expect(S.useSession(t as string, true, undefined)).toBeNull() } },
}

/** Exports that change nothing anyone holds (reads, the brake, test hooks, wiring, constants). */
const NO_CHANGE = new Set([
  'SESSION_HEADER', 'DEFAULT_IDLE_MINUTES', 'MAX_SESSION_HOURS',
  'setSessionStoreHook', 'onSessionsExpired', 'live', 'joinSource', 'joinTestRouteAllowed', 'nameJoinDeviceForTest',
  'sessionList', 'selfLockList',
  // A restart's own records coming back before any window is served: no window is open to tell.
  'restoreSessions', 'restoreSelfLocks',
  'unlockWaitMs', 'noteUnlockFailure', 'noteUnlockSuccess', 'isAttemptRunning', 'beginAttempt', 'endAttempt',
  'resetSessionsForTest',
])

describe('vault:changed', () => {
  it('every export of sessions.ts is either a listed change or listed as none', () => {
    const unlisted = Object.keys(S).filter((k) => !(k in CHANGES) && !NO_CHANGE.has(k))
    expect(unlisted, 'a new export of src/core/vault/sessions.ts: list it in CHANGES (with a call) or NO_CHANGE (with why)').toEqual([])
  })

  for (const [name, { setup, change }] of Object.entries(CHANGES)) {
    it(`${name} announces one change`, () => {
      const ctx = setup?.()
      announced()
      change(ctx)
      expect(announced()).toBe(1)
    })
  }

  it('a use is no change, nor is a read', () => {
    const t = unlockHere(10 * MIN)
    announced()
    expect(S.useSession(t, true, undefined)).not.toBeNull()
    expect(S.useSession(t, false, undefined)).not.toBeNull()
    S.joinSource(DEVICE)
    S.sessionList()
    expect(announced()).toBe(0)
  })

  it('a burst is one event, and it carries nothing of the vault', () => {
    for (let i = 0; i < 5; i++) unlockHere()
    S.joinSession(DEVICE, 'ext')
    S.endAllSessions()
    vi.advanceTimersByTime(500)
    expect(seen).toHaveLength(1)
    expect(Object.keys(seen[0] as object)).toEqual(['at'])
  })
})
