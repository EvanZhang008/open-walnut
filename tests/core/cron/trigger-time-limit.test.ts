/**
 * A trigger check's time limit, said where a run is read (src/core/cron/trigger-time-limit.ts).
 *
 * 2026-11-08, a trigger sweep: check scripts whose per-call timeouts times their
 * retries came to more than the trigger's limit were killed before the retry ran,
 * nothing showed the limit, and a killed run read "check timed out after 434s".
 * The guards here fail when the daemon words a deadline kill in a way Walnut no
 * longer recognizes, or when its limits drift from the copy the web app reads.
 */
import { describe, expect, it } from 'vitest'
import {
  CHECK_TIMEOUT_DEFAULT_S, CHECK_TIMEOUT_MAX_S, checkErrorOf, clampTimeoutSeconds, type CheckProcessResult,
} from '../../../src/providers/trigger-check-core.js'
import {
  TIME_LIMIT_DEFAULT_S, TIME_LIMIT_MAX_S, checkErrorText, clearTestRunsForTest, createLimitWarning, isTimeLimitError,
  killedAtLimitText, limitUse, runLimitSeconds, limitUseLine, limitWarning, recentTestRun, rememberTestRun, secondsLabel, timeLimitSeconds,
  TEST_MEMORY_MS,
} from '../../../src/core/cron/trigger-time-limit.js'

const proc = (over: Partial<CheckProcessResult>): CheckProcessResult => ({
  exitCode: null, signal: 'SIGKILL', stdout: '', stderrTail: '', timedOut: false, stdoutOverflow: false, durationMs: 0, ...over,
})

describe('the daemon\'s deadline kill is recognized', () => {
  it('every duration the daemon can report reads as a kill at the limit, and nothing else does', () => {
    // checkErrorOf is the one place both daemon twins word a check error.
    for (const durationMs of [0, 1_000, 30_000, 120_499, 434_000, 300_000]) {
      const error = checkErrorOf(proc({ timedOut: true, durationMs }), null)
      expect(isTimeLimitError(error), String(error)).toBe(true)
      expect(checkErrorText(error ?? undefined, 120)).toBe('check killed at the 120 s limit (timeoutSeconds): it was still running')
    }
    for (const other of [
      checkErrorOf(proc({ exitCode: 1, signal: null, stderrTail: 'curl: (28) Operation timed out after 30001 ms' }), null),
      checkErrorOf(proc({ stdoutOverflow: true }), null),
      'exit 1: no JSON on the last line',
      undefined,
    ]) {
      expect(isTimeLimitError(other)).toBe(false)
      expect(checkErrorText(other ?? undefined, 120)).toBe(other ?? undefined)
    }
  })

  it('a reworded error keeps the limit it names, even after the limit changed', () => {
    const once = killedAtLimitText(30)
    expect(isTimeLimitError(once)).toBe(true)
    expect(checkErrorText(once, 30)).toBe(once)
    // Raised to 120 s later: the run killed at 30 s is still said to be killed at 30 s.
    expect(checkErrorText(once, 120)).toBe(once)
  })

  it('a recorded run is read against its own limit, an older record against the check\'s', () => {
    expect(runLimitSeconds({ limitSeconds: 30 }, { timeoutSeconds: 120 })).toBe(30)
    expect(runLimitSeconds({}, { timeoutSeconds: 120 })).toBe(120)
    expect(runLimitSeconds(undefined, {})).toBe(30)
  })

  it('the limits match the daemon\'s, so the web copy never shows another limit than the one that kills', () => {
    expect(TIME_LIMIT_DEFAULT_S).toBe(CHECK_TIMEOUT_DEFAULT_S)
    expect(TIME_LIMIT_MAX_S).toBe(CHECK_TIMEOUT_MAX_S)
    for (const v of [undefined, null, 'x', 0, -5, 1, 29.9, 30, 120, 300, 301, 9_999, Number.NaN]) {
      expect(timeLimitSeconds({ timeoutSeconds: v })).toBe(clampTimeoutSeconds(v))
    }
    expect(timeLimitSeconds(undefined)).toBe(30)
  })
})

describe('a run against its limit', () => {
  it('reads the share and warns over half', () => {
    expect(limitUse(undefined, 30)).toBeNull()
    expect(limitUse(12_000, 30)).toMatchObject({ share: 0.4, near: false, killed: false })
    expect(limitWarning(limitUse(12_000, 30))).toBeUndefined()
    const near = limitUse(72_000, 120)!
    expect(near).toMatchObject({ share: 0.6, near: true })
    expect(limitUseLine(near)).toBe('ran 72 s of its 120 s limit')
    expect(limitWarning(near)).toMatch(/^The run took 72 s, 60% of its 120 s time limit: .*its timeouts times its retries fit inside 120 s/)
    const killed = limitUse(undefined, 120, true)!
    expect(limitUseLine(killed)).toBe('was killed at its 120 s limit')
    expect(limitWarning(killed, 'The last check')).toMatch(/^The last check was killed at its 120 s time limit before it finished\./)
  })

  it('labels seconds plainly', () => {
    expect(secondsLabel(400)).toBe('0.4 s')
    expect(secondsLabel(34_200)).toBe('34 s')
    expect(secondsLabel(125_000)).toBe('2 m 5 s')
  })
})

describe('trigger_create reads the last test run', () => {
  const check = { run: 'bash ~/.open-walnut/triggers/ci/check.sh', host: 'devbox', cwd: '/repo' }

  it('remembers a test for an hour, per run, host and cwd', () => {
    clearTestRunsForTest()
    rememberTestRun(check, { atMs: 1_000, durationMs: 20_000, limitSeconds: 30, killed: false })
    expect(recentTestRun(check, 1_000 + TEST_MEMORY_MS)).toMatchObject({ durationMs: 20_000 })
    expect(recentTestRun(check, 2_000 + TEST_MEMORY_MS)).toBeNull()
    expect(recentTestRun({ ...check, host: 'other' }, 1_000)).toBeNull()
    expect(recentTestRun({ ...check, cwd: undefined }, 1_000)).toBeNull()
  })

  it('warns when the test came close to the limit the trigger gets, and not when the limit was raised enough', () => {
    const test = { atMs: 0, durationMs: 20_000, limitSeconds: 30, killed: false }
    expect(createLimitWarning(test, 30)).toMatch(/^Its last trigger_test run took 20 s, 67% of its 30 s time limit/)
    expect(createLimitWarning(test, 120)).toBeUndefined()
    expect(createLimitWarning(null, 30)).toBeUndefined()
  })

  it('a test killed at the limit warns, and says so when the trigger got a larger limit nobody tried', () => {
    const killed = { atMs: 0, durationMs: 30_000, limitSeconds: 30, killed: true }
    expect(createLimitWarning(killed, 30)).toMatch(/^Its last trigger_test run was killed at its 30 s time limit/)
    expect(createLimitWarning(killed, 120)).toMatch(/killed at 30 s, so nobody saw it finish inside this trigger's 120 s limit/)
  })
})
