/**
 * /api/v1 Apple Health (additive, frozen contract): the iPhone reads HealthKit
 * itself and keeps this Mac up to date, and manages the store.
 *
 *   POST   /api/v1/health/sync      one batch of samples / buckets / deletions
 *   GET    /api/v1/health/status    storeId, paused, coverage, per-type freshness
 *   PUT    /api/v1/health/settings  { paused?, sleepSourceOrder?, categories?, preferredUnits? }
 *   DELETE /api/v1/health/data      { categories? }: delete, rotate storeId, pause
 *
 * The primary (Mac) is the ONLY writer. On a cloud REPLICA every call is a Class B
 * relay over `session.control` (`server.health.*`), and the replica keeps nothing:
 * no store, no queue. Same honesty contract as POST /time/heartbeats:
 *   200                   the SQLite transaction committed; the phone may forget the batch
 *   503 primary_unreachable  nothing stored (bridge down, primary server down, or a
 *                         primary that predates the action): keep it queued and retry
 *   409 store_mismatch    the store was deleted and re-created: reset anchors, resync
 *   413 too_large         over the per-call caps: split the batch
 * No failure is ever a 4xx that tells the phone to drop data.
 *
 * Access: this Mac, or a paired phone's DEVICE token (not an API key), and never
 * a loopback self-call the server makes for a caller off this Mac (x-walnut-origin,
 * see middleware/health-access.ts). The internal reads under /api/health/* are
 * narrower: a caller on this Mac only.
 *
 * Logs record counts and outcomes only, never a value.
 */

import { Router, type Request, type Response } from 'express'
import { CLOUD_MODE } from '../../constants.js'
import { log } from '../../logging/index.js'
import type { HealthAction } from '../../core/health/relay.js'
import type { SessionControlAction } from '../../core/sessions/session-controls.js'
import { requirePhoneOrThisMachine } from '../middleware/health-access.js'

export const healthV1Router = Router()

/** Box-level relay actions carry no real session id (same as time/routines). */
const SERVER_RELAY_SID = '__server__'
/** A batch is one short transaction on the primary; a primary silent this long will not answer. */
const RELAY_TIMEOUT_MS = 10_000
/** Hard ceiling for a relayed payload: under the 256 KB bridge frame, with room for the envelope. */
const RELAY_MAX_BYTES = 240 * 1024

function sendUnreachable(res: Response, message = 'Apple Health data could not reach the primary box: keep it queued and retry'): void {
  res.status(503).json({ error: { code: 'primary_unreachable', message } })
}

async function handle(res: Response, action: HealthAction, body: unknown): Promise<void> {
  try {
    if (CLOUD_MODE) {
      await relay(res, action, body)
      return
    }
    const { runHealthAction } = await import('../../core/health/relay.js')
    const out = await runHealthAction(action, { body }, { direct: true })
    res.status(out.status).json(out.body)
  } catch (err) {
    log.web.warn('v1 health request failed', { action, error: err instanceof Error ? err.message : String(err) })
    if (res.headersSent) { res.end(); return }
    sendUnreachable(res)
  }
}

/** REPLICA: narrow, bound, forward, and pass the primary's answer through verbatim. */
async function relay(res: Response, action: HealthAction, body: unknown): Promise<void> {
  const { RELAY_GENERIC_FLAG } = await import('../../core/health/relay.js')
  let params: Record<string, unknown> = { body, [RELAY_GENERIC_FLAG]: true }
  if (action === 'sync') {
    const { sanitizeHealthSync, relayPayload } = await import('../../core/health/sanitize.js')
    const clean = sanitizeHealthSync(body)
    if (!clean.ok) {
      res.status(413).json({ error: { code: clean.code, message: clean.message }, maxItems: clean.maxItems, maxBytes: clean.maxBytes })
      return
    }
    params = { body: relayPayload(clean.batch), rejected: clean.rejected, [RELAY_GENERIC_FLAG]: true }
  }
  const { serializedBytes } = await import('../../core/health/sanitize.js')
  if (serializedBytes(params) > RELAY_MAX_BYTES) {
    res.status(413).json({ error: { code: 'too_large', message: 'The request is too large to relay: split it and send it again' } })
    return
  }
  const { callPrimaryControl } = await import('./v1-control-relay.js')
  const outcome = await callPrimaryControl(`server.health.${action}` as SessionControlAction, SERVER_RELAY_SID, params, RELAY_TIMEOUT_MS)
  if (outcome.ok) {
    const status = outcome.result.status
    const answer = outcome.result.body
    if (typeof status === 'number' && status >= 200 && status < 600 && answer && typeof answer === 'object') {
      log.web.debug('v1 health relayed to the primary', { action, status })
      res.status(status).json(answer)
      return
    }
    log.web.warn('v1 health relay: the primary answered an unreadable shape', { action })
    sendUnreachable(res)
    return
  }
  log.web.info('v1 health could not reach the primary: client will retry', {
    action, failureKind: outcome.failure.kind,
  })
  sendUnreachable(res)
}

// A self-call the server makes for someone off this Mac never reaches the store:
// that is how a remote host's `api DELETE /api/v1/health/data` wiped it (2026-09 gate).
healthV1Router.use('/health', requirePhoneOrThisMachine)
healthV1Router.post('/health/sync', (req: Request, res: Response) => handle(res, 'sync', req.body))
healthV1Router.get('/health/status', (_req: Request, res: Response) => handle(res, 'status', undefined))
healthV1Router.put('/health/settings', (req: Request, res: Response) => handle(res, 'settings', req.body))
healthV1Router.delete('/health/data', (req: Request, res: Response) => handle(res, 'delete', req.body))
