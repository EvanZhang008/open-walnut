/**
 * The places store: the iPhone's sync (validation, the two deliveries of one
 * visit, a name looked up later), the agent reads (window overlap, ongoing vs a
 * departure iOS never reported, local time per visit, grouping by place), the
 * status messages per state, and the delete. Invented places only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-places-store'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { destroyPlacesDbFiles, placesDbPath, placesStoreExists } from '../../../src/core/places/db.js'
import { deletePlacesData, ingestPlacesSync, PLACES_MAX_VISITS_PER_SYNC } from '../../../src/core/places/ingest.js'
import { PlacesQueryError, placesStatus, placesVisits } from '../../../src/core/places/queries.js'
import { runPlacesAction } from '../../../src/core/places/relay.js'

const TZ = 'America/Los_Angeles'
const NOW = Date.parse('2026-10-04T20:00:00Z') // 13:00 in Los Angeles
const ON = { enabled: true, access: 'always' }
const at = (iso: string): string => new Date(Date.parse(iso)).toISOString()
const CAFE = { lat: 37.77493, lon: -122.41942 }
const OFFICE = { lat: 37.79, lon: -122.40 }

function sync(visits: unknown[], extra: Record<string, unknown> = {}, now = NOW) {
  return ingestPlacesSync({ tz: TZ, state: ON, visits, ...extra }, now)
}

beforeEach(() => {
  destroyPlacesDbFiles()
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
})

describe('places sync', () => {
  it('a phone that never turned Places on leaves no store behind', () => {
    const out = ingestPlacesSync({ tz: TZ, state: { enabled: false, access: 'not_determined' }, visits: [] }, NOW)
    expect(out).toMatchObject({ status: 200, body: { accepted: 0 } })
    expect(placesStoreExists()).toBe(false)
    expect(fs.existsSync(path.join(WALNUT_HOME, 'places'))).toBe(false)
  })

  it('turning Places on creates the store with the state alone, private to this user', () => {
    expect(sync([]).status).toBe(200)
    expect(placesStoreExists()).toBe(true)
    expect(fs.statSync(placesDbPath()).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(placesDbPath())).mode & 0o777).toBe(0o700)
    expect(placesStatus(NOW)).toMatchObject({ recording: true, phone: { enabled: true, access: 'always' }, visitCount: 0 })
    expect(placesStatus(NOW).message).toBeUndefined()
  })

  it('the arrival and the departure of one visit are one row; a name looked up later fills in', () => {
    expect(sync([{ id: 'v-1', arrival: at('2026-10-04T16:05:00Z'), ...CAFE, accuracyM: 50 }]).body)
      .toMatchObject({ accepted: 1, inserted: 1, updated: 0 })
    let read = placesVisits({}, NOW)
    expect(read.visits).toEqual([expect.objectContaining({ id: 'v-1', status: 'ongoing', departure: null, durationMin: 235 })])

    expect(sync([{ id: 'v-1', arrival: at('2026-10-04T16:05:00Z'), departure: at('2026-10-04T17:35:00Z'), ...CAFE }]).body)
      .toMatchObject({ accepted: 1, inserted: 0, updated: 1 })
    expect(sync([{ id: 'v-1', departure: at('2026-10-04T17:35:00Z'), ...CAFE, name: 'Blue Door Cafe', address: '1 Market St, San Francisco' }]).body)
      .toMatchObject({ updated: 1 })
    read = placesVisits({}, NOW)
    expect(read.visits).toEqual([{
      id: 'v-1', arrival: '2026-10-04T09:05:00-07:00', departure: '2026-10-04T10:35:00-07:00', durationMin: 90, status: 'ended',
      name: 'Blue Door Cafe', address: '1 Market St, San Francisco', lat: 37.7749, lon: -122.4194, accuracyM: 50,
    }])
    // A later delivery without a name never erases the one already there.
    sync([{ id: 'v-1', arrival: at('2026-10-04T16:05:00Z'), departure: at('2026-10-04T17:35:00Z'), ...CAFE }])
    expect((placesVisits({}, NOW).visits as Array<{ name: string }>)[0].name).toBe('Blue Door Cafe')
  })

  it('bad items are counted and skipped, the rest is stored', () => {
    const good = { id: 'v-ok', arrival: at('2026-10-03T16:00:00Z'), departure: at('2026-10-03T17:00:00Z'), ...CAFE }
    const out = sync([
      good,
      { ...good, id: '' },
      { ...good, id: 'has spaces' },
      { ...good, id: 'x'.repeat(81) },
      { ...good, id: 'v-nolat', lat: undefined },
      { ...good, id: 'v-lat', lat: 91 },
      { ...good, id: 'v-lon', lon: -181 },
      { ...good, id: 'v-nan', lat: Number.NaN },
      { ...good, id: 'v-neither', arrival: null, departure: null },
      { ...good, id: 'v-backwards', arrival: at('2026-10-03T18:00:00Z') },
      { ...good, id: 'v-date-only', arrival: '2026-10-03' },
      { ...good, id: 'v-ancient', arrival: '2001-01-01T00:00:00Z' },
      { ...good, id: 'v-future', departure: at('2026-10-09T00:00:00Z') },
      'not an object',
    ])
    expect(out.body).toMatchObject({ accepted: 1, inserted: 1, rejected: 13 })
  })

  it('names are cleaned and capped, never rejected for length', () => {
    sync([{ id: 'v-long', arrival: at('2026-10-03T16:00:00Z'), departure: at('2026-10-03T17:00:00Z'), ...CAFE, name: `  A\u0000B\n${'x'.repeat(300)}`, address: '' }])
    const [v] = placesVisits({ lastDays: 3 }, NOW).visits as Array<{ name: string; address: string | null }>
    expect(v.name.startsWith('A B ')).toBe(true)
    expect(v.name).toHaveLength(200)
    expect(v.address).toBeNull()
  })

  it('a call over the caps is refused whole, so the phone splits it', () => {
    const many = Array.from({ length: PLACES_MAX_VISITS_PER_SYNC + 1 }, (_, i) => ({ id: `v-${i}`, arrival: at('2026-10-03T16:00:00Z'), ...CAFE }))
    expect(sync(many)).toMatchObject({ status: 413, body: { error: { code: 'too_large' } } })
    expect(ingestPlacesSync([] as unknown, NOW).status).toBe(400)
  })
})

describe('places reads', () => {
  it('a visit iOS never saw leave is ongoing only while it is the latest', () => {
    sync([
      { id: 'v-a', arrival: at('2026-10-02T15:00:00Z'), ...CAFE },
      { id: 'v-b', arrival: at('2026-10-02T19:00:00Z'), departure: at('2026-10-02T23:00:00Z'), ...OFFICE },
    ])
    const visits = placesVisits({ from: '2026-10-02', to: '2026-10-02' }, NOW).visits as Array<{ id: string; status: string; durationMin: number | null }>
    expect(visits.map((v) => [v.id, v.status, v.durationMin])).toEqual([['v-a', 'departure_unknown', null], ['v-b', 'ended', 240]])
    // It does not leak into every later window.
    expect(placesVisits({ from: '2026-10-04', to: '2026-10-04' }, NOW).visits).toEqual([])
  })

  it('the latest visit is not ongoing once Places stopped recording: no departure can come', () => {
    sync([{ id: 'v-last', arrival: at('2026-10-04T16:05:00Z'), ...CAFE }])
    const read = () => (placesVisits({}, NOW).visits as Array<{ status: string; durationMin: number | null }>)[0]
    expect(read()).toMatchObject({ status: 'ongoing', durationMin: 235 })
    sync([], { state: { enabled: false, access: 'always' } })
    expect(read()).toMatchObject({ status: 'departure_unknown', durationMin: null })
    sync([], { state: { enabled: true, access: 'when_in_use' } })
    expect(read()).toMatchObject({ status: 'departure_unknown', durationMin: null })
  })

  it('a window holds every visit overlapping it, oldest first, and an arrival iOS missed is marked', () => {
    sync([
      { id: 'v-overnight', arrival: at('2026-10-03T04:00:00Z'), departure: at('2026-10-03T15:00:00Z'), ...CAFE }, // 21:00 on 10-02 local
      { id: 'v-dep-only', departure: at('2026-10-03T20:00:00Z'), ...OFFICE },
      { id: 'v-before', arrival: at('2026-10-01T16:00:00Z'), departure: at('2026-10-01T17:00:00Z'), ...CAFE },
    ])
    const read = placesVisits({ from: '2026-10-03', to: '2026-10-03' }, NOW)
    const visits = read.visits as Array<{ id: string; arrivalUnknown?: boolean; durationMin: number | null }>
    expect(visits.map((v) => v.id)).toEqual(['v-overnight', 'v-dep-only'])
    expect(visits[1]).toMatchObject({ arrivalUnknown: true, durationMin: null, arrival: null })
    expect(read.from).toBe('2026-10-03T00:00:00-07:00')
    expect(read.to).toBe('2026-10-04T00:00:00-07:00')
  })

  it('times read in the zone the phone was in at the visit', () => {
    sync([{ id: 'v-ny', arrival: at('2026-10-03T13:00:00Z'), departure: at('2026-10-03T14:00:00Z'), ...OFFICE }], { tz: 'America/New_York' })
    const [v] = placesVisits({ lastDays: 3 }, NOW).visits as Array<{ arrival: string }>
    expect(v.arrival).toBe('2026-10-03T09:00:00-04:00')
  })

  it('groups visits by name, or by distance when unnamed, longest total first; `place` filters', () => {
    sync([
      { id: 'v-1', arrival: at('2026-10-01T16:00:00Z'), departure: at('2026-10-01T17:00:00Z'), ...CAFE, name: 'Blue Door Cafe' },
      { id: 'v-2', arrival: at('2026-10-02T16:00:00Z'), departure: at('2026-10-02T16:30:00Z'), ...CAFE, name: 'Blue Door Cafe' },
      { id: 'v-3', arrival: at('2026-10-02T17:00:00Z'), departure: at('2026-10-03T01:00:00Z'), ...OFFICE },
      { id: 'v-4', arrival: at('2026-10-03T17:00:00Z'), departure: at('2026-10-03T19:00:00Z'), lat: OFFICE.lat + 0.0005, lon: OFFICE.lon },
    ])
    const read = placesVisits({ lastDays: 7 }, NOW)
    expect(read.places).toEqual([
      expect.objectContaining({ name: null, visits: 2, totalMin: 600 }),
      expect.objectContaining({ name: 'Blue Door Cafe', visits: 2, totalMin: 90, firstArrival: '2026-10-01T09:00:00-07:00', lastDeparture: '2026-10-02T09:30:00-07:00' }),
    ])
    const cafe = placesVisits({ lastDays: 7, place: 'blue door' }, NOW)
    expect((cafe.visits as unknown[]).length).toBe(2)
    const latest = placesVisits({ lastDays: 7, limit: 1 }, NOW)
    expect(latest).toMatchObject({ count: 1, truncated: true })
    expect((latest.visits as Array<{ id: string }>)[0].id).toBe('v-4')
  })

  it('bad windows are the caller\'s to fix', () => {
    sync([])
    expect(() => placesVisits({ lastDays: 0 }, NOW)).toThrow(PlacesQueryError)
    expect(() => placesVisits({ lastDays: 91 }, NOW)).toThrow(/1 to 90/)
    expect(() => placesVisits({ from: '2026-01-01', to: '2026-10-01' }, NOW)).toThrow(/At most 90 days/)
    expect(() => placesVisits({ from: '2026-10-03', to: '2026-10-01' }, NOW)).toThrow(/before/)
    expect(() => placesVisits({ from: 'yesterday' }, NOW)).toThrow(/YYYY-MM-DD/)
    expect(() => placesVisits({ limit: '0' }, NOW)).toThrow(/limit/)
  })
})

describe('places status', () => {
  it('says what to tell the user in each state', () => {
    sync([], { state: { enabled: true, access: 'when_in_use' } })
    expect(placesStatus(NOW)).toMatchObject({ recording: false })
    expect(placesStatus(NOW).message).toMatch(/not set to Always/)
    expect(placesStatus(NOW).message).not.toMatch(/Privacy & Security|Settings >/)

    sync([{ id: 'v-1', arrival: at('2026-10-01T16:00:00Z'), departure: at('2026-10-01T17:00:00Z'), ...CAFE }], { state: { enabled: false, access: 'always' } })
    expect(placesStatus(NOW).message).toMatch(/^Places is off on the iPhone, so nothing new is recorded\. The 1 visit already on this Mac \(2026-10-01 to 2026-10-01\)/)

    sync([], { state: ON }, Date.parse('2026-09-20T12:00:00Z'))
    expect(placesStatus(NOW).message).toMatch(/^Nothing has come from the iPhone since 2026-09-20/)
    sync([], { state: ON })
    expect(placesStatus(NOW).message).toBeUndefined()
    expect(placesStatus(NOW)).toMatchObject({ recording: true, visitCount: 1, firstVisitAt: '2026-10-01T09:00:00-07:00', lastVisitAt: '2026-10-01T10:00:00-07:00' })
  })

  it('the relay answers status without creating a store, and delete removes the files', async () => {
    const empty = await runPlacesAction('status', {})
    expect(empty.status).toBe(200)
    expect(empty.body).toMatchObject({ recording: false, visitCount: 0 })
    expect(String(empty.body.message)).toMatch(/only from then on/)
    expect(placesStoreExists()).toBe(false)

    sync([{ id: 'v-1', arrival: at('2026-10-01T16:00:00Z'), ...CAFE }])
    expect(deletePlacesData()).toEqual({ removed: 1 })
    for (const suffix of ['', '-wal', '-shm']) expect(fs.existsSync(placesDbPath() + suffix)).toBe(false)
    expect((await runPlacesAction('delete', {})).body).toEqual({ removed: 0 })
    // A stale queued sync after the delete must not bring the old state back silently: it is a new store.
    const sent = await runPlacesAction('sync', { body: { tz: TZ, state: ON, visits: [] } })
    expect(sent.status).toBe(200)
    expect(placesStatus(NOW).visitCount).toBe(0)
  })
})
