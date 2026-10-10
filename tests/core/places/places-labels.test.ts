/**
 * The user's names for places: label a visit once, and every later visit near it
 * reads with that name, in visits, in the per-place summary and in the status.
 * Answers never carry the label's point. Invented places only.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import fs from 'node:fs'
import { createMockConstants } from '../../helpers/mock-constants.js'

vi.mock('../../../src/constants.js', () => createMockConstants('walnut-places-labels'))

import { WALNUT_HOME } from '../../../src/constants.js'
import { destroyPlacesDbFiles } from '../../../src/core/places/db.js'
import { ingestPlacesSync } from '../../../src/core/places/ingest.js'
import { labelAt, listPlaceLabels, setPlaceLabel } from '../../../src/core/places/labels.js'
import { PlacesQueryError, placesStatus, placesVisits } from '../../../src/core/places/queries.js'

const TZ = 'America/Los_Angeles'
const NOW = Date.parse('2026-10-04T20:00:00Z')
const HOME = { lat: 37.76, lon: -122.43 }
const NEAR_HOME = { lat: 37.7605, lon: -122.4302 } // ~60 m away
const OFFICE = { lat: 37.79, lon: -122.40 }

function sync(visits: unknown[]) {
  return ingestPlacesSync({ tz: TZ, state: { enabled: true, access: 'always' }, visits }, NOW)
}

beforeEach(() => {
  destroyPlacesDbFiles()
  fs.mkdirSync(WALNUT_HOME, { recursive: true })
  sync([
    { id: 'v-home-1', arrival: '2026-10-03T03:00:00Z', departure: '2026-10-03T15:30:00Z', ...HOME, address: '1 Elm St' },
    { id: 'v-office', arrival: '2026-10-03T16:10:00Z', departure: '2026-10-04T01:00:00Z', ...OFFICE, name: 'Pier Building' },
    { id: 'v-home-2', arrival: '2026-10-04T01:40:00Z', departure: '2026-10-04T15:00:00Z', ...NEAR_HOME, address: '3 Elm St' },
  ])
})

describe('place labels', () => {
  it('a label set from one visit names every visit within its radius, and the kind follows a kind-named label', () => {
    expect(setPlaceLabel({ label: 'Home', visitId: 'v-home-1' })).toEqual({ label: 'Home', kind: 'home', name: null, radiusM: 150 })
    expect(setPlaceLabel({ label: 'Work', kind: 'office', place: 'pier' })).toMatchObject({ label: 'Work', kind: 'office', name: 'Pier Building' })
    const read = placesVisits({ from: '2026-10-02', to: '2026-10-04' }, NOW)
    const visits = read.visits as Array<{ id: string; label?: string; labelKind?: string }>
    expect(visits.map((v) => [v.id, v.label, v.labelKind])).toEqual([
      ['v-home-1', 'Home', 'home'], ['v-office', 'Work', 'office'], ['v-home-2', 'Home', 'home'],
    ])
    // Two addresses, one label: the summary is one place.
    const places = read.places as Array<{ label?: string; visits: number }>
    expect(places.filter((p) => p.label === 'Home')).toEqual([expect.objectContaining({ visits: 2 })])
  })

  it('the status lists labels without their coordinates', () => {
    setPlaceLabel({ label: 'Home', visitId: 'v-home-1' })
    const status = placesStatus(NOW)
    expect(status.labels).toEqual([{ label: 'Home', kind: 'home', name: null, radiusM: 150 }])
    expect(JSON.stringify(status.labels)).not.toMatch(/37\.76|122\.43/)
  })

  it('relabelling moves the name, a tight radius stops covering the neighbour, remove deletes it', () => {
    setPlaceLabel({ label: 'Home', visitId: 'v-home-1' })
    setPlaceLabel({ label: 'home', radiusM: 30 }) // same key, keeps the point
    const labels = listPlaceLabels()
    expect(labels).toHaveLength(1)
    expect(labelAt(NEAR_HOME.lat, NEAR_HOME.lon, labels)).toBeNull()
    expect(labelAt(HOME.lat, HOME.lon, labels)?.label).toBe('home')
    expect(setPlaceLabel({ label: 'HOME', remove: true })).toEqual({ label: 'HOME', removed: true })
    expect(listPlaceLabels()).toEqual([])
  })

  it('refuses what it cannot place, with a sentence that says what to pass', () => {
    expect(() => setPlaceLabel({ label: '', visitId: 'v-home-1' })).toThrow(PlacesQueryError)
    expect(() => setPlaceLabel({ label: 'Gym', visitId: 'nope' })).toThrow(/take an id from places_visits/)
    expect(() => setPlaceLabel({ label: 'Gym', place: 'climbing' })).toThrow(/contains "climbing"/)
    expect(() => setPlaceLabel({ label: 'Gym' })).toThrow(/give visit_id/)
    expect(() => setPlaceLabel({ label: 'Gym', visitId: 'v-home-1', kind: 'castle' })).toThrow(/kind must be one of/)
    expect(() => setPlaceLabel({ label: 'Gym', visitId: 'v-home-1', radiusM: 5 })).toThrow(/radius_m/)
    expect(() => setPlaceLabel({ label: 'Gym', remove: true })).toThrow(/no place is labelled/)
  })
})
