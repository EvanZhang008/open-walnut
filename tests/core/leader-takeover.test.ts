/**
 * When the cloud companion takes the lead (src/core/leader/takeover.ts): the
 * whole "who still hears the primary" matrix, pure.
 */
import { describe, it, expect } from 'vitest'
import { decideTakeover, pickWalnutId, type TakeoverInput, type WitnessReport } from '../../src/core/leader/takeover.js'

const W = 'wprimary0001'
const T = 60_000
const NOW = 10_000_000

function witness(host: string, over: Partial<{ epoch: number; holder: 'primary' | 'backup'; primaryConnected: boolean; primaryHeardAgoMs: number; walnutId: string }> = {}): WitnessReport {
  return {
    host,
    walnuts: [{ walnutId: over.walnutId ?? W, epoch: over.epoch ?? 1, holder: over.holder ?? 'primary', primaryConnected: over.primaryConnected ?? false, primaryHeardAgoMs: over.primaryHeardAgoMs ?? T + 5_000 }],
  }
}

function input(over: Partial<TakeoverInput> = {}): TakeoverInput {
  return { now: NOW, takeoverMs: T, primaryLastSeenAt: NOW - T - 5_000, walnutId: W, leading: new Map(), reports: [], ...over }
}

describe('takeover: the companion takes the lead only when both views agree', () => {
  it('claims every reachable host when the primary is silent and no host hears it', () => {
    const d = decideTakeover(input({ reports: [witness('devbox', { epoch: 3 }), witness('oldbox')] }))
    expect(d).toMatchObject({ action: 'claim', walnutId: W, claims: [{ host: 'devbox', epoch: 4 }, { host: 'oldbox', epoch: 2 }] })
  })

  it('waits while its own view still hears the primary (heartbeat inside the window)', () => {
    const d = decideTakeover(input({ primaryLastSeenAt: NOW - T + 1, reports: [witness('devbox')] }))
    expect(d).toMatchObject({ action: 'wait', reason: 'the primary is alive' })
  })

  it('waits when one host still hears the primary: only the link to the companion is down', () => {
    const d = decideTakeover(input({ reports: [witness('devbox'), witness('oldbox', { primaryHeardAgoMs: 4_000 })] }))
    expect(d).toMatchObject({ action: 'wait', reason: 'oldbox still hears the primary' })
  })

  it('waits when a host has the primary connected (heard recently)', () => {
    const d = decideTakeover(input({ reports: [witness('devbox', { primaryConnected: true, primaryHeardAgoMs: 1_000 })] }))
    expect(d.action).toBe('wait')
  })

  it('a host whose answer failed is no witness either way', () => {
    const d = decideTakeover(input({ reports: [witness('devbox'), { host: 'oldbox', error: 'timeout' }] }))
    expect(d).toMatchObject({ action: 'claim', claims: [{ host: 'devbox', epoch: 2 }] })
  })

  it('waits when no reachable host lets the companion lead', () => {
    expect(decideTakeover(input({ reports: [{ host: 'devbox', walnuts: [] }] }))).toMatchObject({ action: 'wait' })
    expect(decideTakeover(input({ reports: [] }))).toMatchObject({ action: 'wait' })
  })

  it('a restart notice holds the takeover off for the announced window, not forever', () => {
    const restarting = { primaryLastSeenAt: NOW - 2 * T, restartingUntil: NOW - 2 * T + 5 * T, reports: [witness('devbox')] }
    expect(decideTakeover(input(restarting)).action).toBe('wait')
    expect(decideTakeover(input({ ...restarting, now: NOW + 3 * T + 1 })).action).toBe('claim')
  })
})

describe('takeover: while leading', () => {
  it('gives a host back once the primary took the lead there (holder primary at a higher epoch)', () => {
    const d = decideTakeover(input({
      leading: new Map([['devbox', 2], ['oldbox', 2]]),
      reports: [witness('devbox', { holder: 'primary', epoch: 3, primaryConnected: true, primaryHeardAgoMs: 100 }), witness('oldbox', { holder: 'backup', epoch: 2 })],
    }))
    expect(d).toMatchObject({ action: 'demote', hosts: ['devbox'] })
  })

  it('keeps leading a host the primary has not reached yet, even though its heartbeat is back', () => {
    const d = decideTakeover(input({
      primaryLastSeenAt: NOW - 1_000,
      leading: new Map([['devbox', 2]]),
      reports: [witness('devbox', { holder: 'backup', epoch: 2 })],
    }))
    expect(d).toMatchObject({ action: 'wait', reason: 'leading; the primary is back but has not taken the lead yet' })
  })

  it('claims a host that came online while it leads, when that host agrees too', () => {
    const d = decideTakeover(input({
      leading: new Map([['devbox', 2]]),
      reports: [witness('devbox', { holder: 'backup', epoch: 2 }), witness('newbox', { epoch: 5 })],
    }))
    expect(d).toMatchObject({ action: 'claim', claims: [{ host: 'newbox', epoch: 6 }] })
  })

  it('a host that lost its record of this Walnut is given back', () => {
    const d = decideTakeover(input({ leading: new Map([['devbox', 2]]), reports: [{ host: 'devbox', walnuts: [] }] }))
    expect(d).toMatchObject({ action: 'demote', hosts: ['devbox'] })
  })
})

describe('takeover: which Walnut', () => {
  it('uses the heartbeat\'s id, else the one id every witness names', () => {
    expect(pickWalnutId('wa', [witness('h', { walnutId: 'wb' })])).toBe('wa')
    expect(pickWalnutId(undefined, [witness('h1', { walnutId: 'wb' }), witness('h2', { walnutId: 'wb' })])).toBe('wb')
    expect(pickWalnutId(undefined, [witness('h1', { walnutId: 'wb' }), witness('h2', { walnutId: 'wc' })])).toBeUndefined()
  })

  it('after a companion restart with no heartbeat yet, it still finds the Walnut from the witnesses', () => {
    const d = decideTakeover(input({ walnutId: undefined, reports: [witness('devbox')] }))
    expect(d).toMatchObject({ action: 'claim', walnutId: W })
  })
})
