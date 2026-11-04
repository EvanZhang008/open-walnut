/**
 * mergeDevicesReply (web/src/components/settings/sections/cloud/devices-reply.ts):
 * a shown value stays until a real one replaces it. A reply whose cloud half
 * failed keeps the phones listed before, a reply without Tailscale's summary
 * keeps the one known before, and the error sits beside the kept list.
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_DEVICES_VIEW, cloudErrorLine, isDevicesView, mergeDevicesReply, type DevicesListResponse, type DevicesView,
} from '../../web/src/components/settings/sections/cloud/devices-reply.js'

const T0 = '2026-11-04T10:00:00.000Z'
const T1 = '2026-11-04T10:05:00.000Z'
const phone = (name: string) => ({ name, createdAt: T0, role: 'phone' as const })
const ERR = "The cloud companion could not answer just now, so the phones paired there can't be listed."

const good: DevicesListResponse = {
  devices: [phone('local-phone')], cloudDevices: [phone('cloud-phone')],
  targets: [{ kind: 'lan', origin: 'http://192.168.1.2:3456', label: 'LAN' } as never],
  tailscale: { installed: true, running: true },
}
const shown = (): DevicesView => mergeDevicesReply(EMPTY_DEVICES_VIEW, good, T0)

describe('mergeDevicesReply', () => {
  it('a good reply is shown as it is, stamped with when it was read', () => {
    const v = shown()
    expect(v.cloudDevices.map((d) => d.name)).toEqual(['cloud-phone'])
    expect(v.cloudReadAt).toBe(T0)
    expect(v.cloudStale).toBe(false)
    expect(v.tailscale).toEqual({ installed: true, running: true })
    expect(v.tailscaleStale).toBe(false)
    expect(v.cloudError).toBeNull()
  })

  it('an older server\'s failed cloud half ([] plus an error) keeps the phones shown before, with the error', () => {
    const v = mergeDevicesReply(shown(), { devices: [phone('local-phone')], cloudDevices: [], cloudError: ERR }, T1)
    expect(v.cloudDevices.map((d) => d.name)).toEqual(['cloud-phone'])
    expect(v.cloudReadAt).toBe(T0)
    expect(v.cloudStale).toBe(true)
    expect(v.cloudError).toBe(ERR)
  })

  it('a newer server\'s kept list is shown with its own time', () => {
    const v = mergeDevicesReply(EMPTY_DEVICES_VIEW, {
      devices: [], cloudDevices: [phone('kept-phone')], cloudError: ERR, cloudStale: true, cloudDevicesAt: T0,
    }, T1)
    expect(v.cloudDevices.map((d) => d.name)).toEqual(['kept-phone'])
    expect(v.cloudReadAt).toBe(T0)
    expect(v.cloudStale).toBe(true)
  })

  it('a failure with nothing known before shows nothing kept, only the error', () => {
    const v = mergeDevicesReply(EMPTY_DEVICES_VIEW, { devices: [], cloudDevices: [], cloudError: ERR }, T1)
    expect(v.cloudDevices).toEqual([])
    expect(v.cloudStale).toBe(false)
    expect(v.cloudError).toBe(ERR)
  })

  it('the next good reply replaces the kept list and clears the error', () => {
    const failed = mergeDevicesReply(shown(), { devices: [], cloudDevices: [], cloudError: ERR }, T1)
    const v = mergeDevicesReply(failed, { devices: [], cloudDevices: [] }, T1)
    expect(v.cloudDevices).toEqual([])
    expect(v.cloudStale).toBe(false)
    expect(v.cloudReadAt).toBe(T1)
    expect(v.cloudError).toBeNull()
  })

  it('an unpair or a withheld half is gone on purpose: nothing is kept', () => {
    expect(mergeDevicesReply(shown(), { devices: [], cloudDevices: [], cloudUnpaired: { origin: 'https://c' } }, T1).cloudDevices).toEqual([])
    expect(mergeDevicesReply(shown(), { devices: [], cloudDevices: [], cloudWithheld: 'withheld' }, T1).cloudDevices).toEqual([])
  })

  it('a reply without Tailscale keeps the summary shown before, marked stale; a fresh one replaces it', () => {
    const cold = mergeDevicesReply(shown(), { devices: [], cloudDevices: [] }, T1)
    expect(cold.tailscale).toEqual({ installed: true, running: true })
    expect(cold.tailscaleStale).toBe(true)
    const kept = mergeDevicesReply(EMPTY_DEVICES_VIEW, { devices: [], tailscale: { installed: true, running: false }, tailscaleStale: true }, T1)
    expect(kept.tailscaleStale).toBe(true)
    const fresh = mergeDevicesReply(cold, { devices: [], tailscale: { installed: false, running: false } }, T1)
    expect(fresh.tailscale).toEqual({ installed: false, running: false })
    expect(fresh.tailscaleStale).toBe(false)
    expect(mergeDevicesReply(EMPTY_DEVICES_VIEW, { devices: [] }, T1).tailscale).toBeUndefined()
  })

  it('the Tailscale summary carries when it was probed: now when fresh, the server\'s time when kept there, its own when kept here', () => {
    expect(shown().tailscaleAt).toBe(T0)
    expect(mergeDevicesReply(shown(), { devices: [] }, T1).tailscaleAt).toBe(T0)
    const serverKept = mergeDevicesReply(EMPTY_DEVICES_VIEW, { devices: [], tailscale: { installed: true, running: true }, tailscaleStale: true, tailscaleAt: T0 }, T1)
    expect(serverKept).toMatchObject({ tailscaleStale: true, tailscaleAt: T0 })
    expect(mergeDevicesReply(serverKept, { devices: [], tailscale: { installed: true, running: true } }, T1)).toMatchObject({ tailscaleStale: false, tailscaleAt: T1 })
    // A copy an older page stored has no time: still accepted.
    const { tailscaleAt: _drop, ...older } = shown()
    expect(isDevicesView(older)).toBe(true)
  })

  it('the error line says how old the kept list is', () => {
    const v = mergeDevicesReply(shown(), { devices: [], cloudDevices: [], cloudError: ERR }, T1)
    expect(cloudErrorLine(v, (iso) => `at ${iso}`)).toBe(`${ERR} The phones below are as it listed them at ${T0}.`)
    expect(cloudErrorLine(mergeDevicesReply(EMPTY_DEVICES_VIEW, { devices: [], cloudError: ERR }, T1), () => 'x')).toBe(ERR)
    expect(cloudErrorLine(shown(), () => 'x')).toBeNull()
  })

  it('a stored view is accepted only when shaped like one', () => {
    expect(isDevicesView(shown())).toBe(true)
    expect(isDevicesView(null)).toBe(false)
    expect(isDevicesView({ devices: [] })).toBe(false)
    expect(isDevicesView({ ...shown(), cloudDevices: [{}] })).toBe(false)
  })
})
