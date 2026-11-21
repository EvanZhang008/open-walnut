/**
 * Which devices each Phones & Cloud tab lists (device-scope.ts), on the shape the
 * user's own list has: a phone paired through the companion and copied to this Mac,
 * an older phone paired with this Mac only, a signed-in browser, the Walnut
 * extension, simulators, this Mac's own link and another Mac.
 */
import { describe, expect, it } from 'vitest'
import {
  mergeDeviceRows, pairTargetForScope, removePhoneWarning, rowsForScope, wayTags,
  type DeviceScope,
} from '../../web/src/components/settings/sections/cloud/device-scope.js'
import type { DeviceEntry } from '../../web/src/components/settings/sections/cloud/devices-reply.js'

const at = (d: number) => `2026-11-${String(d).padStart(2, '0')}T12:00:00.000Z`
const LOCAL: DeviceEntry[] = [
  { name: 'desk-phone', createdAt: at(1), lastUsedAt: at(2), role: 'phone' },
  { name: 'pocket-phone', createdAt: at(10), role: 'phone', info: { model: 'iPhone18,2', os: 'iOS 27.0' } },
  { name: 'browser-ab12cd', createdAt: at(3), lastUsedAt: at(4), role: 'browser' },
  { name: 'extension-ef34', createdAt: at(5), lastUsedAt: at(17), role: 'browser' },
  { name: 'sim-one', createdAt: at(6), role: 'simulator' },
]
const CLOUD: DeviceEntry[] = [
  { name: 'pocket-phone', createdAt: at(10), lastUsedAt: at(18), role: 'phone' },
  { name: 'this-mac', createdAt: at(1), role: 'self' },
  { name: 'studio-mac', createdAt: at(7), role: 'mac' },
]
const rows = mergeDeviceRows(LOCAL, CLOUD)
const names = (scope: DeviceScope) => rowsForScope(rows, scope).map((r) => r.name).sort()

describe('mergeDeviceRows', () => {
  it('makes one row per device name, with both records and the latest use', () => {
    const pocket = rows.filter((r) => r.name === 'pocket-phone')
    expect(pocket).toHaveLength(1)
    expect(pocket[0].kinds).toEqual(['lan', 'cloud'])
    expect(pocket[0].lastUsedAt).toBe(at(18))
    expect(pocket[0].info?.model).toBe('iPhone18,2')
  })
  it("keeps this Mac's own cloud record out of the rows", () => {
    expect(rows.some((r) => r.role === 'self')).toBe(false)
  })
  it('puts phones before Macs, simulators and browsers', () => {
    expect(rows.slice(0, 2).every((r) => r.role === 'phone')).toBe(true)
  })
})

describe('rowsForScope', () => {
  it('Cloud companion: the phones and Macs with a record on the companion', () => {
    expect(names('cloud')).toEqual(['pocket-phone', 'studio-mac'])
  })
  it("Tailscale: the phones with a record on this Mac (Tailscale reaches this Mac's own pairing)", () => {
    expect(names('tailscale')).toEqual(['desk-phone', 'pocket-phone'])
  })
  it('Same Wi-Fi: the phones with a record on this Mac, and browsers signed in with a code (signed out where they were signed in)', () => {
    expect(names('wifi')).toEqual(['browser-ab12cd', 'desk-phone', 'pocket-phone'])
  })
  it('Tunnel: the browsers and the extension, never a phone', () => {
    expect(names('browser')).toEqual(['browser-ab12cd', 'extension-ef34'])
  })
  it('All devices: phones, browsers, the extension and Macs; simulators only in Advanced', () => {
    expect(names('all')).toEqual(['browser-ab12cd', 'desk-phone', 'extension-ef34', 'pocket-phone', 'studio-mac'])
    expect(names('advanced')).toEqual(['sim-one'])
    for (const scope of ['all', 'cloud', 'tailscale', 'browser', 'wifi'] as const) expect(names(scope)).not.toContain('sim-one')
  })
  it('a phone with both records shows once in each tab of its ways', () => {
    for (const scope of ['cloud', 'tailscale', 'all'] as const) {
      expect(rowsForScope(rows, scope).filter((r) => r.name === 'pocket-phone')).toHaveLength(1)
    }
  })
})

describe('wayTags', () => {
  const pocket = rows.find((r) => r.name === 'pocket-phone')!
  const desk = rows.find((r) => r.name === 'desk-phone')!
  it('names the ways by their tabs, and never guesses Tailscale (only the phone knows whether it runs it)', () => {
    expect(wayTags(pocket, { scope: 'all' })).toEqual(['Cloud companion', 'Same Wi-Fi'])
    expect(wayTags(desk, { scope: 'all' })).toEqual(['Same Wi-Fi'])
    expect(wayTags(desk, { scope: 'tailscale' })).toEqual(['Same Wi-Fi'])
  })
  it("leaves out the tab's own way", () => {
    expect(wayTags(pocket, { scope: 'cloud' })).toEqual(['Same Wi-Fi'])
    expect(wayTags(pocket, { scope: 'wifi' })).toEqual(['Cloud companion'])
    expect(wayTags(pocket, { scope: 'tailscale' })).toEqual(['Cloud companion', 'Same Wi-Fi'])
  })
  it("on the companion's own console every record there is the cloud companion way", () => {
    // A replica's `devices` are its own records: never "Same Wi-Fi".
    const onCompanion = mergeDeviceRows([{ name: 'pocket-phone', createdAt: at(1), role: 'phone' }], [])[0]
    expect(wayTags(onCompanion, { scope: 'all', replica: true })).toEqual(['Cloud companion'])
  })
  it('gives a browser none (its group says how it got in)', () => {
    expect(wayTags(rows.find((r) => r.name === 'browser-ab12cd')!, { scope: 'all' })).toEqual([])
  })
})

describe('pairing and removal', () => {
  it("each way's tab pairs through its own address; All devices only on the companion's console; the tunnel never", () => {
    expect(pairTargetForScope('cloud')).toBe('cloud')
    expect(pairTargetForScope('tailscale')).toBe('tailnet')
    // Wi-Fi pairs on its own tab (2026-11-21, the user: "Put it in closest so people know"), with or without a detected address.
    expect(pairTargetForScope('wifi', ['lan'])).toBe('lan')
    expect(pairTargetForScope('wifi', [])).toBe('lan')
    expect(pairTargetForScope('wifi', ['cloud'], { replica: true })).toBeNull()
    // On this Mac All devices pairs nothing: every way has its own tab that does.
    for (const offered of [['lan'], [], ['lan', 'cloud'], ['lan', 'tailnet']] as const) expect(pairTargetForScope('all', offered)).toBeNull()
    // The companion's own console pairs through its own address, another replica not at all.
    expect(pairTargetForScope('all', ['cloud'], { replica: true })).toBe('cloud')
    expect(pairTargetForScope('all', [], { replica: true })).toBeNull()
    // A browser signed in with a code is refused every code: no pairing anywhere.
    for (const scope of ['all', 'cloud', 'tailscale', 'wifi'] as const) expect(pairTargetForScope(scope, ['lan'], { deviceCaller: true })).toBeNull()
    expect(pairTargetForScope('browser')).toBeNull()
    expect(pairTargetForScope('advanced')).toBeNull()
  })
  it('Remove says it removes the whole phone, naming every way it uses', () => {
    const pocket = rows.find((r) => r.name === 'pocket-phone')!
    const desk = rows.find((r) => r.name === 'desk-phone')!
    const w = removePhoneWarning(pocket, {})
    expect(w).toBe('Removing pocket-phone signs it out of this Walnut on every way it uses: the cloud companion and this Mac directly (Wi-Fi, or Tailscale). '
      + 'Its saved login stops working; to use it again, scan a new QR code.')
    expect(w).not.toMatch(/disconnect/i)
    // Only the ways it has: never the companion for a phone not on it.
    expect(removePhoneWarning(desk, {})).toContain('every way it uses: this Mac directly (Wi-Fi, or Tailscale).')
    expect(removePhoneWarning(desk, {}, 'Desk phone')).toMatch(/^Removing Desk phone /)
  })
})
