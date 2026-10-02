/**
 * The history disk cache is BOUNDED. It had no eviction: one file per session
 * ever opened, kept forever. On 2026-10-02 the live dir held 4,299 files and
 * 1.8 GB on a disk already at the watermark that pauses writes.
 *
 * Two rules, both on the file's own mtime: entries older than the age cap go,
 * then the oldest go until the total fits the byte cap. A write still in its
 * coalescing window is live whatever its file says.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { createMockConstants } from '../helpers/mock-constants.js'

vi.mock('../../src/constants.js', () => createMockConstants('walnut-history-cache-prune', {
  HISTORY_CACHE_DIR: path.join(os.tmpdir(), `walnut-history-cache-prune-${Date.now()}-${Math.random().toString(36).slice(2)}`, 'cache', 'history'),
}))

import { HISTORY_CACHE_DIR } from '../../src/constants.js'
import {
  pruneHistoryCache, writeHistoryCache, flushHistoryCacheWrites,
  HISTORY_CACHE_MAX_AGE_MS, HISTORY_CACHE_MAX_BYTES,
} from '../../src/core/history-disk-cache.js'

const DAY = 24 * 60 * 60 * 1000
const NOW = Date.parse('2026-10-02T00:00:00Z')

async function seed(name: string, bytes: number, ageMs: number): Promise<string> {
  await fs.mkdir(HISTORY_CACHE_DIR, { recursive: true })
  const file = path.join(HISTORY_CACHE_DIR, `${name}.json`)
  await fs.writeFile(file, Buffer.alloc(bytes, 0x20))
  const t = new Date(NOW - ageMs)
  await fs.utimes(file, t, t)
  return file
}

const exists = (file: string): Promise<boolean> => fs.access(file).then(() => true, () => false)

beforeEach(async () => {
  await fs.rm(HISTORY_CACHE_DIR, { recursive: true, force: true })
  await fs.mkdir(HISTORY_CACHE_DIR, { recursive: true })
})

afterAll(async () => {
  await fs.rm(path.dirname(path.dirname(HISTORY_CACHE_DIR)), { recursive: true, force: true })
})

describe('pruneHistoryCache', () => {
  it('drops entries past the age cap and keeps the rest', async () => {
    const old = await seed('old-session', 100, 31 * DAY)
    const fresh = await seed('fresh-session', 100, 2 * DAY)
    const r = await pruneHistoryCache({ now: NOW })
    expect(r.removed).toBe(1)
    expect(r.freedBytes).toBe(100)
    expect(await exists(old)).toBe(false)
    expect(await exists(fresh)).toBe(true)
  })

  it('past the byte cap, the oldest surviving entries go first until the total fits', async () => {
    const a = await seed('a', 400, 10 * DAY) // oldest
    const b = await seed('b', 400, 5 * DAY)
    const c = await seed('c', 400, 1 * DAY) // newest
    const r = await pruneHistoryCache({ now: NOW, maxBytes: 900 })
    expect(r.removed).toBe(1)
    expect(await exists(a)).toBe(false)
    expect(await exists(b)).toBe(true)
    expect(await exists(c)).toBe(true)
    expect(r.remainingBytes).toBe(800)
  })

  it('a write still coalescing is live, whatever its file\'s age says', async () => {
    const sid = 'live-session'
    const file = await seed(sid, 100, 40 * DAY)
    writeHistoryCache(sid, [{ role: 'assistant', text: 'hi', timestamp: 't' }] as never, 123)
    try {
      const r = await pruneHistoryCache({ now: NOW })
      expect(r.removed).toBe(0)
      expect(await exists(file)).toBe(true)
    } finally {
      flushHistoryCacheWrites()
    }
  })

  it('an unreadable directory is a no-op, not a throw', async () => {
    await fs.rm(HISTORY_CACHE_DIR, { recursive: true, force: true })
    const r = await pruneHistoryCache({ now: NOW })
    expect(r).toEqual({ removed: 0, freedBytes: 0, remainingBytes: 0 })
  })

  it('ships with a month and a gigabyte as the defaults', () => {
    expect(HISTORY_CACHE_MAX_AGE_MS).toBe(30 * DAY)
    expect(HISTORY_CACHE_MAX_BYTES).toBe(1024 * 1024 * 1024)
  })
})
