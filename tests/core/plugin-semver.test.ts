import { describe, expect, it } from 'vitest'
import { isValidRange, satisfiesDependencyRange, satisfiesSemVer } from '../../src/core/plugins/semver.js'

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

  it('stays lenient for engines.walnut, so a Walnut prerelease still runs today plugins', () => {
    // The prerelease exclusion below belongs to the DEPENDENCY resolver only. A Walnut
    // 0.5.0-beta.1 must keep running every plugin that 0.4.x ran, or a beta host is
    // a host with no plugins.
    expect(satisfiesSemVer('0.5.0-beta.1', '>=0.4.0')).toBe(true)
    expect(satisfiesSemVer('0.5.0-beta.1', '>=0.4.0 <1.0.0')).toBe(true)
  })
})

describe('satisfiesDependencyRange', () => {
  it('never lets an ordinary range adopt a prerelease', () => {
    // The `^2.0.0` case is the trap: 2.0.0-beta.1 sorts BELOW 2.0.0, so the plain
    // comparator puts it inside `^1` and outside `^2` — both answers wrong for someone
    // who asked for a released 1.x or 2.x.
    expect(satisfiesDependencyRange('2.0.0-beta.1', '^1.0.0')).toBe(false)
    expect(satisfiesDependencyRange('2.0.0-beta.1', '^2.0.0')).toBe(false)
    expect(satisfiesDependencyRange('2.0.0-beta.1', '>=1.0.0')).toBe(false)
    expect(satisfiesDependencyRange('2.0.0-beta.1', '*')).toBe(false)
  })

  it('takes a prerelease when the range names that exact release', () => {
    // The opt-in: naming a prerelease of the same x.y.z is a deliberate act.
    expect(satisfiesDependencyRange('2.0.0-beta.1', '>=2.0.0-beta.1')).toBe(true)
    expect(satisfiesDependencyRange('2.0.0-beta.2', '>=2.0.0-beta.1')).toBe(true)
    expect(satisfiesDependencyRange('2.0.0-alpha.1', '>=2.0.0-beta.1')).toBe(false)
  })

  it('behaves exactly like satisfiesSemVer for released versions', () => {
    for (const [version, range] of [
      ['1.2.0', '^1'], ['1.2.0', '^2'], ['0.4.8', '^0.4.2'], ['2.0.0', '>=1.0.0'], ['1.0.0', 'latest'],
    ] as const) {
      expect(satisfiesDependencyRange(version, range)).toBe(satisfiesSemVer(version, range))
    }
  })
})

describe('isValidRange', () => {
  it.each(['^1', '^1.0.0', '~1.2', '>=0.4.0 <0.5.0', '1.x', '*', 'x', '1.0.0 - 2.0.0', '<1.0.0 || >=2.0.0'])(
    'accepts %s',
    (range) => { expect(isValidRange(range)).toBe(true) },
  )

  it.each(['', '   ', 'latest', 'main', '^', '>=', 'v1.0.0.0', '1.0.0 - latest', '^1.0.0 || nope'])(
    'rejects %s',
    (range) => { expect(isValidRange(range)).toBe(false) },
  )

  it('never accepts a range satisfiesSemVer cannot evaluate', () => {
    // The one failure mode that would matter: a range validation waves through but the
    // matcher can never satisfy reads to a plugin author as "my dependency is broken"
    // instead of "I typed the range wrong".
    const versions = ['0.4.2', '1.0.0', '1.2.0', '1.2.9', '2.0.0', '99.0.0']
    for (const range of ['^1', '^1.0.0', '~1.2', '>=0.4.0 <0.5.0', '1.x', '*', 'x', '1.0.0 - 2.0.0', '<1.0.0 || >=2.0.0']) {
      expect(versions.some((version) => satisfiesSemVer(version, range)), range).toBe(true)
    }
  })
})
