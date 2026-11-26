/**
 * A host that refused this data dir (`walnut_home_busy`: the Walnut moved to another data dir
 * there) is one Walnut Health item per host, never a popup (audience.ts), in plain words; an
 * accepted leader.configure recovers it.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('../../../src/constants.js', async () => {
  const { createMockConstants } = await import('../../helpers/mock-constants.js')
  return createMockConstants('walnut-home-busy-health')
})

import { audienceOf } from '../../../src/core/notifications/audience.js'
import { findNotification, mutateNotificationStore } from '../../../src/core/notifications/store.js'
import path from 'node:path'
import { createWalnutScope } from '../../../src/providers/walnut-scope-core.js'
import { homeBusyItem, homeBusyKey, homeMoveItem, homeMoveKey, noteHomeBusy, noteHomeServed, noteMoveNotTaken, noteMoveTaken, noteWitnessBack, noteWitnessBehind, recoverStaleWitnessItems, witnessBehindItem, witnessBehindKey, _resetHomeBusyHealthForTesting } from '../../../src/core/leader/home-busy-health.js'
import { raiseHealthItem } from '../../../src/core/notifications/health-items.js'

afterEach(() => _resetHomeBusyHealthForTesting())

describe('a host that refused this copy of the Walnut', () => {
  it('reads plainly and goes to Walnut Health only', () => {
    const item = homeBusyItem('devbox', 'Dev box', '/Users/me/.open-walnut')
    expect(item.body).toBe('Another copy of this Walnut\'s data uses Dev box (moved to /Users/me/.open-walnut). This copy cannot use that host.')
    expect(audienceOf(item)).toBe('health')
    expect(item.needsYou).toBeUndefined()
    expect(homeBusyItem('devbox', 'Dev box', '').body).toBe('Another copy of this Walnut\'s data uses Dev box. This copy cannot use that host.')
  })

  it('one item per host; an accepted description recovers it', async () => {
    noteHomeBusy('devbox', '/new/home')
    noteHomeBusy('devbox', '/new/home')
    await vi.waitFor(async () => expect(await findNotification(homeBusyKey('devbox'))).toMatchObject({ kind: 'operation-error', host: 'devbox' }), { timeout: 5_000 })
    const rows = await mutateNotificationStore((store) => store.notifications.filter((n) => n.dedupKey === homeBusyKey('devbox')).length)
    expect(rows).toBe(1)
    expect((await findNotification(homeBusyKey('devbox')))?.resolved).toBeFalsy()
    noteHomeServed('devbox')
    await vi.waitFor(async () => expect((await findNotification(homeBusyKey('devbox')))?.resolved).toBeTruthy(), { timeout: 5_000 })
  })

  it('another Walnut that left this path reads as that, with the way in (M3)', () => {
    const item = homeBusyItem('devbox', 'Dev box', '/Users/me/other', 'taken')
    expect(item.title).toBe('Another Walnut used this data folder on Dev box')
    expect(item.body).toBe('Another Walnut used this data folder\'s path on Dev box and moved to another folder, /Users/me/other. Dev box keeps that Walnut\'s data under this path, so this Walnut cannot use it from here. Run this Walnut from another data folder to use Dev box. If that was your earlier Walnut, start Walnut from /Users/me/other instead.')
    expect(homeBusyItem('devbox', 'Dev box', '', 'taken').body).not.toContain('earlier Walnut')
    expect(item.dedupKey).toBe(homeBusyKey('devbox'))
    expect(audienceOf(item)).toBe('health')
  })

  it('N1: a host that follows another copy still on this machine says which, and how to pick this one', () => {
    const item = homeBusyItem('devbox', 'Dev box', '/Users/me/walnut-old', 'contested')
    expect(item.title).toBe('Dev box follows another copy of this Walnut')
    expect(item.body).toBe('Another copy of this Walnut\'s data, at /Users/me/walnut-old, reached Dev box first, so Dev box keeps working with that copy and not this one. If the copy at /Users/me/walnut-old is an old one, quit any Walnut running from it and delete or rename that folder: this copy takes Dev box over the next time it connects (restart Walnut to do it now). If /Users/me/walnut-old is the copy you use, run Walnut from there.')
    expect(item.dedupKey).toBe(homeBusyKey('devbox'))
    expect(audienceOf(item)).toBe('health')
  })

  it('every reason a host tells has its own words (one list: walnut-scope-core.ts toldReasons)', () => {
    const reasons = createWalnutScope({ path, keyOf: (h) => h }).toldReasons()
    expect(reasons.length).toBeGreaterThan(0)
    for (const why of reasons) expect(homeMoveItem('devbox', 'Dev box', why).body, why).not.toContain('it did not take the move')
  })

  it('a declared move the host could not follow is one item, recovered when it takes the move (M2)', async () => {
    const item = homeMoveItem('devbox', 'Dev box', 'lost_trail')
    expect(item.title).toBe('Dev box could not follow this Walnut\'s move')
    expect(item.body).toContain('it knows this Walnut under a folder this one no longer lists')
    expect(audienceOf(item)).toBe('health')
    noteMoveNotTaken('devbox', 'lost_trail')
    await vi.waitFor(async () => expect(await findNotification(homeMoveKey('devbox'))).toMatchObject({ kind: 'operation-error', host: 'devbox' }), { timeout: 5_000 })
    noteMoveTaken('devbox')
    await vi.waitFor(async () => expect((await findNotification(homeMoveKey('devbox')))?.resolved).toBeTruthy(), { timeout: 5_000 })
  })
})

describe('a leader witness that takes none of the renewals (switch/runtime.ts checkLag)', () => {
  it('one plain Health item per witness, counted again on repeat, recovered when it takes them again', async () => {
    const item = witnessBehindItem('w-b', 60_000, 'no answer')
    expect(item.title).toBe('Leader witness w-b is not taking this leader\'s renewals')
    expect(item.body).toBe('Witness w-b took none of this leader\'s renewals for 60 seconds, so the leader\'s permission stands on its other witnesses alone: if one more of them stops answering, no machine may act as the leader until it is back. It recovers on its own once w-b answers again; if it does not, check that w-b\'s machine and its link are up.')
    expect(item.detail).toBe('witness w-b: no renewal taken for 60 s (its last answer: no answer)')
    expect([item.dedupKey, item.recoveryKey]).toEqual([witnessBehindKey('w-b'), witnessBehindKey('w-b')])
    expect(audienceOf(item)).toBe('health')
    noteWitnessBehind('w-b', 60_000, 'no answer')
    noteWitnessBehind('w-b', 60_000, 'not-holder')
    await vi.waitFor(async () => expect(await findNotification(witnessBehindKey('w-b'))).toMatchObject({ kind: 'operation-error', severity: 'warning' }), { timeout: 5_000 })
    expect(await mutateNotificationStore((store) => store.notifications.filter((n) => n.dedupKey === witnessBehindKey('w-b')).length)).toBe(1)
    noteWitnessBack('w-b')
    await vi.waitFor(async () => expect((await findNotification(witnessBehindKey('w-b')))?.resolved).toBeTruthy(), { timeout: 5_000 })
  })

  it('an item that came with the home (an earlier process, the old leader) is recovered at the first lead; one this process raised is not', async () => {
    // As if written by another process: straight into the store, nothing told in this one.
    await raiseHealthItem(witnessBehindItem('w-k', 60_000, 'no answer'), 'leader-permit')
    noteWitnessBehind('w-a', 60_000, 'no answer')
    await vi.waitFor(async () => expect(await findNotification(witnessBehindKey('w-a'))).toBeTruthy(), { timeout: 5_000 })
    expect(await recoverStaleWitnessItems()).toEqual([witnessBehindKey('w-k')])
    expect((await findNotification(witnessBehindKey('w-k')))?.resolved).toBeTruthy()
    expect((await findNotification(witnessBehindKey('w-a')))?.resolved).toBeFalsy()
    // Nothing open of that kind: the sweep finds nothing and writes nothing.
    noteWitnessBack('w-a')
    await vi.waitFor(async () => expect((await findNotification(witnessBehindKey('w-a')))?.resolved).toBeTruthy(), { timeout: 5_000 })
    expect(await recoverStaleWitnessItems()).toEqual([])
  })
})
