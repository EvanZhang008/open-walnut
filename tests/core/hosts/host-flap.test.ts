/**
 * A host whose link keeps dropping reads as unstable, not "Connected" (2026-11-08: a laptop on
 * the host network dropped every 30 s for hours and read Connected between drops in Hosts, the
 * notification pane and host_list). The drop record (daemon-link-drops.ts), the rule
 * (host-problem.ts hostFlapOf), the dot, and the fleet card.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-host-flap'))

import {
  FLAP_MIN_DROPS, FLAP_WINDOW_MS, hostConnectedWords, hostDotOf, hostFlapOf,
} from '../../../src/core/hosts/host-problem.js'
import {
  LINK_DROPS_KEEP_MS, noteLinkDrop, recentLinkDrops, resetLinkDropsForTest,
} from '../../../src/providers/daemon-link-drops.js'
import {
  DaemonConnection, addOnDaemonPhaseChange, dropDaemonConnection, getDaemonConnectState, setPooledConnectionForTest,
} from '../../../src/providers/daemon-connection.js'
import { buildFleetHost, withPlacement, type FleetInputs } from '../../../src/core/hosts/fleet-model.js'

const NOW = 1_800_000_000_000
const min = 60_000

afterEach(() => resetLinkDropsForTest())

describe('hostFlapOf', () => {
  it('needs FLAP_MIN_DROPS drops inside the window', () => {
    const drops = [NOW - 20 * min, NOW - 10 * min]
    expect(hostFlapOf({ drops }, NOW)).toBeNull()
    expect(FLAP_MIN_DROPS).toBe(3)
    expect(hostFlapOf({ drops: [...drops, NOW - 1 * min] }, NOW)).toEqual({ drops: 3, windowMin: 30, last: NOW - min })
  })

  it('lets drops older than the window age out', () => {
    const drops = [NOW - FLAP_WINDOW_MS - 1, NOW - 29 * min, NOW - 28 * min, NOW - 27 * min]
    expect(hostFlapOf({ drops }, NOW)?.drops).toBe(3)
    expect(hostFlapOf({ drops }, NOW + 2 * min)).toBeNull()
  })

  it('reads no drops as stable, and a frame without the field too (an older server)', () => {
    expect(hostFlapOf(undefined, NOW)).toBeNull()
    expect(hostFlapOf({}, NOW)).toBeNull()
  })
})

describe('the words and the dot', () => {
  const base = { host: 'laptop', label: 'Laptop', connected: true, phase: 'connected', connectedAt: NOW - 30_000, readiness: { problems: [], checkedAt: NOW - 20_000 } }
  const flapping = { ...base, drops: [NOW - 9 * min, NOW - 6 * min, NOW - 3 * min, NOW - 1 * min] }

  it('says Connected for a stable link and Unstable with the count for a flapping one', () => {
    expect(hostConnectedWords(base, NOW)).toBe('Connected')
    expect(hostConnectedWords(flapping, NOW)).toBe('Unstable: its link dropped 4 times in the last 30 min')
  })

  it('gives a flapping connected host the warn dot, a stable one the connected dot', () => {
    expect(hostDotOf(base, { now: NOW })).toEqual({ kind: 'connected', title: 'Laptop: Connected' })
    expect(hostDotOf(flapping, { now: NOW })).toEqual({ kind: 'warn', title: 'Laptop: Unstable: its link dropped 4 times in the last 30 min' })
  })

  it('names the drops while it reconnects', () => {
    const down = { ...flapping, connected: false, phase: 'reconnecting', reconnectSince: NOW - 5_000 }
    expect(hostDotOf(down, { now: NOW }).title).toBe('Laptop: Reconnecting; its link dropped 4 times in the last 30 min')
  })
})

describe('daemon-link-drops', () => {
  it('keeps an hour of drops per host, oldest first', () => {
    noteLinkDrop('a', NOW - LINK_DROPS_KEEP_MS - 1)
    noteLinkDrop('a', NOW - 2 * min)
    noteLinkDrop('a', NOW - min)
    noteLinkDrop('b', NOW - min)
    expect(recentLinkDrops('a', NOW)).toEqual([NOW - 2 * min, NOW - min])
    expect(recentLinkDrops('b', NOW)).toEqual([NOW - min])
    expect(recentLinkDrops('c', NOW)).toBeUndefined()
  })
})

describe('DaemonConnection records a drop only when the link fell by itself', () => {
  const target = { hostname: 'laptop.example.test', user: 'someone' }
  type Seams = { setConnected(v: boolean): void; _destroyed: boolean; _handoverArmed: boolean }

  it('a connected link that drops counts; the reconnect that follows does not', () => {
    const conn = new DaemonConnection('flap-real', target)
    setPooledConnectionForTest('flap-real', conn)
    try {
      const c = conn as unknown as Seams
      for (let i = 0; i < 3; i++) { c.setConnected(true); c.setConnected(false) }
      c.setConnected(true)
      const state = getDaemonConnectState('flap-real')
      expect(state.connected).toBe(true)
      expect(state.drops?.length).toBe(3)
      expect(hostConnectedWords(state, Date.now())).toBe('Unstable: its link dropped 3 times in the last 30 min')
    } finally { setPooledConnectionForTest('flap-real', null) }
  })

  it("a drop right after this Mac woke or changed network does not count", async () => {
    const { noteHostSignal, resetHostSignalForTest } = await import('../../../src/providers/daemon-reconnect-cause.js')
    const conn = new DaemonConnection('flap-wake', target)
    setPooledConnectionForTest('flap-wake', conn)
    try {
      const c = conn as unknown as Seams
      noteHostSignal(Date.now())
      for (let i = 0; i < 3; i++) { c.setConnected(true); c.setConnected(false) }
      expect(getDaemonConnectState('flap-wake').drops).toBeUndefined()
    } finally { setPooledConnectionForTest('flap-wake', null); resetHostSignalForTest() }
  })

  it('a planned daemon swap or a deliberate teardown does not count', () => {
    const conn = new DaemonConnection('flap-planned', target)
    setPooledConnectionForTest('flap-planned', conn)
    try {
      const c = conn as unknown as Seams
      c.setConnected(true)
      c._handoverArmed = true
      c.setConnected(false)
      c._handoverArmed = false
      c.setConnected(true)
      c._destroyed = true
      c.setConnected(false)
      expect(getDaemonConnectState('flap-planned').drops).toBeUndefined()
    } finally { setPooledConnectionForTest('flap-planned', null) }
  })
})

describe('the record follows the host', () => {
  const target = { hostname: 'laptop.example.test', user: 'someone' }
  type Seams = { setConnected(v: boolean): void }

  it('tells the listeners again once a drop has aged out of the window, so "Unstable" clears by itself', () => {
    vi.useFakeTimers()
    const seen: Array<number | undefined> = []
    const off = addOnDaemonPhaseChange((st) => { if (st.host === 'flap-age') seen.push(st.drops?.length) })
    const conn = new DaemonConnection('flap-age', target)
    setPooledConnectionForTest('flap-age', conn)
    try {
      const c = conn as unknown as Seams
      c.setConnected(true); c.setConnected(false); c.setConnected(true)
      seen.length = 0
      vi.advanceTimersByTime(FLAP_WINDOW_MS + 1_500)
      expect(seen.length).toBeGreaterThan(0)
    } finally { off(); setPooledConnectionForTest('flap-age', null); vi.useRealTimers() }
  })

  it('a host removed from the pool forgets its drops (the name may come back as another machine)', () => {
    const conn = new DaemonConnection('flap-gone', target)
    setPooledConnectionForTest('flap-gone', conn)
    const c = conn as unknown as Seams
    for (let i = 0; i < 3; i++) { c.setConnected(true); c.setConnected(false) }
    expect(getDaemonConnectState('flap-gone').drops?.length).toBe(3)
    expect(dropDaemonConnection('flap-gone')).toBe(true)
    expect(recentLinkDrops('flap-gone')).toBeUndefined()
  })
})

describe('the Start refusal bar', () => {
  it('clears for a link that is up but unstable, not only for a steady one', async () => {
    const fs = await import('node:fs')
    const src = fs.readFileSync(new URL('../../../web/src/components/sessions/HostGateErrorBar.tsx', import.meta.url), 'utf8')
    expect(src).toMatch(/\['connected', 'warn'\]\.includes\(hostDotOf\(/)
  })
})

describe('host_list', () => {
  const inputs = (drops?: number[]): FleetInputs => ({
    host: 'laptop', label: 'Laptop', local: false, kind: 'host-network',
    status: { connected: true, phase: 'connected', phaseLabel: 'Connected to Laptop', connectedAt: NOW - 30_000, ...(drops ? { drops } : {}) },
    rttMs: 30, profile: null, vitals: null, load: null, spendUsd: null, spendFrom: null, server: null, daemon: null, now: NOW,
  })

  it('a flapping host carries `unstable`, says so in its line and is no place for a long job', () => {
    const card = withPlacement(buildFleetHost(inputs([NOW - 7 * min, NOW - 4 * min, NOW - 2 * min])))
    expect(card.connection.unstable).toEqual({ drops: 3, windowMin: 30 })
    expect(card.line).toContain('connected over the host network; unstable: its link dropped 3 times in the last 30 min')
    expect(card.placement.longRunning.reasons).toContain('Its link keeps dropping (3 times in the last 30 min).')
  })

  it('a stable host has no `unstable`', () => {
    const card = withPlacement(buildFleetHost(inputs()))
    expect(card.connection.unstable).toBeUndefined()
    expect(card.line).not.toContain('unstable')
  })
})
