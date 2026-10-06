/**
 * The agent reads over the places store: places_status and places_visits.
 *
 * Times come back as local wall time with an offset, in the zone the phone was in
 * at the visit (a trip reads in the trip's own time). A visit whose departure never
 * arrived is `ongoing` only while it is the latest one AND the phone is recording;
 * once a later visit exists, or recording stopped (no departure can come then), it
 * reads `departure_unknown` with no length, never a length made up to now.
 */

import { addDays, isDateKey, isValidTz, localDate, localIso, systemTz, zonedMidnight } from '../health/day-key.js'
import { getMeta, getPlacesDb } from './db.js'
import { PLACES_ACCESS, type PlacesAccess } from './ingest.js'

export const PLACES_MAX_RANGE_DAYS = 90
export const PLACES_MAX_VISITS = 1000
const DEFAULT_LIMIT = 300
const DEFAULT_DAYS = 7
const MAX_PLACES = 50
/** Two visits this close (metres) without a name to tell them apart are one place. */
const SAME_PLACE_M = 150
const STALE_DAYS = 7

export class PlacesQueryError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PlacesQueryError'
  }
}

interface VisitRow {
  id: string
  arrival_ms: number | null
  departure_ms: number | null
  lat: number
  lon: number
  accuracy_m: number | null
  name: string | null
  address: string | null
  tz: string
}

export interface PlacesStatus {
  /** The phone says Places is on AND location access is Always: iOS is recording. */
  recording: boolean
  phone: { enabled: boolean | null; access: PlacesAccess | null; reportedAt: string | null }
  visitCount: number
  firstVisitAt: string | null
  lastVisitAt: string | null
  lastUploadAt: string | null
  tz: string
  message?: string
}

export function placesTz(): string {
  const tz = getMeta('lastTz')
  return isValidTz(tz) ? tz : systemTz()
}

const startOf = (r: VisitRow): number => (r.arrival_ms ?? r.departure_ms) as number

// What the agent tells the user. Walnut on the iPhone offers to turn Places on
// itself, in a conversation open on the phone, at the moment a places question
// comes up. So the agent is kept to the one thing the user does: no talk of how
// visits reach this Mac, no route through Settings.
const TURN_ON_HINT =
  'If the user is asking from Walnut on the iPhone, the app is offering to turn it on now: tell them they can turn it on there if they want it. '
  + 'If they are asking anywhere else, tell them to ask the same question in Walnut on the iPhone. '
  + 'Keep it to that: do not explain how the data reaches this Mac, and do not walk the user through Settings or location access.'

export const PLACES_NOT_ON =
  'Places is off. Walnut on the iPhone records the places the user visits only after they turn Places on, and only from then on: '
  + 'there is no history from before that, here or anywhere Walnut can read. '
  + TURN_ON_HINT

const NEEDS_ALWAYS =
  'Places is on in Walnut on the iPhone, but location access for Walnut is not set to Always, so iOS records no visits. '
  + 'When the user asks about places in Walnut on the iPhone, the app shows them a note with a button that opens the setting: tell them to follow it. '
  + 'Do not recite a path through Settings, and do not explain how the data reaches this Mac.'

function offWithData(count: number, first: string | null, last: string | null): string {
  const span = first && last ? ` (${first.slice(0, 10)} to ${last.slice(0, 10)})` : ''
  return `Places is off on the iPhone, so nothing new is recorded. The ${count} visit${count === 1 ? '' : 's'} already on this Mac${span} can still be read. ${TURN_ON_HINT}`
}

function stale(lastUploadAt: string): string {
  return `Nothing has come from the iPhone since ${lastUploadAt.slice(0, 10)}. If the user has been anywhere since, ask them to open Walnut on the iPhone once.`
}

export function placesStatus(now = Date.now()): PlacesStatus {
  const db = getPlacesDb()
  const tz = placesTz()
  const agg = db.prepare(`
    SELECT COUNT(*) AS n,
      MIN(COALESCE(arrival_ms, departure_ms)) AS first,
      MAX(MAX(COALESCE(arrival_ms, 0), COALESCE(departure_ms, 0))) AS last
    FROM visits`).get() as { n: number; first: number | null; last: number | null }
  const enabledRaw = getMeta('phoneEnabled')
  const accessRaw = getMeta('phoneAccess')
  const access = accessRaw && (PLACES_ACCESS as readonly string[]).includes(accessRaw) ? accessRaw as PlacesAccess : null
  const enabled = enabledRaw === undefined ? null : enabledRaw === '1'
  const lastUploadAt = getMeta('lastUploadAt') ?? null
  const status: PlacesStatus = {
    recording: enabled === true && access === 'always',
    phone: { enabled, access, reportedAt: getMeta('phoneStateAt') ?? null },
    visitCount: agg.n,
    firstVisitAt: agg.first !== null && agg.n > 0 ? localIso(agg.first, tz) : null,
    lastVisitAt: agg.last ? localIso(agg.last, tz) : null,
    lastUploadAt,
    tz,
  }
  const message = statusMessage(status, now)
  if (message) status.message = message
  return status
}

export function statusMessage(s: PlacesStatus, now = Date.now()): string | undefined {
  if (s.phone.enabled !== true) return s.visitCount > 0 ? offWithData(s.visitCount, s.firstVisitAt, s.lastVisitAt) : PLACES_NOT_ON
  if (s.phone.access !== 'always') return NEEDS_ALWAYS
  if (s.lastUploadAt && now - Date.parse(s.lastUploadAt) > STALE_DAYS * 86_400_000) return stale(s.lastUploadAt)
  return undefined
}

export interface PlacesVisitsArgs {
  lastDays?: number
  from?: string
  to?: string
  place?: string
  limit?: number | string
}

function toInstant(value: string, tz: string, endOfDay: boolean): number {
  if (isDateKey(value)) return zonedMidnight(endOfDay ? addDays(value, 1) : value, tz)
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new PlacesQueryError('from/to must be YYYY-MM-DD dates or ISO-8601 instants')
  return ms
}

function window(args: PlacesVisitsArgs, tz: string, now: number): { from: number; to: number } {
  if (args.lastDays !== undefined && (!Number.isInteger(args.lastDays) || args.lastDays < 1 || args.lastDays > PLACES_MAX_RANGE_DAYS)) {
    throw new PlacesQueryError(`last_days must be a whole number from 1 to ${PLACES_MAX_RANGE_DAYS}`)
  }
  let from: number
  let to: number
  if (args.from || args.to) {
    to = args.to ? toInstant(args.to, tz, true) : now
    from = args.from ? toInstant(args.from, tz, false) : zonedMidnight(addDays(localDate(to - 1, tz), -(DEFAULT_DAYS - 1)), tz)
  } else {
    const days = args.lastDays ?? DEFAULT_DAYS
    to = now
    from = zonedMidnight(addDays(localDate(now, tz), -(days - 1)), tz)
  }
  if (from >= to) throw new PlacesQueryError('from must be before to')
  if (to - from > (PLACES_MAX_RANGE_DAYS + 1) * 86_400_000) throw new PlacesQueryError(`At most ${PLACES_MAX_RANGE_DAYS} days per read: split the range`)
  return { from, to }
}

function parseLimit(raw: number | string | undefined): number {
  if (raw === undefined) return DEFAULT_LIMIT
  const n = typeof raw === 'number' ? raw : /^\d+$/.test(raw) ? Number(raw) : Number.NaN
  if (!Number.isInteger(n) || n < 1 || n > PLACES_MAX_VISITS) throw new PlacesQueryError(`limit must be a whole number from 1 to ${PLACES_MAX_VISITS}`)
  return n
}

const round = (v: number, places: number): number => Math.round(v * 10 ** places) / 10 ** places

function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLon = (bLon - aLon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

export interface PlaceVisit {
  id: string
  arrival: string | null
  departure: string | null
  durationMin: number | null
  status: 'ended' | 'ongoing' | 'departure_unknown'
  arrivalUnknown?: true
  name: string | null
  address: string | null
  lat: number
  lon: number
  accuracyM: number | null
}

export interface PlaceSummary {
  name: string | null
  address: string | null
  lat: number
  lon: number
  visits: number
  totalMin: number
  firstArrival: string | null
  lastDeparture: string | null
}

export function placesVisits(args: PlacesVisitsArgs, now = Date.now()): Record<string, unknown> {
  const tz = placesTz()
  const { from, to } = window(args, tz, now)
  const limit = parseLimit(args.limit)
  const needle = typeof args.place === 'string' && args.place.trim() ? args.place.trim().toLowerCase() : null
  const db = getPlacesDb()
  const status = placesStatus(now)
  // A departure-less visit is a candidate for every window until its real end is
  // known (the next visit's start), which is worked out below.
  const rows = db.prepare(`
    SELECT id, arrival_ms, departure_ms, lat, lon, accuracy_m, name, address, tz FROM visits
    WHERE COALESCE(arrival_ms, departure_ms) < @to AND COALESCE(departure_ms, 9e15) > @from
    ORDER BY COALESCE(arrival_ms, departure_ms)`).all({ from, to }) as VisitRow[]
  const nextStart = db.prepare('SELECT MIN(COALESCE(arrival_ms, departure_ms)) AS t FROM visits WHERE COALESCE(arrival_ms, departure_ms) > ?')

  const visits: PlaceVisit[] = []
  for (const r of rows) {
    const start = startOf(r)
    let visitStatus: PlaceVisit['status'] = 'ended'
    let durationMin: number | null = r.arrival_ms !== null && r.departure_ms !== null ? Math.round((r.departure_ms - r.arrival_ms) / 60_000) : null
    if (r.departure_ms === null) {
      const next = (nextStart.get(start) as { t: number | null }).t
      if (next !== null) {
        visitStatus = 'departure_unknown'
        if (next <= from) continue // it ended (somehow) before the window
      } else if (status.recording) {
        visitStatus = 'ongoing'
        durationMin = r.arrival_ms !== null ? Math.max(0, Math.round((now - r.arrival_ms) / 60_000)) : null
      } else {
        visitStatus = 'departure_unknown'
      }
    }
    if (needle && !`${r.name ?? ''}\n${r.address ?? ''}`.toLowerCase().includes(needle)) continue
    const vtz = isValidTz(r.tz) ? r.tz : tz
    const visit: PlaceVisit = {
      id: r.id,
      arrival: r.arrival_ms !== null ? localIso(r.arrival_ms, vtz) : null,
      departure: r.departure_ms !== null ? localIso(r.departure_ms, vtz) : null,
      durationMin,
      status: visitStatus,
      name: r.name,
      address: r.address,
      lat: round(r.lat, 4),
      lon: round(r.lon, 4),
      accuracyM: r.accuracy_m !== null ? Math.round(r.accuracy_m) : null,
    }
    if (r.arrival_ms === null) visit.arrivalUnknown = true
    visits.push(visit)
  }
  const truncated = visits.length > limit
  const kept = truncated ? visits.slice(visits.length - limit) : visits

  const places: Array<PlaceSummary & { _lat: number; _lon: number }> = []
  for (const v of kept) {
    const key = v.name ? `${v.name}\n${v.address ?? ''}`.toLowerCase() : null
    let place = places.find((p) =>
      (key !== null && p.name !== null && `${p.name}\n${p.address ?? ''}`.toLowerCase() === key)
      || ((key === null || p.name === null) && metres(p._lat, p._lon, v.lat, v.lon) <= SAME_PLACE_M))
    if (!place) {
      place = { name: v.name, address: v.address, lat: v.lat, lon: v.lon, visits: 0, totalMin: 0, firstArrival: null, lastDeparture: null, _lat: v.lat, _lon: v.lon }
      places.push(place)
    }
    if (!place.name && v.name) { place.name = v.name; place.address = v.address }
    place.visits++
    place.totalMin += v.durationMin ?? 0
    // Visits run oldest first, so the first arrival seen is the earliest.
    if (v.arrival && !place.firstArrival) place.firstArrival = v.arrival
    if (v.departure) place.lastDeparture = v.departure
  }
  places.sort((a, b) => b.totalMin - a.totalMin || b.visits - a.visits)

  const body: Record<string, unknown> = {
    tz,
    from: localIso(from, tz),
    to: localIso(to, tz),
    count: kept.length,
    visits: kept,
    places: places.slice(0, MAX_PLACES).map(({ _lat, _lon, ...p }) => p),
    recording: status.recording,
  }
  if (truncated) body.truncated = true
  if (status.message) body.message = status.message
  return body
}
