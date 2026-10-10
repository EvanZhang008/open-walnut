/**
 * The three phone-facing places actions, answered on the PRIMARY.
 *
 * ONE function serves both paths: the primary's own /api/v1/places routes call it
 * directly, and a replica's relay (`server.places.*` over `session.control`) lands
 * here too. It never throws: every outcome comes back as `{ status, body }`.
 */

import { log } from '../../logging/index.js'
import { placesStoreExists } from './db.js'
import { deletePlacesData, ingestPlacesSync } from './ingest.js'
import { systemTz } from '../health/day-key.js'
import { placesStatus, PLACES_NOT_ON } from './queries.js'

export type PlacesAction = 'sync' | 'status' | 'delete'

export interface PlacesActionResult {
  status: number
  body: Record<string, unknown>
}

export function isPlacesAction(value: string): value is PlacesAction {
  return value === 'sync' || value === 'status' || value === 'delete'
}

/** A Mac that never received a visit answers without creating a store. */
export function emptyPlacesStatus(): Record<string, unknown> {
  return {
    recording: false, phone: { enabled: null, access: null, reportedAt: null },
    visitCount: 0, firstVisitAt: null, lastVisitAt: null, lastUploadAt: null, tz: systemTz(), labels: [], message: PLACES_NOT_ON,
  }
}

export async function runPlacesAction(action: PlacesAction, params: Record<string, unknown>): Promise<PlacesActionResult> {
  try {
    if (action === 'sync') {
      const out = ingestPlacesSync(params.body)
      return { status: out.status, body: out.body as unknown as Record<string, unknown> }
    }
    if (action === 'status') {
      if (!placesStoreExists()) return { status: 200, body: emptyPlacesStatus() }
      return { status: 200, body: placesStatus() as unknown as Record<string, unknown> }
    }
    return { status: 200, body: deletePlacesData() as unknown as Record<string, unknown> }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('places action failed', { action, error: message })
    // A sync that did not commit must read as retry-later: a 4xx would drop the visits.
    if (action === 'sync') return { status: 503, body: { error: { code: 'primary_unreachable', message: 'The primary could not store the visits: keep them queued and retry' } } }
    return { status: 500, body: { error: { code: 'internal', message } } }
  }
}
