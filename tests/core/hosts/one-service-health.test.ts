/**
 * What a person and an agent read about a host's one Walnut service (src/providers/one-service-mode.ts):
 *   - Walnut Health (src/core/hosts/one-service-health.ts): a host with no offer is one info item,
 *     raised again only when the reason changes, recovered by an offer, and by the experiments going
 *     off (one store read per host per process for an item an earlier process left);
 *   - the fleet card's agent line (fleet-model.ts fleetHostLine) names the one program.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { raised, recovered } = vi.hoisted(() => ({ raised: [] as Array<Record<string, unknown>>, recovered: [] as string[][] }))
// The store under health-items.ts: what was raised and recovered, and nothing written.
vi.mock('../../../src/core/notifications/store.js', () => ({
  upsertNotification: async (item: Record<string, unknown>) => { raised.push(item); return { record: item, outcome: 'inserted' } },
  recoverNotifications: async (keys: string[]) => { recovered.push(keys); return { recovered: [] } },
}))

import {
  _resetServiceOfferHealthForTesting, noServiceOfferItem, noteServiceOffer, noteServiceOfferOff, serviceOfferKey,
} from '../../../src/core/hosts/one-service-health.js'
import { fleetHostLine, type FleetHost } from '../../../src/core/hosts/fleet-model.js'

/** The writes go one at a time behind the host's label (a config read): wait for the store to see them. */
const settle = () => new Promise((r) => setTimeout(r, 300))

beforeEach(() => {
  raised.length = 0
  recovered.length = 0
  _resetServiceOfferHealthForTesting()
})

describe('Walnut Health for a host with no offer', () => {
  it('is one info item per host, in plain words, never a needs-you', () => {
    const item = noServiceOfferItem('devbox', 'Dev box', 'no Walnut server of this Walnut runs there.')
    expect(item).toMatchObject({ kind: 'operation-error', severity: 'info', dedupKey: serviceOfferKey('devbox'), recoveryKey: serviceOfferKey('devbox'), host: 'devbox' })
    expect(item.title).toBe('Dev box keeps the session helper and its Walnut server as two programs')
    expect(item.body).toBe('Walnut does not run Dev box as one Walnut service: no Walnut server of this Walnut runs there. Its sessions and its server run as before.')
    expect(item).not.toHaveProperty('needsYou')
  })

  it('is raised once per reason, again when the reason changes, and recovered by an offer', async () => {
    noteServiceOffer('devbox', { want: 'daemon', why: 'no follower' })
    noteServiceOffer('devbox', { want: 'daemon', why: 'no follower' })
    await vi.waitFor(() => expect(raised).toHaveLength(1), { timeout: 10_000 })
    await settle()
    expect(raised).toHaveLength(1)
    noteServiceOffer('devbox', { want: 'daemon', why: 'no launcher' })
    await vi.waitFor(() => expect(raised).toHaveLength(2), { timeout: 10_000 })
    expect(raised.map((i) => i.detail)).toEqual(['one Walnut service not offered on devbox: no follower', 'one Walnut service not offered on devbox: no launcher'])
    // Not settled yet: nothing is said either way.
    noteServiceOffer('devbox', { want: null })
    await settle()
    expect(recovered).toEqual([])
    noteServiceOffer('devbox', { want: 'walnut-serve' })
    await vi.waitFor(() => expect(recovered).toEqual([[serviceOfferKey('devbox')]]), { timeout: 10_000 })
  })

  // a3b land 2 review L1: an item an earlier process raised (the experiment turned off, then a
  // leader restart) recovers at the host's first check in this process, and only then.
  it('the experiments off: an earlier process\'s item recovers once per process; one this process raised at once', async () => {
    noteServiceOfferOff('other')
    await vi.waitFor(() => expect(recovered).toEqual([[serviceOfferKey('other')]]), { timeout: 10_000 })
    noteServiceOfferOff('other')
    noteServiceOfferOff('other')
    await settle()
    expect(recovered).toEqual([[serviceOfferKey('other')]])
    noteServiceOffer('devbox', { want: 'daemon', why: 'no follower' })
    await vi.waitFor(() => expect(raised).toHaveLength(1), { timeout: 10_000 })
    noteServiceOfferOff('devbox')
    await vi.waitFor(() => expect(recovered).toEqual([[serviceOfferKey('other')], [serviceOfferKey('devbox')]]), { timeout: 10_000 })
    noteServiceOfferOff('devbox')
    await settle()
    expect(recovered).toHaveLength(2)
  })
})

describe('the fleet card\'s agent line', () => {
  const card = (serves?: 'walnut-serve'): FleetHost => ({
    host: 'devbox', label: 'Dev box', local: false,
    connection: { kind: 'ssh-tunnel', connected: true },
    sessions: { running: null }, spend: null,
    server: { enabled: true, program: 'replica', phase: 'running', phaseLabel: 'running', build: null, phone: null, message: null },
    daemon: { version: 'walnut-daemon-1', startedAt: null, startup: 'service', startsAfterReboot: true, runtime: 'binary', vitals: true, ...(serves ? { serves } : {}) },
    placement: { score: null, busy: null, reasons: [], weight: null, longRunning: { ok: true, reasons: [] } },
  } as unknown as FleetHost)

  it('says the server runs as one Walnut service with its session helper, and nothing new otherwise', () => {
    expect(fleetHostLine(card('walnut-serve'))).toContain('Walnut server running (one Walnut service with its session helper)')
    expect(fleetHostLine(card())).toMatch(/Walnut server running$/)
    expect(fleetHostLine(card())).not.toContain('one Walnut service')
  })
})
