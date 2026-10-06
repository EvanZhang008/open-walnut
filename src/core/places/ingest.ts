/**
 * One sync from the iPhone: its Places state plus any visits it has not sent yet.
 *
 *   { tz, state?: { enabled, access }, visits?: [{ id, arrival?, departure?, lat, lon,
 *     accuracyM?, name?, address? }] }
 *
 * A visit comes twice under one id (on arrival with no departure, then on
 * departure), and again when the phone has looked up its name, so every row is an
 * upsert that never loses a field it already has. An item that fails validation is
 * counted in `rejected` and skipped; the rest of the batch is stored (a 4xx would
 * make the phone drop good visits with the bad one). Logs carry counts only, never
 * a coordinate or a name.
 */

import { log } from '../../logging/index.js'
import { isValidTz, systemTz } from '../health/day-key.js'
import { destroyPlacesDbFiles, getMeta, getPlacesDb, placesStoreExists, setMeta } from './db.js'

export const PLACES_MAX_VISITS_PER_SYNC = 200
export const PLACES_MAX_SYNC_BYTES = 200 * 1024
const MAX_ID = 80
const MAX_TEXT = 200
/** iOS visit monitoring arrived in iOS 8 (2014); nothing older is a real visit. */
const EARLIEST_MS = Date.UTC(2014, 0, 1)
const FUTURE_SLACK_MS = 24 * 3600_000

export const PLACES_ACCESS = ['always', 'when_in_use', 'denied', 'not_determined', 'restricted'] as const
export type PlacesAccess = typeof PLACES_ACCESS[number]

export interface PlacesSyncResult {
  accepted: number
  inserted: number
  updated: number
  rejected: number
}

export interface PlacesSyncOutcome {
  status: number
  body: PlacesSyncResult | { error: { code: string; message: string }; maxItems?: number; maxBytes?: number }
}

interface CleanVisit {
  id: string
  arrivalMs: number | null
  departureMs: number | null
  lat: number
  lon: number
  accuracyM: number | null
  name: string | null
  address: string | null
}

function cleanText(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim()
  if (!text) return null
  return text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text
}

/** An ISO-8601 instant, or null when absent. `undefined` = present but invalid. */
function instant(value: unknown, now: number): number | null | undefined {
  if (value === undefined || value === null) return null
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return undefined
  const ms = Date.parse(value)
  if (!Number.isFinite(ms) || ms < EARLIEST_MS || ms > now + FUTURE_SLACK_MS) return undefined
  return ms
}

export function cleanVisit(raw: unknown, now: number): CleanVisit | null {
  if (!raw || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.id !== 'string' || v.id.length === 0 || v.id.length > MAX_ID || !/^[A-Za-z0-9._:-]+$/.test(v.id)) return null
  const arrivalMs = instant(v.arrival, now)
  const departureMs = instant(v.departure, now)
  if (arrivalMs === undefined || departureMs === undefined) return null
  if (arrivalMs === null && departureMs === null) return null
  if (arrivalMs !== null && departureMs !== null && departureMs < arrivalMs) return null
  const lat = v.lat
  const lon = v.lon
  if (typeof lat !== 'number' || typeof lon !== 'number' || !Number.isFinite(lat) || !Number.isFinite(lon)) return null
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null
  const accuracyM = typeof v.accuracyM === 'number' && Number.isFinite(v.accuracyM) && v.accuracyM >= 0 ? v.accuracyM : null
  return { id: v.id, arrivalMs, departureMs, lat, lon, accuracyM, name: cleanText(v.name), address: cleanText(v.address) }
}

function cleanState(raw: unknown): { enabled: boolean; access: PlacesAccess | null } | null {
  if (!raw || typeof raw !== 'object') return null
  const s = raw as Record<string, unknown>
  if (typeof s.enabled !== 'boolean') return null
  const access = typeof s.access === 'string' && (PLACES_ACCESS as readonly string[]).includes(s.access)
    ? s.access as PlacesAccess : null
  return { enabled: s.enabled, access }
}

function serializedBytes(body: unknown): number {
  try { return Buffer.byteLength(JSON.stringify(body ?? null), 'utf8') } catch { return Infinity }
}

/** Over the per-call caps: the phone splits the batch. Checked on the replica too, before a relay. */
export function placesSyncTooLarge(body: unknown): PlacesSyncOutcome | null {
  const visits = body && typeof body === 'object' ? (body as Record<string, unknown>).visits : undefined
  const items = Array.isArray(visits) ? visits.length : 0
  if (items <= PLACES_MAX_VISITS_PER_SYNC && serializedBytes(body) <= PLACES_MAX_SYNC_BYTES) return null
  return {
    status: 413,
    body: {
      error: { code: 'too_large', message: 'Too many visits in one call: split the batch' },
      maxItems: PLACES_MAX_VISITS_PER_SYNC, maxBytes: PLACES_MAX_SYNC_BYTES,
    },
  }
}

export function ingestPlacesSync(body: unknown, now = Date.now()): PlacesSyncOutcome {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return { status: 400, body: { error: { code: 'bad_request', message: 'The body must be a JSON object' } } }
  }
  const tooLarge = placesSyncTooLarge(body)
  if (tooLarge) return tooLarge
  const b = body as Record<string, unknown>
  const rawVisits = Array.isArray(b.visits) ? b.visits : []
  const state = cleanState(b.state)
  // A phone that never turned Places on (or turned it off before anything was
  // stored) leaves no store behind.
  if (!placesStoreExists() && rawVisits.length === 0 && state?.enabled !== true) {
    return { status: 200, body: { accepted: 0, inserted: 0, updated: 0, rejected: 0 } }
  }
  const visits: CleanVisit[] = []
  let rejected = 0
  for (const raw of rawVisits) {
    const clean = cleanVisit(raw, now)
    if (clean) visits.push(clean)
    else rejected++
  }
  const tz = isValidTz(b.tz) ? b.tz : null

  const db = getPlacesDb()
  const exists = db.prepare('SELECT 1 FROM visits WHERE id = ?')
  const upsert = db.prepare(`
    INSERT INTO visits (id, arrival_ms, departure_ms, lat, lon, accuracy_m, name, address, tz, received_ms, updated_ms)
    VALUES (@id, @arrivalMs, @departureMs, @lat, @lon, @accuracyM, @name, @address, @tz, @now, @now)
    ON CONFLICT(id) DO UPDATE SET
      arrival_ms = COALESCE(excluded.arrival_ms, visits.arrival_ms),
      departure_ms = COALESCE(excluded.departure_ms, visits.departure_ms),
      lat = excluded.lat,
      lon = excluded.lon,
      accuracy_m = COALESCE(excluded.accuracy_m, visits.accuracy_m),
      name = COALESCE(excluded.name, visits.name),
      address = COALESCE(excluded.address, visits.address),
      tz = excluded.tz,
      updated_ms = excluded.updated_ms
  `)
  let inserted = 0
  let updated = 0
  db.transaction(() => {
    const last = getMeta('lastTz')
    const visitTz = tz ?? (isValidTz(last) ? last : systemTz())
    for (const v of visits) {
      if (exists.get(v.id)) updated++
      else inserted++
      upsert.run({ ...v, tz: visitTz, now })
    }
    const at = new Date(now).toISOString()
    setMeta('lastUploadAt', at)
    if (tz) setMeta('lastTz', tz)
    if (state) {
      setMeta('phoneEnabled', state.enabled ? '1' : '0')
      if (state.access) setMeta('phoneAccess', state.access)
      setMeta('phoneStateAt', at)
    }
  })()
  log.web.info('places sync stored', { accepted: visits.length, inserted, updated, rejected, state: state ? (state.enabled ? 'on' : 'off') : 'none' })
  return { status: 200, body: { accepted: visits.length, inserted, updated, rejected } }
}

/** Delete every visit (the files themselves) and forget the phone's state. */
export function deletePlacesData(): { removed: number } {
  let removed = 0
  if (placesStoreExists()) {
    try {
      removed = (getPlacesDb().prepare('SELECT COUNT(*) AS n FROM visits').get() as { n: number }).n
    } catch { /* counting is best effort; the files go regardless */ }
  }
  destroyPlacesDbFiles()
  log.web.info('places data deleted', { removed })
  return { removed }
}
