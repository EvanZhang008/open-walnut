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
import { homeBusyItem, homeBusyKey, homeMoveItem, homeMoveKey, noteHomeBusy, noteHomeServed, noteMoveNotTaken, noteMoveTaken, _resetHomeBusyHealthForTesting } from '../../../src/core/leader/home-busy-health.js'

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
