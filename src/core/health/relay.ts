/**
 * The four phone-facing health actions, answered on the PRIMARY.
 *
 * ONE function serves both paths: the primary's own /api/v1/health routes call it
 * directly, and a replica's relay (`server.health.*` over `session.control`) lands
 * here too. It never throws: every outcome, a domain refusal included, comes back
 * as `{ status, body }`, so a 409 store_mismatch keeps its `storeId` across the
 * bridge instead of being flattened into a relay error string.
 */

import { log } from '../../logging/index.js'
import { isGenericName } from './catalog.js'
import { isSeriesType } from './series-catalog.js'
import { ingestHealthSync } from './ingest.js'
import { healthStatus } from './queries.js'
import { HealthSettingsError, deleteHealthData, updateHealthSettings } from './settings.js'

export type HealthAction = 'sync' | 'status' | 'settings' | 'delete'

export interface HealthActionResult {
  status: number
  body: Record<string, unknown>
}

/**
 * A replica that relays generic types (q. / c. / x.) intact stamps every relayed
 * call with this. One that predates them narrows a generic batch to an EMPTY one
 * (its sanitize knows no such type, so it drops every item, the unit and the agg)
 * and relays that: storing it would answer 200, and the phone would move its
 * anchor past samples that never arrived. So an unstamped relay gets the server as
 * it was before generic types: a status without `supported.generic` (the phone
 * then sends catalog types only) and a generic sync answered `unsupported`.
 */
export const RELAY_GENERIC_FLAG = 'genericTypes'

/**
 * The same guard for recordings (`s.` types): a replica that predates them keeps
 * no point of a relayed chunk, so an unstamped relay gets a status without
 * `supported.series` and a recording sync answered `unsupported`.
 */
export const RELAY_SERIES_FLAG = 'seriesTypes'

const unreachable = (message: string): HealthActionResult => ({
  status: 503, body: { error: { code: 'primary_unreachable', message } },
})

export function isHealthAction(value: string): value is HealthAction {
  return value === 'sync' || value === 'status' || value === 'settings' || value === 'delete'
}

function withoutSupported(body: Record<string, unknown>, keys: { generic: boolean; series: boolean }): Record<string, unknown> {
  const supported = body.supported
  if (!supported || typeof supported !== 'object' || (!keys.generic && !keys.series)) return body
  const rest = { ...(supported as Record<string, unknown>) }
  if (keys.generic) delete rest.generic
  if (keys.series) delete rest.series
  return { ...body, supported: rest }
}

/** `direct`: the primary's own route, not a relay. */
export async function runHealthAction(
  action: HealthAction, params: Record<string, unknown>, opts: { direct?: boolean } = {},
): Promise<HealthActionResult> {
  const genericAllowed = opts.direct === true || params[RELAY_GENERIC_FLAG] === true
  const seriesAllowed = opts.direct === true || params[RELAY_SERIES_FLAG] === true
  try {
    if (action === 'sync') {
      const extra = typeof params.rejected === 'number' && Number.isInteger(params.rejected) && params.rejected > 0 ? params.rejected : 0
      if (!genericAllowed && isGenericName(typeOf(params.body))) {
        log.web.info('health sync: a generic call through a relay that predates generic types, declined', {})
      }
      if (!seriesAllowed && isSeriesType(typeOf(params.body))) {
        log.web.info('health sync: a recording through a relay that predates recordings, declined', {})
      }
      const out = ingestHealthSync(params.body, { extraRejected: extra, genericAllowed, seriesAllowed })
      return { status: out.status, body: out.body as unknown as Record<string, unknown> }
    }
    if (action === 'status') {
      const body = healthStatus() as unknown as Record<string, unknown>
      return { status: 200, body: withoutSupported(body, { generic: !genericAllowed, series: !seriesAllowed }) }
    }
    if (action === 'settings') return { status: 200, body: updateHealthSettings(params.body) as unknown as Record<string, unknown> }
    return { status: 200, body: deleteHealthData(params.body) as unknown as Record<string, unknown> }
  } catch (err) {
    if (err instanceof HealthSettingsError) {
      return { status: err.status, body: { error: { code: 'bad_request', message: err.message } } }
    }
    const message = err instanceof Error ? err.message : String(err)
    log.web.warn('health action failed', { action, error: message })
    // A sync that did not commit must read as retry-later: 4xx would drop the batch.
    if (action === 'sync') return unreachable('The primary could not store the batch: keep it queued and retry')
    return { status: 500, body: { error: { code: 'internal', message } } }
  }
}

function typeOf(body: unknown): unknown {
  if (!body || typeof body !== 'object') return undefined
  const b = body as Record<string, unknown>
  return b.type ?? b.metric
}
