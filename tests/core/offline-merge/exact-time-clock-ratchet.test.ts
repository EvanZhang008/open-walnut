/**
 * A drain shifts a queued write's time by the host's measured clock offset, and against a
 * fake daemon on this clock that offset is the rounding of rtt/2: 0 or 1 ms, read again on
 * every drain page. A test that compares a stored time to the write's `at` exactly passes
 * or fails on that rounding (2026-11-01, CI run 41315324674: a wait_until 1 ms late; before
 * it, task-fields field_at in runs 39562756085 and 39572152613). Such a test pins the link
 * with `_setHostClockForTesting(host, 0)`: a zero round trip no measurement replaces.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = __dirname
const EXACT_AT = /toBe\(new Date\(at\b/

describe('offline merge tests that compare a stored time to the write time exactly', () => {
  it('every one pins the host clock', () => {
    const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.test.ts') && f !== path.basename(__filename))
    const exact = files.filter((f) => EXACT_AT.test(fs.readFileSync(path.join(DIR, f), 'utf8')))
    expect(exact).toEqual(expect.arrayContaining(['drain-correctness.test.ts', 'task-fields.test.ts']))
    expect(exact.filter((f) => !fs.readFileSync(path.join(DIR, f), 'utf8').includes('_setHostClockForTesting('))).toEqual([])
  })
})
