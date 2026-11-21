/** A fixture for tests/scripts/pain-guards.test.ts: the guard runner finds and runs this test by its title. */
import { describe, it, expect } from 'vitest'

describe('pain guards fixture', () => {
  it('passes for the guard runner', () => {
    expect(1 + 1).toBe(2)
  })
})
