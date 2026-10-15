/**
 * The auth failure limiter counts GUESSES, not requests.
 *
 * A revoked phone that reloads the console sends dozens of requests with its
 * one dead token. Counted per request they reached the 10-per-minute budget on
 * the first load, and every request from that address was then answered 429,
 * which the console could not map to its sign-in page. Behind a tunnel every
 * phone shares the tunnel's loopback address, so one revoked phone also locked
 * out every signed-in phone for a minute. The same refused credential now
 * counts once per window; different credentials still count one each.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  recordAuthFailure, isAuthRateLimited, clearAuthFailures, _resetAuthRateLimitForTesting,
} from '../../../src/web/middleware/auth-rate-limit.js'

beforeEach(() => { _resetAuthRateLimitForTesting(); vi.useFakeTimers() })
afterEach(() => { vi.useRealTimers() })

describe('auth failure limiter', () => {
  it('counts one refused token once, however often it is sent', () => {
    for (let i = 0; i < 200; i++) recordAuthFailure('127.0.0.1', 'dead-token')
    expect(isAuthRateLimited('127.0.0.1')).toBe(false)
  })

  it('still limits ten different guesses from one address', () => {
    for (let i = 0; i < 9; i++) recordAuthFailure('10.0.0.5', `guess-${i}`)
    expect(isAuthRateLimited('10.0.0.5')).toBe(false)
    recordAuthFailure('10.0.0.5', 'guess-9')
    expect(isAuthRateLimited('10.0.0.5')).toBe(true)
    // Another address is unaffected.
    expect(isAuthRateLimited('10.0.0.6')).toBe(false)
  })

  it('a repeated guess between new ones adds nothing', () => {
    for (let i = 0; i < 9; i++) {
      recordAuthFailure('10.0.0.7', `guess-${i}`)
      recordAuthFailure('10.0.0.7', 'guess-0')
    }
    expect(isAuthRateLimited('10.0.0.7')).toBe(false)
  })

  it('a caller with no credential to name counts every failure, as before', () => {
    for (let i = 0; i < 10; i++) recordAuthFailure('10.0.0.8')
    expect(isAuthRateLimited('10.0.0.8')).toBe(true)
  })

  it('the same token counts again once the window has passed', () => {
    for (let i = 0; i < 9; i++) recordAuthFailure('10.0.0.9', `old-${i}`)
    recordAuthFailure('10.0.0.9', 'dead-token')
    expect(isAuthRateLimited('10.0.0.9')).toBe(true)
    vi.advanceTimersByTime(60_001)
    expect(isAuthRateLimited('10.0.0.9')).toBe(false)
    recordAuthFailure('10.0.0.9', 'dead-token')
    recordAuthFailure('10.0.0.9', 'dead-token')
    expect(isAuthRateLimited('10.0.0.9')).toBe(false)
  })

  it('clearing a key forgets its failures', () => {
    for (let i = 0; i < 10; i++) recordAuthFailure('10.0.0.10', `g-${i}`)
    clearAuthFailures('10.0.0.10')
    expect(isAuthRateLimited('10.0.0.10')).toBe(false)
  })
})
