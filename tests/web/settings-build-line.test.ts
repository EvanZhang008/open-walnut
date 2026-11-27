/**
 * The build identity line at the bottom of Settings: what a user reads out in a
 * support thread, so every state (release, checkout, dirty, from source) must
 * read unambiguously. The build date reads as every other date does (web/src/utils/time.ts).
 */
import { describe, expect, it } from 'vitest'
import { buildLineTitle, formatBuildLine } from '../../web/src/components/settings/build-line'
import { fullTime } from '../../web/src/utils/time'

// Noon UTC keeps the local calendar date the same in every timezone within 11 hours of UTC.
const BUILT = '2026-09-24T12:00:00.000Z'
const NOW = { now: Date.parse('2026-11-27T12:00:00.000Z') }
const info = { version: '0.4.5', commit: '3942cf7', branch: 'main', builtAt: BUILT, dirty: false }

describe('formatBuildLine', () => {
  it('names version, commit and build date', () => {
    expect(formatBuildLine(info, NOW)).toBe('Open Walnut 0.4.5, commit 3942cf7, built Sep 24')
  })

  it('says the day in words when it is near', () => {
    expect(formatBuildLine(info, { now: Date.parse(BUILT) })).toBe('Open Walnut 0.4.5, commit 3942cf7, built today')
  })

  it('marks a dirty tree on the commit', () => {
    expect(formatBuildLine({ ...info, dirty: true }, NOW)).toBe('Open Walnut 0.4.5, commit 3942cf7+dirty, built Sep 24')
  })

  it('leaves out what is unknown', () => {
    expect(formatBuildLine({ ...info, commit: null }, NOW)).toBe('Open Walnut 0.4.5, built Sep 24')
    expect(formatBuildLine({ ...info, commit: null, builtAt: null })).toBe('Open Walnut 0.4.5')
    expect(formatBuildLine({ ...info, commit: null, builtAt: 'not a date' })).toBe('Open Walnut 0.4.5')
  })
})

describe('buildLineTitle', () => {
  it('carries branch and the whole build time', () => {
    expect(buildLineTitle(info)).toBe(`Branch main, built ${fullTime(BUILT)}`)
    expect(buildLineTitle({ ...info, dirty: true })).toBe(`Branch main, built ${fullTime(BUILT)}, uncommitted changes`)
  })

  it('is absent when there is nothing more to say', () => {
    expect(buildLineTitle({ ...info, commit: null, branch: null, builtAt: null })).toBeUndefined()
  })
})
