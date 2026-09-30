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
import { ingestHealthSync } from './ingest.js'
import { healthStatus } from './queries.js'
import { HealthSettingsError, deleteHealthData, updateHealthSettings } from './settings.js'

export type HealthAction = 'sync' | 'status' | 'settings' | 'delete'

export interface HealthActionResult {
  status: number
  body: Record<string, unknown>
}

const unreachable = (message: string): HealthActionResult => ({
  status: 503, body: { error: { code: 'primary_unreachable', message } },
})

export function isHealthAction(value: string): value is HealthAction {
  return value === 'sync' || value === 'status' || value === 'settings' || value === 'delete'
}

export async function runHealthAction(action: HealthAction, params: Record<string, unknown>): Promise<HealthActionResult> {
  try {
    if (action === 'sync') {
      const extra = typeof params.rejected === 'number' && Number.isInteger(params.rejected) && params.rejected > 0 ? params.rejected : 0
      const out = ingestHealthSync(params.body, { extraRejected: extra })
      return { status: out.status, body: out.body as unknown as Record<string, unknown> }
    }
    if (action === 'status') return { status: 200, body: healthStatus() as unknown as Record<string, unknown> }
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
