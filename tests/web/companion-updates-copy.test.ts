/**
 * The words of the cloud companion's Updates row
 * (web/src/components/settings/sections/cloud/companion-updates-copy.ts): one
 * plain sentence per state, never a dash.
 */
import { describe, expect, it } from 'vitest'
import { companionUpdatesSentence } from '../../web/src/components/settings/sections/cloud/companion-updates-copy.js'
import type { CompanionBuildView } from '../../web/src/api/companion-build.js'

const v = (over: Partial<CompanionBuildView>): CompanionBuildView => ({
  state: 'current', mine: '0.6.14-5408d5875', theirs: '0.6.13-1111111', autoUpdate: true, at: 0, ...over,
})

describe('companionUpdatesSentence', () => {
  it('says which build runs, and each step of an update', () => {
    expect(companionUpdatesSentence(v({ state: 'current' }))).toBe("Runs this Mac's build (0.6.14-5408d5875).")
    expect(companionUpdatesSentence(v({ state: 'updating', step: 'uploading', progress: 0.4 }))).toBe("Updating to this Mac's build: uploading 40%.")
    expect(companionUpdatesSentence(v({ state: 'updating', step: 'installing' }))).toBe("Updating to this Mac's build: installing.")
    expect(companionUpdatesSentence(v({ state: 'updating', step: 'starting' }))).toBe("Updating to this Mac's build: starting.")
    expect(companionUpdatesSentence(v({ state: 'updating', step: 'uploading', progress: 0.5, message: 'fetch failed' })))
      .toBe("Updating to this Mac's build: uploading 50%. Paused (fetch failed); it goes on at the next check.")
  })

  it('a failure names the build, the reason, and what keeps running', () => {
    expect(companionUpdatesSentence(v({ state: 'failed', mine: '0.6.14-abc', message: 'npm install failed.', theirs: '0.6.13-xyz' })))
      .toBe('The update to 0.6.14-abc failed: npm install failed. It keeps running 0.6.13-xyz.')
    expect(companionUpdatesSentence(v({ state: 'failed', theirs: null, message: undefined })))
      .toBe('The update to 0.6.14-5408d5875 failed. It keeps running the build it has.')
  })

  it('the states where nothing is sent', () => {
    expect(companionUpdatesSentence(v({ state: 'off' }))).toBe('Off: the companion keeps the build it has.')
    expect(companionUpdatesSentence(v({ state: 'unmanaged' }))).toBe('Update it once with the cloud setup script; after that it follows this Mac.')
    expect(companionUpdatesSentence(v({ state: 'box_off', message: 'turned_off_on_box' }))).toBe('The companion does not take builds from this Mac (turned off on the box).')
    expect(companionUpdatesSentence(v({ state: 'box_off', message: 'launcher_absent' }))).toMatch(/updated once with the cloud setup script/)
  })

  it('every state has a sentence without a dash', () => {
    const states: CompanionBuildView['state'][] = ['off', 'no_companion', 'checking', 'current', 'updating', 'failed', 'unmanaged', 'box_off', 'refused_credential', 'unreachable']
    for (const state of states) {
      const text = companionUpdatesSentence(v({ state }))
      expect(text.length).toBeGreaterThan(10)
      expect(text).not.toMatch(/[\u2013\u2014]| - /)
    }
  })
})
