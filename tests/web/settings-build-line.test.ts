/**
 * The build identity line at the bottom of Settings: what a user reads out in a
 * support thread, so every state (release, checkout, dirty, from source) must
 * read unambiguously.
 */
import { describe, expect, it } from 'vitest'
import { buildDate, buildLineTitle, formatBuildLine } from '../../web/src/components/settings/build-line'

// Noon UTC keeps the local calendar date the same in every timezone within 11 hours of UTC.
const BUILT = '2026-09-24T12:00:00.000Z'
const info = { version: '0.4.5', commit: '3942cf7', branch: 'main', builtAt: BUILT, dirty: false }

describe('formatBuildLine', () => {
  it('names version, commit and build date', () => {
    expect(formatBuildLine(info)).toBe('Open Walnut 0.4.5 · commit 3942cf7 · built 2026-09-24')
  })

  it('marks a dirty tree on the commit', () => {
    expect(formatBuildLine({ ...info, dirty: true })).toBe('Open Walnut 0.4.5 · commit 3942cf7+dirty · built 2026-09-24')
  })

  it('leaves out what is unknown', () => {
    expect(formatBuildLine({ ...info, commit: null })).toBe('Open Walnut 0.4.5 · built 2026-09-24')
    expect(formatBuildLine({ ...info, commit: null, builtAt: null })).toBe('Open Walnut 0.4.5')
  })
})

describe('buildLineTitle', () => {
  it('carries branch and exact build time', () => {
    expect(buildLineTitle(info)).toBe(`Branch main · built ${BUILT}`)
    expect(buildLineTitle({ ...info, dirty: true })).toBe(`Branch main · built ${BUILT} · uncommitted changes`)
  })

  it('is absent when there is nothing more to say', () => {
    expect(buildLineTitle({ ...info, commit: null, branch: null, builtAt: null })).toBeUndefined()
  })
})

describe('buildDate', () => {
  it('rejects missing and invalid times', () => {
    expect(buildDate(null)).toBeNull()
    expect(buildDate('not a date')).toBeNull()
  })
})
