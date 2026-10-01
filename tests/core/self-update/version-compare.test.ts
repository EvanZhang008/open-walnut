/**
 * Version ordering for the update check. The one rule that matters to a user:
 * "newer" is only ever said when both versions parse and the published one is
 * strictly ahead, so an unknown build or a garbled registry answer never nags.
 */
import { describe, expect, it } from 'vitest'
import { compareVersions, isNewer, parseVersion } from '../../../src/core/self-update/version-compare.js'

describe('parseVersion', () => {
  it('reads core, prerelease and ignores build metadata', () => {
    expect(parseVersion('0.5.1')).toEqual({ major: 0, minor: 5, patch: 1, prerelease: [] })
    expect(parseVersion('v1.2.3')).toEqual({ major: 1, minor: 2, patch: 3, prerelease: [] })
    expect(parseVersion('1.0.0-beta.2+sha.abc')).toEqual({ major: 1, minor: 0, patch: 0, prerelease: ['beta', 2] })
    expect(parseVersion(' 2.0.0 ')).toEqual({ major: 2, minor: 0, patch: 0, prerelease: [] })
  })

  it('rejects anything that is not a version', () => {
    for (const bad of ['', '1.2', '1.2.3.4', 'latest', '1.2.x', '<html>', '0.5.1 (abc, 2026-09-30)']) {
      expect(parseVersion(bad)).toBeNull()
    }
  })
})

describe('compareVersions', () => {
  it('orders by major, minor, patch', () => {
    expect(compareVersions('0.5.1', '0.5.1')).toBe(0)
    expect(compareVersions('0.5.2', '0.5.1')).toBeGreaterThan(0)
    expect(compareVersions('0.6.0', '0.5.9')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
    expect(compareVersions('0.5.0', '0.5.1')).toBeLessThan(0)
    expect(compareVersions('0.10.0', '0.9.0')).toBeGreaterThan(0)
  })

  it('ranks a release above any prerelease of the same core, and prereleases among themselves', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.2', '1.0.0-beta.11')).toBeLessThan(0)
    expect(compareVersions('1.0.0-beta.11', '1.0.0-beta')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
  })

  it('answers null when either side does not parse', () => {
    expect(compareVersions('0.0.0', 'unknown')).toBeNull()
    expect(compareVersions('garbage', '0.5.1')).toBeNull()
  })
})

describe('isNewer', () => {
  it('is true only for a strictly newer, parseable release', () => {
    expect(isNewer('0.6.0', '0.5.1')).toBe(true)
    expect(isNewer('0.5.1', '0.5.1')).toBe(false)
    // A checkout ahead of the registry (bumped, not yet published) is never "behind".
    expect(isNewer('0.5.1', '0.5.2')).toBe(false)
    expect(isNewer('0.6.0-beta.1', '0.5.1')).toBe(true)
    expect(isNewer('not-a-version', '0.5.1')).toBe(false)
    expect(isNewer('0.6.0', '0.0.0')).toBe(true)
  })
})
