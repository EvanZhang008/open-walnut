/**
 * Phone-facing bridge presence (src/web/ws/bridge-presence.ts): offline only
 * after continuous absence, online only after an announced offline, both
 * live-only. The SSE layer is stubbed so every frame is observable.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

const emitSse = vi.hoisted(() => vi.fn())
const conns = vi.hoisted(() => new Map<string, number>())
vi.mock('../../../src/web/sse-channels.js', () => ({
  emitSse,
  sseConnCount: (key: string) => conns.get(key) ?? 0,
}))

import {
  OFFLINE_ANNOUNCE_DELAY_MS, scheduleOfflineAnnouncement, cancelOfflineAnnouncement,
  offlineAnnouncementPending, markAnnouncedOffline, announceOnline, forgetPresence, clearBridgePresence,
} from '../../../src/web/ws/bridge-presence.js'

let connected = false
const interested = new Set<string>()
const schedule = (): void => scheduleOfflineAnnouncement('mac', { isConnected: () => connected, interested: () => interested })
const frames = (): Array<[string, string, unknown]> =>
  emitSse.mock.calls.map((c) => [c[0] as string, c[1] as string, c[3]])

beforeEach(() => {
  vi.useFakeTimers()
  emitSse.mockReset()
  conns.clear()
  interested.clear()
  connected = false
  clearBridgePresence()
})
afterEach(() => vi.useRealTimers())

describe('bridge presence', () => {
  it('announces offline only after the grace window, live-only, to pages that are open', () => {
    interested.add('s1').add('s2').add('gone')
    conns.set('session:s1', 1).set('session:s2', 2)
    schedule()
    expect(offlineAnnouncementPending('mac')).toBe(true)
    vi.advanceTimersByTime(OFFLINE_ANNOUNCE_DELAY_MS - 1)
    expect(emitSse).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(frames()).toEqual([
      ['session:s1', 'bridge-offline', { buffer: false }],
      ['session:s2', 'bridge-offline', { buffer: false }],
    ])
    expect(offlineAnnouncementPending('mac')).toBe(false)
  })

  it('a redial inside the window says nothing, and owes nobody an online', () => {
    interested.add('s1')
    conns.set('session:s1', 1)
    schedule()
    vi.advanceTimersByTime(1_500)
    cancelOfflineAnnouncement('mac')
    vi.advanceTimersByTime(OFFLINE_ANNOUNCE_DELAY_MS * 2)
    expect(announceOnline('mac', 's1')).toBe(false)
    expect(emitSse).not.toHaveBeenCalled()
  })

  it('a timer that fires after the host is back stays silent', () => {
    interested.add('s1')
    conns.set('session:s1', 1)
    schedule()
    connected = true
    vi.advanceTimersByTime(OFFLINE_ANNOUNCE_DELAY_MS)
    expect(emitSse).not.toHaveBeenCalled()
  })

  it('online goes once, live-only, and only to a page told offline', () => {
    interested.add('s1')
    conns.set('session:s1', 1)
    schedule()
    vi.advanceTimersByTime(OFFLINE_ANNOUNCE_DELAY_MS)
    emitSse.mockReset()
    expect(announceOnline('mac', 's1')).toBe(true)
    expect(announceOnline('mac', 's1')).toBe(false)
    expect(announceOnline('mac', 'never-told')).toBe(false)
    expect(frames()).toEqual([['session:s1', 'bridge-online', { buffer: false }]])
  })

  it('a page that attached to an announced-offline host is owed its online; a closed one is not', () => {
    markAnnouncedOffline('mac', 'late')
    markAnnouncedOffline('mac', 'left')
    forgetPresence('mac', 'left')
    expect(announceOnline('mac', 'left')).toBe(false)
    expect(announceOnline('mac', 'late')).toBe(true)
  })

  it('a second drop before the first announcement keeps ONE timer, and never repeats an offline', () => {
    interested.add('s1')
    conns.set('session:s1', 1)
    schedule()
    vi.advanceTimersByTime(3_000)
    schedule()
    vi.advanceTimersByTime(OFFLINE_ANNOUNCE_DELAY_MS - 3_000)
    expect(emitSse).toHaveBeenCalledTimes(1)
    schedule()
    vi.advanceTimersByTime(OFFLINE_ANNOUNCE_DELAY_MS)
    expect(emitSse).toHaveBeenCalledTimes(1)
  })
})
