/**
 * scripts/lib/test-timeout-message.mjs: the baseline gate names a vitest timeout,
 * which bun leaves reading "Error: STACK_TRACE_ERROR".
 */
import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { TIMEOUT_WORDS, nameTestTimeout } from '../../scripts/lib/test-timeout-message.mjs'

const ROOT = path.resolve(import.meta.dirname, '../..')

describe('the baseline gate names a test timeout', () => {
  it('replaces the placeholder line, keeping the frames', () => {
    const msg = 'Error: STACK_TRACE_ERROR\n    at <anonymous> (/repo/tests/a.test.ts:101:31)'
    expect(nameTestTimeout(msg)).toBe(`${TIMEOUT_WORDS}\n    at <anonymous> (/repo/tests/a.test.ts:101:31)`)
  })

  it('leaves every other message alone, the word inside a sentence too', () => {
    for (const msg of ['AssertionError: expected 1 to be 2', 'Error: Test timed out in 30000ms.', 'Error: saw STACK_TRACE_ERROR in a log', undefined]) {
      expect(nameTestTimeout(msg)).toBe(msg)
    }
  })

  it('the gate reads its one-line reason and its whole message through it', () => {
    const src = fs.readFileSync(path.join(ROOT, 'scripts/test-baseline.mjs'), 'utf8')
    expect(src).toContain("import { nameTestTimeout } from './lib/test-timeout-message.mjs'")
    expect(src.match(/nameTestTimeout\(/g)?.length).toBeGreaterThanOrEqual(1)
    expect(src).toContain('.map(nameTestTimeout)')
  })
})
