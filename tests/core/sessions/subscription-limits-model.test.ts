/**
 * The pure rules behind the subscription limit readout
 * (src/core/sessions/subscription-limits-model.ts): a `rate_limit_event` line
 * read defensively in both the older shape (fork 2.1.88: the limiting window
 * only, a percentage only once a warning fired) and the newer one (2.1.284:
 * unifiedWindows on every observation), folded newest-per-window, and the
 * sign-in words the readiness check produces mapped to "has subscription
 * limits" or not.
 */
import { describe, it, expect } from 'vitest'
import {
  applyRateLimitInfo, epochMs, parseRateLimitEvent, parseRateLimitInfo, reviveHostLimitState, signInKind,
  type HostLimitState,
} from '../../../src/core/sessions/subscription-limits-model.js'
import { createClaudeCheck } from '../../../src/providers/claude-check-core.js'

const T0 = 1_790_000_000 // epoch seconds

describe('parseRateLimitInfo', () => {
  it('reads the older shape: status, the limiting window, its reset in SECONDS, and overage', () => {
    const info = parseRateLimitInfo({
      status: 'allowed_warning', resetsAt: T0, rateLimitType: 'five_hour', utilization: 0.92,
      overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false, surpassedThreshold: 0.9,
    })
    expect(info).toEqual({
      status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: T0 * 1000, utilization: 0.92, surpassedThreshold: 0.9,
      overageStatus: 'rejected', overageDisabledReason: 'out_of_credits', isUsingOverage: false, windows: [],
    })
  })

  it('reads the newer per-window usage, skipping a window with a missing number', () => {
    const info = parseRateLimitInfo({
      status: 'allowed', resetsAt: T0, rateLimitType: 'five_hour',
      unifiedWindows: {
        five_hour: { utilization: 0.42, resetsAt: T0 },
        seven_day: { utilization: 0.31, resetsAt: T0 + 400_000 },
        seven_day_overage_included: { utilization: 0.05 },
        'Bad Key': { utilization: 0.1, resetsAt: T0 },
      },
    })!
    expect(info.windows).toEqual([
      { type: 'five_hour', utilization: 0.42, resetsAt: T0 * 1000 },
      { type: 'seven_day', utilization: 0.31, resetsAt: (T0 + 400_000) * 1000 },
    ])
  })

  it('refuses what is not a rate limit snapshot, and drops junk fields', () => {
    expect(parseRateLimitInfo(null)).toBeNull()
    expect(parseRateLimitInfo({})).toBeNull()
    expect(parseRateLimitInfo({ status: 'exploded' })).toBeNull()
    expect(parseRateLimitInfo({ status: 'allowed', utilization: -1, resetsAt: 'soon', rateLimitType: 'Five Hour' }))
      .toEqual({ status: 'allowed', windows: [] })
    expect(parseRateLimitEvent({ type: 'assistant', rate_limit_info: { status: 'allowed' } })).toBeNull()
    expect(parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected' }, uuid: 'u', session_id: 's' }))
      .toEqual({ status: 'rejected', windows: [] })
  })

  it('epoch seconds become ms; a value already in ms stays', () => {
    expect(epochMs(T0)).toBe(T0 * 1000)
    expect(epochMs(T0 * 1000)).toBe(T0 * 1000)
    expect(epochMs(0)).toBeUndefined()
    expect(epochMs(Number.NaN)).toBeUndefined()
  })
})

describe('applyRateLimitInfo', () => {
  const fold = (prev: HostLimitState | undefined, raw: unknown, seenAt: number, sid = 'sid-a') =>
    applyRateLimitInfo(prev, '__local__', parseRateLimitInfo(raw)!, seenAt, sid)

  it('keeps the newest reading per window and replaces the headline wholesale', () => {
    const a = fold(undefined, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: T0, utilization: 0.8 }, 1000)
    const b = fold(a, { status: 'allowed', rateLimitType: 'seven_day', resetsAt: T0 + 300_000, utilization: 0.31 }, 2000, 'sid-b')
    expect(Object.keys(b.windows).sort()).toEqual(['five_hour', 'seven_day'])
    expect(b.windows.five_hour).toEqual({ type: 'five_hour', utilization: 0.8, resetsAt: T0 * 1000, seenAt: 1000, sessionId: 'sid-a' })
    expect(b.windows.seven_day).toMatchObject({ utilization: 0.31, seenAt: 2000, sessionId: 'sid-b' })
    // The warning was about five_hour; the newer snapshot says allowed, so it is over.
    expect(b.current).toMatchObject({ status: 'allowed', type: 'seven_day', seenAt: 2000 })
    expect(b.updatedAt).toBe(2000)
    // prev is never mutated.
    expect(Object.keys(a.windows)).toEqual(['five_hour'])
  })

  it('a newer reading of the same window wins, its percentage included', () => {
    const a = fold(undefined, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: T0, utilization: 0.9 }, 1000)
    const b = fold(a, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: T0, utilization: 0.95 }, 2000)
    expect(b.windows.five_hour).toMatchObject({ utilization: 0.95, seenAt: 2000 })
  })

  it('a headline without a percentage keeps the same window\'s earlier number, with its own age', () => {
    const a = fold(undefined, { status: 'allowed_warning', rateLimitType: 'five_hour', resetsAt: T0, utilization: 0.9 }, 1000)
    const same = fold(a, { status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 }, 2000)
    expect(same.windows.five_hour).toMatchObject({ utilization: 0.9, seenAt: 1000 })
    expect(same.current).toMatchObject({ status: 'allowed', seenAt: 2000 })
    // A new window (another reset time) is a new reading: the old number is gone.
    const next = fold(a, { status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 + 18_000 }, 3000)
    expect(next.windows.five_hour).toEqual({ type: 'five_hour', resetsAt: (T0 + 18_000) * 1000, seenAt: 3000, sessionId: 'sid-a' })
  })

  it('per-window usage fills every window it names, and wins over the headline', () => {
    const s = fold(undefined, {
      status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0,
      unifiedWindows: { five_hour: { utilization: 0.42, resetsAt: T0 }, seven_day_overage_included: { utilization: 0.1, resetsAt: T0 + 500_000 } },
    }, 1000)
    expect(s.windows.five_hour.utilization).toBe(0.42)
    expect(s.windows.seven_day_overage_included).toMatchObject({ utilization: 0.1, resetsAt: (T0 + 500_000) * 1000 })
  })

  it('a snapshot naming no window (a non-subscriber reset) creates no row but clears the status', () => {
    const a = fold(undefined, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: T0 }, 1000)
    const b = fold(a, { status: 'allowed', isUsingOverage: false }, 2000)
    expect(Object.keys(b.windows)).toEqual(['five_hour'])
    expect(b.current).toEqual({ status: 'allowed', seenAt: 2000, sessionId: 'sid-a' })
    // "not using extra usage" alone says nothing worth keeping.
    expect(b.overage).toBeUndefined()
    const empty = fold(undefined, { status: 'allowed' }, 1000)
    expect(empty.windows).toEqual({})
    expect(empty.overage).toBeUndefined()
  })

  it('overage is the newest snapshot\'s, or absent when that snapshot says nothing about it', () => {
    const a = fold(undefined, { status: 'rejected', rateLimitType: 'five_hour', resetsAt: T0, overageStatus: 'allowed', isUsingOverage: true, overageResetsAt: T0 + 9000 }, 1000)
    expect(a.overage).toEqual({ status: 'allowed', isUsingOverage: true, resetsAt: (T0 + 9000) * 1000, seenAt: 1000 })
    const b = fold(a, { status: 'allowed', rateLimitType: 'five_hour', resetsAt: T0 + 18_000 }, 2000)
    expect(b.overage).toBeUndefined()
  })
})

describe('signInKind', () => {
  it('maps the readiness check\'s exact words (as claude-check-core writes them)', () => {
    const check = createClaudeCheck({ env: {} })
    const detail = (json: object) => check.parseAuthStatus(JSON.stringify(json))?.detail
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'claude.ai' }))).toBe('subscription')
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'oauth_token' }))).toBe('subscription')
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }))).toBe('other')
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'third_party', apiProvider: 'vertex' }))).toBe('other')
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'third_party', apiProvider: 'foundry' }))).toBe('other')
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'third_party', apiProvider: 'someone-new' }))).toBe('other')
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'api_key' }))).toBe('other')
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'api_key_helper' }))).toBe('other')
    expect(signInKind('ok', detail({ loggedIn: true, authMethod: 'brand_new_method' }))).toBe('unknown')
  })

  it('is unknown when the check did not succeed or said nothing', () => {
    expect(signInKind('not-logged-in', 'claude auth status: not logged in')).toBe('unknown')
    expect(signInKind('unknown', undefined)).toBe('unknown')
    expect(signInKind(undefined, 'a Claude account')).toBe('unknown')
    expect(signInKind('ok', 'an auth token')).toBe('other')
  })
})

describe('reviveHostLimitState', () => {
  it('round-trips a folded state and drops junk', () => {
    const s = applyRateLimitInfo(undefined, 'devbox', parseRateLimitInfo({
      status: 'allowed_warning', rateLimitType: 'seven_day', resetsAt: T0, utilization: 0.77,
      overageStatus: 'allowed_warning', isUsingOverage: true,
    })!, 5000, 'sid-x')
    expect(reviveHostLimitState('devbox', JSON.parse(JSON.stringify(s)))).toEqual(s)
    expect(reviveHostLimitState('devbox', null)).toBeNull()
    expect(reviveHostLimitState('devbox', { windows: { five_hour: { utilization: 'x' }, ok_one: { seenAt: 1, utilization: 0.5 } }, updatedAt: 'no' }))
      .toEqual({ host: 'devbox', windows: { ok_one: { type: 'ok_one', seenAt: 1, utilization: 0.5 } }, updatedAt: 0 })
  })
})
