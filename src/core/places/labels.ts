/**
 * The user's own names for places: "home", "office", "gym". The phone's lookup
 * gives a street address, which is right but says nothing about what the place
 * IS, and a time report needs "at the office 9:20-18:05", not an address.
 *
 * The user names a place once (an agent calls places_label_set with a visit id or
 * the place name it saw); every later visit within `radius_m` of that point reads
 * with the label. Stored in the places database, which never leaves this Mac;
 * answers carry the label and the kind, never the point.
 */

import { getPlacesDb } from './db.js'
import { PlacesQueryError } from './queries.js'

export const PLACE_KINDS = ['home', 'office', 'gym', 'school', 'shop', 'food', 'outdoors', 'other'] as const
export type PlaceKind = (typeof PLACE_KINDS)[number]

const DEFAULT_RADIUS_M = 150
const MAX_RADIUS_M = 2_000
const MAX_LABELS = 200

export interface PlaceLabel {
  label: string
  kind: PlaceKind
  lat: number
  lon: number
  radiusM: number
  /** The place name the phone gave when it was labelled (for the user's eyes). */
  name: string | null
}

interface LabelRow { key: string; label: string; kind: string; lat: number; lon: number; radius_m: number; name: string | null }

function metres(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const rad = Math.PI / 180
  const dLat = (bLat - aLat) * rad
  const dLon = (bLon - aLon) * rad
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * rad) * Math.cos(bLat * rad) * Math.sin(dLon / 2) ** 2
  return 2 * 6_371_000 * Math.asin(Math.min(1, Math.sqrt(h)))
}

const asKind = (k: string): PlaceKind => ((PLACE_KINDS as readonly string[]).includes(k) ? k as PlaceKind : 'other')

export function listPlaceLabels(): PlaceLabel[] {
  const rows = getPlacesDb().prepare('SELECT key, label, kind, lat, lon, radius_m, name FROM place_labels ORDER BY label').all() as LabelRow[]
  return rows.map((r) => ({ label: r.label, kind: asKind(r.kind), lat: r.lat, lon: r.lon, radiusM: r.radius_m, name: r.name }))
}

/** The label covering a point (the nearest one whose radius holds it), or null. */
export function labelAt(lat: number, lon: number, labels: readonly PlaceLabel[]): PlaceLabel | null {
  let best: PlaceLabel | null = null
  let bestM = Infinity
  for (const l of labels) {
    const m = metres(lat, lon, l.lat, l.lon)
    if (m <= l.radiusM && m < bestM) { best = l; bestM = m }
  }
  return best
}

export interface SetPlaceLabelArgs {
  label: string
  kind?: string
  /** A visit id from places_visits: its point is the label's point. */
  visitId?: string
  /** Or text in a visit's place name or address: the latest such visit's point. */
  place?: string
  radiusM?: number
  remove?: boolean
}

/** Create, move or remove a label. Returns what is stored now (without coordinates). */
export function setPlaceLabel(args: SetPlaceLabelArgs): { label: string; kind?: PlaceKind; name?: string | null; radiusM?: number; removed?: true } {
  const label = typeof args.label === 'string' ? args.label.trim() : ''
  if (!label || label.length > 40) throw new PlacesQueryError('label must be 1 to 40 characters')
  const key = label.toLowerCase()
  const db = getPlacesDb()
  if (args.remove) {
    const gone = db.prepare('DELETE FROM place_labels WHERE key = ?').run(key).changes
    if (!gone) throw new PlacesQueryError(`no place is labelled "${label}"`)
    return { label, removed: true }
  }
  if (args.kind !== undefined && !(PLACE_KINDS as readonly string[]).includes(args.kind)) {
    throw new PlacesQueryError(`kind must be one of: ${PLACE_KINDS.join(', ')}`)
  }
  const radius = args.radiusM ?? DEFAULT_RADIUS_M
  if (!Number.isFinite(radius) || radius < 20 || radius > MAX_RADIUS_M) throw new PlacesQueryError(`radius_m must be from 20 to ${MAX_RADIUS_M}`)
  let point: { lat: number; lon: number; name: string | null } | undefined
  if (args.visitId) {
    point = db.prepare('SELECT lat, lon, name FROM visits WHERE id = ?').get(args.visitId) as typeof point
    if (!point) throw new PlacesQueryError(`no visit with id ${args.visitId}: take an id from places_visits`)
  } else if (args.place && args.place.trim()) {
    const needle = `%${args.place.trim().toLowerCase().replace(/[%_]/g, '')}%`
    point = db.prepare(`SELECT lat, lon, name FROM visits
      WHERE lower(COALESCE(name, '')) LIKE ? OR lower(COALESCE(address, '')) LIKE ?
      ORDER BY COALESCE(arrival_ms, departure_ms) DESC LIMIT 1`).get(needle, needle) as typeof point
    if (!point) throw new PlacesQueryError(`no visit's place name or address contains "${args.place.trim()}"`)
  } else {
    const existing = db.prepare('SELECT lat, lon, name FROM place_labels WHERE key = ?').get(key) as typeof point
    if (!existing) throw new PlacesQueryError('give visit_id (from places_visits) or place (text of its name or address)')
    point = existing
  }
  const count = (db.prepare('SELECT COUNT(*) AS n FROM place_labels WHERE key != ?').get(key) as { n: number }).n
  if (count >= MAX_LABELS) throw new PlacesQueryError(`at most ${MAX_LABELS} place labels`)
  const kind = asKind(args.kind ?? (PLACE_KINDS as readonly string[]).find((k) => k === key) ?? 'other')
  db.prepare(`INSERT INTO place_labels (key, label, kind, lat, lon, radius_m, name, updated_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET label = excluded.label, kind = excluded.kind, lat = excluded.lat, lon = excluded.lon,
      radius_m = excluded.radius_m, name = excluded.name, updated_ms = excluded.updated_ms`)
    .run(key, label, kind, point.lat, point.lon, radius, point.name, Date.now())
  return { label, kind, name: point.name, radiusM: radius }
}
