/**
 * L1 unit — daemon turn-error auto-retry policy (pure logic in daemon-core.ts).
 *
 * The daemon resumes a turn that died to a TRANSIENT upstream failure, for up to
 * a configurable budget (default 12h). Two properties matter more than anything
 * else here, and both are asserted against REAL error strings harvested from
 * this machine's logs (2026-08-11..13):
 *
 *   1. every transient error actually retries (else the feature is a no-op), and
 *   2. no TERMINAL error ever retries — above all a model refusal, where a retry
 *      loop would re-ask the same refused question for 12 hours.
 */

import { describe, it, expect } from 'vitest'
import {
  classifyTurnError,
  parseTurnErrorLine,
  resolveTurnRetryConfig,
  decideTurnRetry,
  applyTurnRetry,
  clearTurnRetryStreak,
  newTurnRetryState,
  turnRetryMessage,
  turnRetryMarkerText,
  turnRetryGiveUpText,
  TURN_RETRY_DEFAULTS,
  type TurnRetryConfig,
} from '../../src/providers/daemon-core.js'

// Real strings observed in /tmp/open-walnut/open-walnut-2026-08-1*.log.
const REAL_RETRYABLE = [
  'API Error: The operation timed out.',
  'API Error: Server error mid-response. The response above may be incomplete.',
  'API Error: Stream idle timeout - no chunks received',
  'API Error: Response stalled mid-stream. The response above may be incomplete.',
  'API Error: The system encountered an unexpected error during processing. Try your request again.',
]

// The refusal text really seen (model name elided — it varies by model).
const REAL_TERMINAL = [
  "API Error: Fable 5 can't help with this. Start a new session to continue.",
  "API Error: Sonnet 5 can't help with this. Start a new session to continue.",
]

const cfg = (over: Partial<TurnRetryConfig> = {}): TurnRetryConfig => ({
  enabled: true,
  budgetMs: 12 * 3600_000,
  maxAttempts: 200,
  backoffBaseMs: 30_000,
  backoffMaxMs: 600_000,
  ...over,
})

describe('classifyTurnError — real log corpus', () => {
  it.each(REAL_RETRYABLE)('retries the transient error: %s', (text) => {
    expect(classifyTurnError(text)).toBe('retryable')
  })

  it.each(REAL_TERMINAL)('NEVER retries a model refusal: %s', (text) => {
    expect(classifyTurnError(text)).toBe('terminal')
  })

  it('treats an unrecognized error as terminal (allowlist, not denylist)', () => {
    // The safety default: a brand-new error string we have never seen must NOT
    // start a 12h retry loop just because it isn't on the terminal list.
    expect(classifyTurnError('API Error: something nobody has ever seen before')).toBe('terminal')
  })

  it('treats empty/missing text as terminal', () => {
    expect(classifyTurnError(null)).toBe('terminal')
    expect(classifyTurnError(undefined)).toBe('terminal')
    expect(classifyTurnError('')).toBe('terminal')
  })

  it.each([
    ['auth', 'API Error: 401 Unauthorized'],
    ['forbidden', 'API Error: 403 Forbidden — credential expired'],
    ['bad request', 'API Error: 400 invalid_request_error'],
    ['context overflow', 'API Error: prompt too long: 250000 tokens exceeds the maximum'],
    ['user abort', 'Request cancelled by user'],
    ['spend limit', 'API Error: quota exceeded for this account'],
  ])('never retries a %s failure', (_label, text) => {
    expect(classifyTurnError(text)).toBe('terminal')
  })

  it.each([
    ['429 throttle', 'API Error: 429 Too Many Requests'],
    ['503', 'API Error: 503 Service Unavailable'],
    ['529 overloaded', 'API Error: 529 overloaded_error'],
    ['socket', 'API Error: socket hang up'],
    ['dns', 'API Error: fetch failed (EAI_AGAIN)'],
  ])('retries a %s failure', (_label, text) => {
    expect(classifyTurnError(text)).toBe('retryable')
  })

  it('lets terminal win when a text carries BOTH signatures', () => {
    // A refusal that happens to mention a timeout must not be retried: a retry
    // loop on a refusal is strictly worse than one missed retry.
    expect(classifyTurnError("Can't help with this. The operation timed out.")).toBe('terminal')
  })
})

describe('parseTurnErrorLine', () => {
  it('detects an error result even though subtype says "success"', () => {
    // THE trap: a real timeout result carries subtype:"success" next to
    // is_error:true (verified in live stream files). Gating on subtype would
    // make the whole feature silently dead.
    const line = JSON.stringify({
      type: 'result', subtype: 'success', is_error: true,
      result: 'API Error: The operation timed out.', session_id: 'abc',
    })
    expect(parseTurnErrorLine(line)).toEqual({
      isTurnError: true, text: 'API Error: The operation timed out.',
    })
  })

  it('ignores a clean result', () => {
    const line = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done' })
    expect(parseTurnErrorLine(line).isTurnError).toBe(false)
  })

  it('ignores non-result lines and malformed JSON', () => {
    expect(parseTurnErrorLine(JSON.stringify({ type: 'assistant', is_error: true })).isTurnError).toBe(false)
    expect(parseTurnErrorLine('{"type":"result","is_error":true,').isTurnError).toBe(false)
    expect(parseTurnErrorLine('').isTurnError).toBe(false)
  })

  it('reports a null text when result is absent or non-string', () => {
    const line = JSON.stringify({ type: 'result', is_error: true, result: { nested: 1 } })
    expect(parseTurnErrorLine(line)).toEqual({ isTurnError: true, text: null })
  })
})

describe('resolveTurnRetryConfig', () => {
  it('is DISABLED by default — an opt-in feature must never auto-spend tokens', () => {
    expect(resolveTurnRetryConfig({}).enabled).toBe(false)
    expect(TURN_RETRY_DEFAULTS.enabled).toBe(false)
  })

  it('enables only on an exact "1"', () => {
    expect(resolveTurnRetryConfig({ WALNUT_TURN_RETRY: '1' }).enabled).toBe(true)
    expect(resolveTurnRetryConfig({ WALNUT_TURN_RETRY: 'true' }).enabled).toBe(false)
    expect(resolveTurnRetryConfig({ WALNUT_TURN_RETRY: '0' }).enabled).toBe(false)
  })

  it('defaults the budget to 12h', () => {
    expect(resolveTurnRetryConfig({ WALNUT_TURN_RETRY: '1' }).budgetMs).toBe(12 * 3600_000)
  })

  it('honors an explicit budget and clamps absurd values', () => {
    expect(resolveTurnRetryConfig({ WALNUT_TURN_RETRY_BUDGET_MS: '3600000' }).budgetMs).toBe(3600_000)
    // Above the 7d ceiling → clamped, not accepted.
    expect(resolveTurnRetryConfig({ WALNUT_TURN_RETRY_BUDGET_MS: '999999999999' }).budgetMs).toBe(7 * 86_400_000)
    // A garbage value falls back to the default rather than NaN-poisoning math.
    expect(resolveTurnRetryConfig({ WALNUT_TURN_RETRY_BUDGET_MS: 'abc' }).budgetMs).toBe(12 * 3600_000)
  })

  it('allows budget 0 as a real "off by budget" value', () => {
    expect(resolveTurnRetryConfig({ WALNUT_TURN_RETRY: '1', WALNUT_TURN_RETRY_BUDGET_MS: '0' }).budgetMs).toBe(0)
  })
})

describe('decideTurnRetry', () => {
  const T0 = 1_760_000_000_000

  it('does nothing when disabled', () => {
    const d = decideTurnRetry({
      errorText: 'API Error: The operation timed out.',
      state: newTurnRetryState(), cfg: cfg({ enabled: false }), nowMs: T0,
    })
    expect(d).toEqual({ retry: false, reason: 'disabled' })
  })

  it('retries a transient error and waits the base backoff first', () => {
    const d = decideTurnRetry({
      errorText: 'API Error: The operation timed out.',
      state: newTurnRetryState(), cfg: cfg(), nowMs: T0,
    })
    expect(d).toEqual({ retry: true, attempt: 1, delayMs: 30_000, elapsedMs: 0 })
  })

  it('refuses a terminal error', () => {
    const d = decideTurnRetry({
      errorText: REAL_TERMINAL[0], state: newTurnRetryState(), cfg: cfg(), nowMs: T0,
    })
    expect(d).toEqual({ retry: false, reason: 'terminal' })
  })

  it('backs off exponentially, capped at backoffMaxMs', () => {
    const state = newTurnRetryState()
    const c = cfg()
    const delays: number[] = []
    let now = T0
    for (let i = 0; i < 8; i++) {
      const d = decideTurnRetry({ errorText: REAL_RETRYABLE[0], state, cfg: c, nowMs: now, v: i + 1 })
      if (!d.retry) throw new Error('expected retry')
      delays.push(d.delayMs)
      applyTurnRetry(state, now, i + 1)
      now += d.delayMs
    }
    expect(delays).toEqual([30_000, 60_000, 120_000, 240_000, 480_000, 600_000, 600_000, 600_000])
  })

  it('stops exactly at the budget edge, and allows the attempt just before it', () => {
    const state = newTurnRetryState()
    state.streakStartedAt = T0
    state.attempts = 3
    const c = cfg({ budgetMs: 12 * 3600_000 })

    const justInside = decideTurnRetry({
      errorText: REAL_RETRYABLE[0], state, cfg: c, nowMs: T0 + 12 * 3600_000 - 1_000,
    })
    expect(justInside.retry).toBe(true)

    const atEdge = decideTurnRetry({
      errorText: REAL_RETRYABLE[0], state, cfg: c, nowMs: T0 + 12 * 3600_000,
    })
    expect(atEdge).toEqual({ retry: false, reason: 'budget-exhausted' })
  })

  it('anchors the budget on the streak start, not on each attempt', () => {
    // The bug this guards: re-anchoring per attempt makes the budget infinite,
    // because every retry would reset the clock.
    const state = newTurnRetryState()
    const c = cfg({ budgetMs: 3600_000, backoffBaseMs: 60_000, backoffMaxMs: 60_000 })
    let now = T0
    let fired = 0
    for (let i = 0; i < 500; i++) {
      const d = decideTurnRetry({ errorText: REAL_RETRYABLE[0], state, cfg: c, nowMs: now, v: i + 1 })
      if (!d.retry) break
      fired++
      applyTurnRetry(state, now, i + 1)
      now += 60_000 // one attempt per minute
    }
    // A 1h budget at 1 attempt/min must stop at ~60, never run away.
    expect(fired).toBeLessThanOrEqual(61)
    expect(fired).toBeGreaterThanOrEqual(59)
  })

  it('honors the attempt cap even with budget left', () => {
    const state = newTurnRetryState()
    state.streakStartedAt = T0
    state.attempts = 5
    const d = decideTurnRetry({
      errorText: REAL_RETRYABLE[0], state, cfg: cfg({ maxAttempts: 5 }), nowMs: T0 + 1_000,
    })
    expect(d).toEqual({ retry: false, reason: 'attempts-exhausted' })
  })

  it('treats maxAttempts 0 and budget 0 as hard off switches', () => {
    expect(decideTurnRetry({
      errorText: REAL_RETRYABLE[0], state: newTurnRetryState(), cfg: cfg({ maxAttempts: 0 }), nowMs: T0,
    })).toEqual({ retry: false, reason: 'attempts-exhausted' })
    expect(decideTurnRetry({
      errorText: REAL_RETRYABLE[0], state: newTurnRetryState(), cfg: cfg({ budgetMs: 0 }), nowMs: T0,
    })).toEqual({ retry: false, reason: 'budget-exhausted' })
  })

  it('ignores a re-read of the SAME result line (watcher heal / overlap)', () => {
    const state = newTurnRetryState()
    const first = decideTurnRetry({ errorText: REAL_RETRYABLE[0], state, cfg: cfg(), nowMs: T0, v: 500 })
    expect(first.retry).toBe(true)
    applyTurnRetry(state, T0, 500)

    // Same offset again → not a new failure, must not burn an attempt.
    expect(decideTurnRetry({ errorText: REAL_RETRYABLE[0], state, cfg: cfg(), nowMs: T0 + 1, v: 500 }))
      .toEqual({ retry: false, reason: 'duplicate-line' })
    // An older offset too (re-read from a rebuilt watcher).
    expect(decideTurnRetry({ errorText: REAL_RETRYABLE[0], state, cfg: cfg(), nowMs: T0 + 2, v: 400 }))
      .toEqual({ retry: false, reason: 'duplicate-line' })
    // A genuinely newer line is a genuinely new failure.
    expect(decideTurnRetry({ errorText: REAL_RETRYABLE[0], state, cfg: cfg(), nowMs: T0 + 3, v: 900 }).retry)
      .toBe(true)
    expect(state.attempts).toBe(1)
  })
})

describe('streak lifecycle', () => {
  const T0 = 1_760_000_000_000

  it('a clean turn clears the streak, so a later outage gets a FULL fresh budget', () => {
    const state = newTurnRetryState()
    applyTurnRetry(state, T0, 10)
    applyTurnRetry(state, T0 + 60_000, 20)
    expect(state.attempts).toBe(2)
    expect(state.streakStartedAt).toBe(T0)

    expect(clearTurnRetryStreak(state)).toBe(true)
    expect(state.attempts).toBe(0)
    expect(state.streakStartedAt).toBeNull()

    // 11h later a new outage starts: budget is measured from NOW, not from T0.
    const later = T0 + 11 * 3600_000
    const d = decideTurnRetry({ errorText: REAL_RETRYABLE[0], state, cfg: cfg(), nowMs: later, v: 30 })
    expect(d).toMatchObject({ retry: true, attempt: 1, elapsedMs: 0 })
  })

  it('clearing an already-clean state reports no change (skips a needless persist)', () => {
    expect(clearTurnRetryStreak(newTurnRetryState())).toBe(false)
  })

  it('keeps lastHandledV across a clear so a re-read after success still dedupes', () => {
    const state = newTurnRetryState()
    applyTurnRetry(state, T0, 777)
    clearTurnRetryStreak(state)
    expect(state.lastHandledV).toBe(777)
  })
})

describe('messages shown to the model and the human', () => {
  it('marks the injected message as automated and forbids restarting from scratch', () => {
    const msg = turnRetryMessage(3, 'API Error: The operation timed out.')
    expect(msg).toContain('automated message, not from the user')
    expect(msg).toContain('attempt 3')
    expect(msg).toMatch(/do not restart the task from the beginning/i)
  })

  it('truncates a huge error text so the injected line stays bounded', () => {
    const msg = turnRetryMessage(1, 'x'.repeat(5_000))
    expect(msg.length).toBeLessThan(600)
  })

  it('collapses newlines in the error text (a raw newline would split the FIFO JSON line)', () => {
    const msg = turnRetryMessage(1, 'API Error: line one\nline two')
    expect(msg).not.toContain('\n')
  })

  it('tells the human the wait, the attempt, and the budget', () => {
    const text = turnRetryMarkerText({
      attempt: 2, delayMs: 120_000, errorText: 'API Error: The operation timed out.',
      budgetMs: 12 * 3600_000, elapsedMs: 30 * 60_000,
    })
    expect(text).toContain('2min')
    expect(text).toContain('attempt 2')
    expect(text).toContain('12h')
    expect(text).toContain('30min')
  })

  it('renders a sub-minute wait in seconds', () => {
    const text = turnRetryMarkerText({
      attempt: 1, delayMs: 30_000, errorText: 'e', budgetMs: 3600_000, elapsedMs: 0,
    })
    expect(text).toContain('30s')
  })

  it('explains WHY it gave up, per reason', () => {
    expect(turnRetryGiveUpText('budget-exhausted', 'e')).toContain('retry budget is spent')
    expect(turnRetryGiveUpText('attempts-exhausted', 'e')).toContain('attempt cap')
    expect(turnRetryGiveUpText('terminal', 'e')).toContain('not retryable')
    expect(turnRetryGiveUpText('terminal', 'e')).toMatch(/send a message/i)
  })
})
