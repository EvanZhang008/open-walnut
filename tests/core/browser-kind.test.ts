import { describe, it, expect } from 'vitest'
import { browserKindFromUserAgent, numberedDeviceName } from '../../src/core/browser-kind'
import { browserRowLabels } from '../../web/src/components/settings/sections/browser-labels'

const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
const IPHONE_CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/120.0 Mobile/15E148 Safari/604.1'
const MAC_CHROME = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/120.0.0.0 Safari/537.36'
const MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15'
const WIN_EDGE = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0'
const ANDROID_FIREFOX = 'Mozilla/5.0 (Android 14; Mobile; rv:120.0) Gecko/120.0 Firefox/120.0'

describe('browserKindFromUserAgent (N2-21)', () => {
  it('names the device and the browser', () => {
    expect(browserKindFromUserAgent(IPHONE_SAFARI)).toBe('iPhone Safari')
    expect(browserKindFromUserAgent(IPHONE_CHROME)).toBe('iPhone Chrome')
    expect(browserKindFromUserAgent(MAC_CHROME)).toBe('Mac Chrome')
    expect(browserKindFromUserAgent(MAC_SAFARI)).toBe('Mac Safari')
    expect(browserKindFromUserAgent(WIN_EDGE)).toBe('Windows Edge')
    expect(browserKindFromUserAgent(ANDROID_FIREFOX)).toBe('Android phone Firefox')
  })
  it('a phone that says it is a Home Screen app is named apart from its Safari tab (D6)', () => {
    expect(browserKindFromUserAgent(IPHONE_SAFARI, { standalone: true })).toBe('iPhone Home Screen')
    expect(browserKindFromUserAgent(ANDROID_FIREFOX, { standalone: true })).toBe('Android phone Home Screen')
    // No word from the page: still the browser, even with a UA an in-app browser could send.
    expect(browserKindFromUserAgent(IPHONE_SAFARI.replace(' Safari/604.1', ''))).toBe('iPhone Safari')
    // A computer's installed app is still its browser.
    expect(browserKindFromUserAgent(MAC_CHROME, { standalone: true })).toBe('Mac Chrome')
  })
  it('falls back to Browser, never an id', () => {
    expect(browserKindFromUserAgent(undefined)).toBe('Browser')
    expect(browserKindFromUserAgent('curl/8.0')).toBe('Browser')
  })
})

describe('browserRowLabels (N2-21)', () => {
  it('numbers repeats by sign-in order and never shows the id', () => {
    const labels = browserRowLabels([
      { name: 'browser-bbbbbb', createdAt: '2026-01-02T00:00:00Z', info: { deviceName: 'iPhone Safari' } },
      { name: 'browser-aaaaaa', createdAt: '2026-01-01T00:00:00Z', info: { deviceName: 'iPhone Safari' } },
      { name: 'browser-cccccc', createdAt: '2026-01-03T00:00:00Z', info: { deviceName: 'Mac Chrome' } },
      { name: 'browser-dddddd', createdAt: '2026-01-04T00:00:00Z' },
    ])
    expect(labels.get('browser-aaaaaa')).toBe('iPhone Safari')
    expect(labels.get('browser-bbbbbb')).toBe('iPhone Safari 2')
    expect(labels.get('browser-cccccc')).toBe('Mac Chrome')
    expect(labels.get('browser-dddddd')).toBe('Browser')
  })

  it('a name numbered at sign-in is kept: removing one never renames the next', () => {
    const rows = [
      { name: 'browser-aaaaaa', createdAt: '2026-01-01T00:00:00Z', info: { deviceName: 'iPhone Safari' } },
      { name: 'browser-bbbbbb', createdAt: '2026-01-02T00:00:00Z', info: { deviceName: 'iPhone Safari 2' } },
      { name: 'browser-cccccc', createdAt: '2026-01-03T00:00:00Z', info: { deviceName: 'iPhone Safari 3' } },
    ]
    const after = browserRowLabels(rows.filter((r) => r.name !== 'browser-bbbbbb'))
    expect(after.get('browser-aaaaaa')).toBe('iPhone Safari')
    expect(after.get('browser-cccccc')).toBe('iPhone Safari 3')
    // A record from before numbering repeats a kind: numbered past every recorded name.
    const mixed = browserRowLabels([...rows, { name: 'browser-dddddd', createdAt: '2026-01-04T00:00:00Z', info: { deviceName: 'iPhone Safari' } }])
    expect(mixed.get('browser-dddddd')).toBe('iPhone Safari 4')
    expect(new Set(mixed.values()).size).toBe(4)
  })
})

describe('numberedDeviceName (written at sign-in)', () => {
  it('one above the highest listed of that kind; the bare kind when none', () => {
    expect(numberedDeviceName('iPhone Safari', [])).toBe('iPhone Safari')
    expect(numberedDeviceName('iPhone Safari', ['iPhone Safari'])).toBe('iPhone Safari 2')
    expect(numberedDeviceName('iPhone Safari', ['iPhone Safari 3', 'Mac Chrome', undefined])).toBe('iPhone Safari 4')
    expect(numberedDeviceName('Mac Chrome', ['Mac Chrome Beta', 'Mac Chrome 2'])).toBe('Mac Chrome 3')
  })

  it('two records from before numbering (Settings shows them 1 and 2): the next is 3, and no row is renamed', () => {
    const before = [
      { name: 'browser-aaaaaa', createdAt: '2026-01-01T00:00:00Z', info: { deviceName: 'iPhone Safari' } },
      { name: 'browser-bbbbbb', createdAt: '2026-01-02T00:00:00Z', info: { deviceName: 'iPhone Safari' } },
    ]
    const shown = browserRowLabels(before)
    const next = numberedDeviceName('iPhone Safari', before.map((r) => r.info.deviceName))
    expect(next).toBe('iPhone Safari 3')
    const after = browserRowLabels([...before, { name: 'browser-cccccc', createdAt: '2026-01-03T00:00:00Z', info: { deviceName: next } }])
    expect(after.get('browser-aaaaaa')).toBe(shown.get('browser-aaaaaa'))
    expect(after.get('browser-bbbbbb')).toBe(shown.get('browser-bbbbbb'))
    expect(after.get('browser-cccccc')).toBe('iPhone Safari 3')
  })
})
