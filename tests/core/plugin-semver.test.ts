import { describe, expect, it } from 'vitest'
import { satisfiesSemVer } from '../../src/core/plugins/semver.js'

describe('satisfiesSemVer', () => {
  it.each([
    ['0.4.1', '>=0.4.0', true],
    ['0.3.9', '>=0.4.0', false],
    ['0.4.5', '>=0.4.0 <0.5.0', true],
    ['1.2.3', '^1.1.0', true],
    ['2.0.0', '^1.1.0', false],
    ['0.4.8', '^0.4.2', true],
    ['0.5.0', '^0.4.2', false],
    ['1.2.9', '~1.2.3', true],
    ['1.3.0', '~1.2.3', false],
    ['1.8.4', '1.x', true],
    ['2.0.0', '1.x', false],
    ['1.5.0', '1.0.0 - 2.0.0', true],
    ['2.1.0', '<1.0.0 || >=2.0.0', true],
    ['1.0.0-beta.1', '>=1.0.0', false],
    ['0.3.2', '>=0.3', true],
    ['0.3.2', '^0.3', true],
    ['0.4.0', '^0.3', false],
    ['1.2.9', '~1.2', true],
    ['1.3.0', '~1.2', false],
    ['1.8.4', '1', true],
    ['1.8.4', '1.8', true],
    ['1.9.0', '1.8', false],
  ])('%s against %s → %s', (version, range, expected) => {
    expect(satisfiesSemVer(version, range)).toBe(expected)
  })

  it('rejects malformed versions and ranges', () => {
    expect(satisfiesSemVer('dev', '>=1.0.0')).toBe(false)
    expect(satisfiesSemVer('1.0.0', 'latest')).toBe(false)
  })
})
