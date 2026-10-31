/**
 * The fleet view over the frozen v1 API (additive, 2026-10): every host Walnut
 * runs work on, one card each (core/hosts/fleet.ts), for the Settings page,
 * the phone and agents (ops `host_list`, `host_get`).
 *
 *   GET /api/v1/hosts?days=30                 → { hosts: FleetHost[], checkedAt }
 *   GET /api/v1/hosts/:host?days=&bucket=     → { host: FleetHost } (404 unknown)
 *
 * Read-only and never dials a host; each daemon call has a deadline and a card
 * whose host did not answer in time keeps its last reading, marked stale.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { normalizeHost } from '../../core/transfer/planner.js'

export const hostsFleetV1Router = Router()

const ALIAS = /^[A-Za-z0-9_.@-]{1,128}$/

function numberParam(v: unknown): number | undefined {
  const n = typeof v === 'string' ? Number(v) : NaN
  return Number.isFinite(n) ? n : undefined
}

hostsFleetV1Router.get('/hosts', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { listFleet } = await import('../../core/hosts/fleet.js')
    const hosts = await listFleet({ days: numberParam(req.query.days) })
    res.json({ hosts, checkedAt: Date.now() })
  } catch (err) { next(err) }
})

hostsFleetV1Router.get('/hosts/:host', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = normalizeHost(String(req.params.host ?? ''))
    if (!ALIAS.test(host)) { res.status(400).json({ error: 'Invalid host alias', code: 'bad_host' }); return }
    const { getFleetHost } = await import('../../core/hosts/fleet.js')
    const card = await getFleetHost(host, { days: numberParam(req.query.days), bucketMinutes: numberParam(req.query.bucket) })
    if (!card) { res.status(404).json({ error: `Walnut has no host named ${host}`, code: 'unknown_host' }); return }
    res.json({ host: card })
  } catch (err) { next(err) }
})
