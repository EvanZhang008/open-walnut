/**
 * A Walnut Health item that is one EVENT (`raiseHealthItem(..., { once: true })`) is counted once,
 * however often it is told again. 2026-11-26: a host's launcher put its daemon back once, and every
 * deploy of the Mac's server read that put-back from the host's hello again and counted it as a new
 * occurrence (4 by 14:25Z), so "Background errors keep happening" stayed in alarm for a host that
 * had been fine for over an hour.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants())

import { WALNUT_HOME } from '../../../src/constants.js'
import { listNotifications, recoverNotifications, upsertNotification } from '../../../src/core/notifications/store.js'
import { noteLauncherRollback, _resetLauncherHealthForTesting } from '../../../src/core/hosts/host-launcher.js'
import { keepHappeningByCategory } from '../../../src/core/notifications/health-investigate.js'

const FILE = path.join(WALNUT_HOME, 'notifications.json')
const V = (c: string) => `/home/u/.local/share/open-walnut/daemon/versions/${c.repeat(64)}/daemon`

beforeEach(() => {
  fs.rmSync(FILE, { force: true })
  fs.rmSync(FILE.replace(/\.json$/, '.backup.json'), { force: true })
  _resetLauncherHealthForTesting()
})

const event = (at: number) => ({
  kind: 'operation-error' as const, severity: 'warning' as const, title: 'went back', body: 'b',
  dedupKey: `host-launcher-rollback:devbox:${at}`, category: 'Sessions', timestamp: at * 1000,
})

describe('a once item in the store', () => {
  it('is written the first time and never moves again: no occurrence, no lastTimestamp, no reopen', async () => {
    // A recoveryKey only so the test can resolve it below.
    const item = { ...event(1000), recoveryKey: 'k-1000' }
    expect((await upsertNotification(item, { once: true })).outcome).toBe('inserted')
    const again = await upsertNotification({ ...item, timestamp: 2_000_000 }, { once: true })
    expect(again.outcome).toBe('suppressed')
    let [rec] = (await listNotifications()).feed
    expect(rec.occurrences).toBeUndefined()
    expect(rec.lastTimestamp).toBeUndefined()
    await recoverNotifications(['k-1000'])
    expect((await upsertNotification(item, { once: true })).outcome).toBe('suppressed')
    ;[rec] = (await listNotifications()).feed
    expect(rec.resolved).toBe('recovered')
  })

  it('a second event (another time in its key) is its own item', async () => {
    await upsertNotification(event(1000), { once: true })
    expect((await upsertNotification(event(2000), { once: true })).outcome).toBe('inserted')
    expect((await listNotifications()).feed).toHaveLength(2)
  })

  it('without once, the same key told again still counts (conditions keep their fold)', async () => {
    await upsertNotification(event(1000))
    expect((await upsertNotification(event(1000))).outcome).toBe('refreshed')
    expect((await listNotifications()).feed[0].occurrences).toBe(2)
  })
})

describe('a launcher put-back replayed by every server restart', () => {
  it('counts once, so the health count lets it go an hour after it happened', async () => {
    const at = Math.floor(Date.now() / 1000) - 50 * 60
    const facts = { current: V('a'), good: V('a'), phase: 'committed' as const, since: 1, rollback: { at, from: V('c'), to: V('a'), reason: 'stalled' } }
    for (let restart = 0; restart < 4; restart++) {
      _resetLauncherHealthForTesting() // a new server process: its in-memory "told" is empty
      await noteLauncherRollback('devbox', facts)
    }
    const { feed } = await listNotifications()
    expect(feed).toHaveLength(1)
    expect(feed[0].occurrences).toBeUndefined()
    expect(feed[0].lastTimestamp).toBeUndefined()
    // One occurrence, open 50 min and seen once: counted now (open past 30 min), not 11 min later.
    const seenAt = feed[0].timestamp
    expect(keepHappeningByCategory(feed, seenAt + 50 * 60_000)).toHaveLength(1)
    expect(keepHappeningByCategory(feed, seenAt + 61 * 60_000)).toHaveLength(0)
  })
})
