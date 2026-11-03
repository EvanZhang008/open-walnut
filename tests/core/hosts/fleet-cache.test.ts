/**
 * The fleet cache on disk (core/hosts/fleet-cache.ts): what it keeps per host, that a
 * file it cannot use is dropped rather than thrown, and that a write never loses the
 * hosts only the file holds (a reading can land before the file was read).
 *
 * Real: the file in a temp WALNUT_HOME.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-fleet-cache'))

import { WALNUT_HOME } from '../../../src/constants.js'
import {
  __resetFleetCacheForTesting, fleetCacheEntry, flushFleetCacheNow, loadFleetCache, pruneFleetCache, recordFleetFailure,
  recordFleetLoad, recordFleetNoVitals, recordFleetVitals, sanitizeFleetCache,
} from '../../../src/core/hosts/fleet-cache.js'

const FILE = () => path.join(WALNUT_HOME, 'local', 'fleet-cache.json')
const vitals = (cpuUtil: number) => ({ stats: { cpus: 4, cpuUtil }, history: { windows: [] } }) as never

beforeEach(async () => {
  await fs.rm(WALNUT_HOME, { recursive: true, force: true })
  await fs.mkdir(WALNUT_HOME, { recursive: true })
  __resetFleetCacheForTesting()
})
afterEach(() => __resetFleetCacheForTesting())

describe('sanitizeFleetCache', () => {
  it('keeps the entries that look like its own and drops the rest', () => {
    const clean = sanitizeFleetCache({
      version: 1,
      hosts: {
        good: { readAt: 5, vitals: { at: 5, value: { stats: {}, history: {} } }, stale: false, load: { known: true, reasons: [] }, error: null },
        failed: { readAt: null, vitals: null, error: 'x'.repeat(900), errorAt: 7 },
        noVitalsShape: { readAt: 3, vitals: { at: 3, value: 'nope' } },
        junk: 'string',
        empty: {},
      },
      spend: { at: 1, from: '2026-10-05', byHost: { good: 12.5, bad: 'x' } },
    })
    expect(Object.keys(clean.hosts)).toEqual(['good', 'failed', 'noVitalsShape'])
    expect(clean.hosts.good).toMatchObject({ readAt: 5, stale: false, load: { known: true } })
    expect(clean.hosts.failed.error).toHaveLength(300)
    expect(clean.hosts.failed.errorAt).toBe(7)
    expect(clean.hosts.noVitalsShape.vitals).toBeNull()
    expect(clean.spend).toEqual({ at: 1, from: '2026-10-05', byHost: { good: 12.5 } })
  })

  it('a file from another version, or no object at all, is an empty cache', () => {
    for (const raw of [null, 'text', [], { version: 2, hosts: { a: { readAt: 1 } } }]) {
      expect(sanitizeFleetCache(raw)).toEqual({ version: 1, hosts: {}, spend: null })
    }
  })
})

describe('the file', () => {
  it('a reading, a failure that keeps it (stale), and a host that went away', async () => {
    await loadFleetCache()
    recordFleetVitals('devbox', vitals(0.5), 1_000)
    expect(fleetCacheEntry('devbox')).toMatchObject({ readAt: 1_000, stale: false, error: null, vitals: { at: 1_000 } })
    recordFleetFailure('devbox', 'ssh: connection reset\nmore lines', 2_000)
    expect(fleetCacheEntry('devbox')).toMatchObject({ readAt: 1_000, stale: true, error: 'ssh: connection reset', errorAt: 2_000, vitals: { at: 1_000 } })
    recordFleetNoVitals('devbox', 3_000, { away: true })
    expect(fleetCacheEntry('devbox')).toMatchObject({ readAt: 3_000, stale: true, error: null, vitals: { at: 1_000 } })
    // A daemon that cannot answer a reading at all: nothing older is worth showing.
    recordFleetNoVitals('devbox', 4_000, { away: false })
    expect(fleetCacheEntry('devbox')).toMatchObject({ readAt: 4_000, stale: false, vitals: null })
  })

  it('a reading that lands before the file was read is merged over it, never written over it', async () => {
    await fs.mkdir(path.dirname(FILE()), { recursive: true })
    await fs.writeFile(FILE(), JSON.stringify({ version: 1, hosts: { homepc: { readAt: 10, vitals: { at: 10, value: vitals(0.2) }, stale: false, load: null, error: null, errorAt: null } }, spend: null }))
    recordFleetVitals('devbox', vitals(0.5), 20) // before any loadFleetCache
    await flushFleetCacheNow()
    const stored = JSON.parse(await fs.readFile(FILE(), 'utf8'))
    expect(Object.keys(stored.hosts).sort()).toEqual(['devbox', 'homepc'])
    __resetFleetCacheForTesting()
    await loadFleetCache()
    expect(fleetCacheEntry('homepc')?.vitals?.at).toBe(10)
    expect(fleetCacheEntry('devbox')?.readAt).toBe(20)
  })

  it('a change to one field before the file was read never erases the rest of that host', async () => {
    // A restart, then a session prompt's fleet read records placement's load for a host the
    // file holds a reading for, and host_list a failure for another.
    const kept = (cpu: number, at: number) => ({ readAt: at, vitals: { at, value: vitals(cpu) }, stale: false, load: null, error: null, errorAt: null })
    await fs.mkdir(path.dirname(FILE()), { recursive: true })
    await fs.writeFile(FILE(), JSON.stringify({ version: 1, hosts: { devbox: kept(0.5, 10), homepc: kept(0.2, 11) }, spend: null }))
    recordFleetLoad('devbox', { known: true, score: 3, busy: false, reasons: [], weight: 50 })
    recordFleetFailure('homepc', 'ssh: connection reset', 30)
    await flushFleetCacheNow()
    const stored = JSON.parse(await fs.readFile(FILE(), 'utf8'))
    expect(stored.hosts.devbox).toMatchObject({ readAt: 10, vitals: { at: 10 }, load: { known: true, score: 3 } })
    // The failure is judged against the reading the file holds: kept, and stale.
    expect(stored.hosts.homepc).toMatchObject({ readAt: 11, vitals: { at: 11 }, stale: true, error: 'ssh: connection reset', errorAt: 30 })
  })

  it('a host removed from Settings leaves the file at the next full read', async () => {
    await loadFleetCache()
    recordFleetVitals('devbox', vitals(0.5), 20)
    recordFleetVitals('gone', vitals(0.5), 20)
    pruneFleetCache(['__local__', 'devbox'])
    await flushFleetCacheNow()
    expect(Object.keys(JSON.parse(await fs.readFile(FILE(), 'utf8')).hosts)).toEqual(['devbox'])
  })

  it('a write from before a reset never lands', async () => {
    await loadFleetCache()
    recordFleetVitals('devbox', vitals(0.5), 20)
    __resetFleetCacheForTesting()
    await flushFleetCacheNow()
    await expect(fs.stat(FILE())).rejects.toMatchObject({ code: 'ENOENT' })
  })
})
