/**
 * Local page-use counts (src/core/page-visits.ts, route src/web/routes/page-visits.ts):
 * bounded, lenient on a bad file, never counting a test run. The web half (one key per
 * page and Settings pane) is tests/web/page-visit-keys.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import express from 'express'
import request from 'supertest'
import {
  KEEP_DAYS, MAX_KEYS, applyVisits, flushVisitsNow, readVisits, recordVisits, sanitizeStore,
  setPageVisitsFileForTesting, type VisitStore,
} from '../../src/core/page-visits.js'
import { pageVisitsRouter } from '../../src/web/routes/page-visits.js'

let dir: string
let file: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'page-visits-'))
  file = path.join(dir, 'local', 'page-visits.json')
  setPageVisitsFileForTesting(file)
})
afterEach(() => {
  setPageVisitsFileForTesting(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

const empty = (): VisitStore => ({ version: 1, since: '2026-10-01T00:00:00.000Z', keys: {} })

describe('page visit store', () => {
  it('counts visits per key and per day, and ignores keys outside the shape', () => {
    const s = empty()
    const now = new Date('2026-10-31T10:00:00Z')
    expect(applyVisits(s, ['page:org', 'page:org', 'settings:sessions', 'bogus', 'page:../x', 'page:' + 'a'.repeat(80)], now)).toBe(3)
    expect(s.keys['page:org']).toMatchObject({ count: 2, days: { '2026-10-31': 2 }, lastAt: now.toISOString() })
    expect(Object.keys(s.keys).sort()).toEqual(['page:org', 'settings:sessions'])
  })

  it('stays bounded: old days drop off and the least recently used key goes past the cap', () => {
    const s = empty()
    const old = new Date('2026-01-01T00:00:00Z')
    applyVisits(s, ['page:old'], old)
    for (let i = 0; i < MAX_KEYS; i++) applyVisits(s, [`page:p${i}`], new Date(Date.UTC(2026, 9, 1, 0, 0, i)))
    expect(Object.keys(s.keys)).toHaveLength(MAX_KEYS)
    expect(s.keys['page:old']).toBeUndefined()
    const later = new Date(Date.UTC(2026, 9, 1) + (KEEP_DAYS + 1) * 86_400_000)
    applyVisits(s, ['page:p1'], later)
    expect(Object.keys(s.keys['page:p1'].days)).toEqual([later.toISOString().slice(0, 10)])
  })

  it('reads a broken or foreign file as empty, never throwing', () => {
    expect(sanitizeStore(null).keys).toEqual({})
    expect(sanitizeStore({ keys: { 'page:a': { count: 'x' }, 'nope': { count: 1, firstAt: 'a', lastAt: 'b' } } }).keys).toEqual({})
    const kept = sanitizeStore({ since: '2026-09-01T00:00:00Z', keys: { 'page:a': { count: 3, firstAt: '2026-10-30T00:00:00Z', lastAt: '2026-10-30T00:00:00Z', days: { '2026-10-30': 3, junk: 1 } } } }, new Date('2026-10-31T00:00:00Z'))
    expect(kept.keys['page:a']).toEqual({ count: 3, firstAt: '2026-10-30T00:00:00Z', lastAt: '2026-10-30T00:00:00Z', days: { '2026-10-30': 3 } })
  })

  it('writes the machine-local file only on flush, and reads it back', async () => {
    await recordVisits(['page:memory'])
    expect(fs.existsSync(file)).toBe(false)
    await flushVisitsNow()
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).keys['page:memory'].count).toBe(1)
    setPageVisitsFileForTesting(file)
    expect((await readVisits()).keys['page:memory'].count).toBe(1)
    fs.writeFileSync(file, '{not json')
    setPageVisitsFileForTesting(file)
    expect((await readVisits()).keys).toEqual({})
  })
})

describe('page visit route', () => {
  const app = express().use(express.json()).use('/api/page-visits', pageVisitsRouter)

  it('counts a person, never a test run, and clears on DELETE', async () => {
    expect((await request(app).post('/api/page-visits').send({ keys: ['page:org'] })).body).toEqual({ counted: 1 })
    const test = await request(app).post('/api/page-visits').set('x-walnut-test-run', 'webdriver-1').send({ keys: ['page:org'] })
    expect(test.body).toMatchObject({ counted: 0, testRun: true })
    expect((await request(app).get('/api/page-visits')).body.keys['page:org'].count).toBe(1)
    expect((await request(app).post('/api/page-visits').send({ keys: 'page:org' })).status).toBe(400)
    await request(app).delete('/api/page-visits')
    expect((await request(app).get('/api/page-visits')).body.keys).toEqual({})
  })
})
