/**
 * What each connected extension last said it runs (src/core/browser-control/extension-seen.ts),
 * and the words Settings, Browser extension shows for it
 * (web/src/components/settings/sections/browser-extension-model.ts): connected now or when last
 * heard from, the version against the one Walnut ships, how it updates for every install kind,
 * and whether agents may use it.
 */
import { beforeEach, describe, expect, it } from 'vitest'
import { _resetExtensionsSeenForTesting, extensionsSeen, forgetExtension, noteExtension } from '../../../src/core/browser-control/extension-seen'
import { LIVE_MS, extRows, updateOf, type ExtSeen } from '../../../web/src/components/settings/sections/browser-extension-model'

beforeEach(() => _resetExtensionsSeenForTesting())

describe('extension-seen', () => {
  it('keeps the last report per device; a poll that names no build keeps the one the update check said', () => {
    noteExtension('extension-aaaaaa', { version: '0.6.25', build: 'abcdef123456', install: 'walnut-folder' }, 1000)
    noteExtension('extension-aaaaaa', { version: '0.6.25' }, 2000)
    expect(extensionsSeen()).toEqual([{ device: 'extension-aaaaaa', version: '0.6.25', build: 'abcdef123456', install: 'walnut-folder', at: 2000 }])
  })

  it('takes only what it can show: a build that is not hex, an unknown install kind, a long version', () => {
    noteExtension('extension-bbbbbb', { version: 'x'.repeat(100), build: '<script>', install: 'sideways' }, 1)
    expect(extensionsSeen()).toEqual([{ device: 'extension-bbbbbb', version: 'x'.repeat(40), at: 1 }])
  })

  it('a removed device is forgotten', () => {
    noteExtension('extension-cccccc', { version: '1.0.0' })
    forgetExtension('extension-cccccc')
    expect(extensionsSeen()).toEqual([])
  })
})

describe('the words Settings shows', () => {
  const shipped = { version: '0.6.25', build: 'bbbbbb222222' }
  const now = Date.parse('2026-11-15T12:00:00Z')
  const seen = (over: Partial<ExtSeen>): ExtSeen => ({ device: 'extension-aaaaaa', version: '0.6.25', build: 'bbbbbb222222', install: 'walnut-folder', at: new Date(now - 60_000).toISOString(), ...over })
  const device = { name: 'extension-aaaaaa', info: { deviceName: 'Walnut extension (Chrome on Mac)' }, createdAt: '2026-11-01T00:00:00Z', lastUsedAt: '2026-11-14T00:00:00Z' }

  it.each([
    ['the build Walnut ships', {}, 'current'],
    ['an older build in Walnut\'s folder', { build: 'aaaaaa111111' }, 'updating'],
    ['an older build loaded from another folder', { build: 'aaaaaa111111', install: 'unpacked' as const }, 'reload'],
    ['a store copy', { install: 'store' as const, build: 'aaaaaa111111' }, 'store'],
    // Older than these reports: no build named, so nothing is known about how it updates (builds change without a new version).
    ['a copy that names no build, same version', { build: undefined, install: undefined }, 'unknown'],
    ['a copy that names no build, older version', { build: undefined, install: undefined, version: '0.6.1' }, 'unknown'],
    // Its poll named the build before its update check said how it was installed.
    ['this build, install not said yet', { install: undefined }, 'current'],
    ['an older build, install not said yet', { build: 'aaaaaa111111', install: undefined }, 'unknown'],
  ])('%s', (_name, over, want) => {
    expect(updateOf(seen(over), shipped)).toBe(want)
  })

  it('an extension that never said its version (older than this report) reads as not reported', () => {
    expect(updateOf(undefined, shipped)).toBe('unknown')
    const [r] = extRows([device], [], new Map(), shipped, now)
    expect(r).toMatchObject({ live: false, update: 'unknown' })
    expect(r.line).toMatch(/^Last heard .*Version not reported yet.*Agents off\.$/)
  })

  it('connected now when heard from within LIVE_MS or polling for agents; the agents part names what it lets in', () => {
    const [on] = extRows([device], [seen({})], new Map([['extension-aaaaaa', ['view-stream']]]), shipped, now)
    expect(on).toMatchObject({ live: true, update: 'current', label: 'Walnut extension (Chrome on Mac)' })
    expect(on.line).toBe('Connected. Version 0.6.25 (build bbbbbb2), up to date. Agents on.')
    const [handed] = extRows([device], [seen({ at: new Date(now - LIVE_MS - 1000).toISOString() })], new Map([['extension-aaaaaa', ['handed-tabs-only']]]), shipped, now)
    expect(handed.live).toBe(true)
    expect(handed.line).toMatch(/Agents only in tabs you hand over\.$/)
    const [old] = extRows([device], [seen({ at: new Date(now - LIVE_MS - 1000).toISOString() })], new Map(), shipped, now)
    expect(old.live).toBe(false)
    expect(old.line).toMatch(/^Last heard 15 min ago\. /)
  })
})
