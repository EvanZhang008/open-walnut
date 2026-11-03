/**
 * The fleet view over the frozen v1 API (additive, 2026-10): every host Walnut
 * runs work on, one card each (core/hosts/fleet.ts), for the Settings page,
 * the phone and agents (ops `host_list`, `host_get`).
 *
 *   GET /api/v1/hosts?days=30                 → { hosts: FleetHost[], checkedAt }
 *   GET /api/v1/hosts?cached=1                → { hosts, checkedAt, refreshing }: at once, from the last read
 *   POST /api/v1/hosts/refresh { hosts? }     → 202 { started, refreshing }: read those hosts again now
 *   GET /api/v1/hosts/:host?days=&bucket=     → { host: FleetHost } (404 unknown)
 *   GET /api/v1/hosts/pick?need=ios           → { pick } (409 no_capable_host): a `@tag` selector resolved
 *   POST /api/v1/hosts/:host/boot-start       → { host: FleetHost }: check (and set up) its start after a reboot now
 *
 * The reads never dial a host; each daemon call has a deadline and a card
 * whose host did not answer in time keeps its last reading, marked stale.
 * The Overview reads `?cached=1` (core/hosts/fleet-refresh.ts): every card at once
 * from what each host answered last, with `readAt` / `refreshing` / `readError`,
 * and reads the hosts again only on a press (POST /hosts/refresh), polling the
 * cached read while that runs. Without `cached` the read is live, as before.
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
    const days = numberParam(req.query.days)
    if (req.query.cached === '1' && (days === undefined || Math.round(days) === 30)) {
      const { cachedFleet } = await import('../../core/hosts/fleet-refresh.js')
      const { hosts, refreshing } = await cachedFleet()
      res.json({ hosts, checkedAt: Date.now(), refreshing })
      return
    }
    const { listFleet } = await import('../../core/hosts/fleet.js')
    const hosts = await listFleet({ days })
    res.json({ hosts, checkedAt: Date.now() })
  } catch (err) { next(err) }
})

// POST /api/v1/hosts/refresh { hosts?: string[] } → 202 { started, refreshing }: the Overview's press. Each named
// host (every host without a list) is read again in the background, each on its own deadline; the cached read
// above shows each card as its read ends. A host Walnut does not list is skipped.
hostsFleetV1Router.post('/hosts/refresh', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const raw = (req.body ?? {}) as { hosts?: unknown }
    let only: string[] | undefined
    if (raw.hosts !== undefined) {
      if (!Array.isArray(raw.hosts) || raw.hosts.length > 64 || !raw.hosts.every((h) => typeof h === 'string' && ALIAS.test(normalizeHost(h)))) {
        res.status(400).json({ error: 'hosts is a list of host aliases', code: 'bad_host' }); return
      }
      only = raw.hosts.map((h) => normalizeHost(h as string))
    }
    const { startFleetRefresh } = await import('../../core/hosts/fleet-refresh.js')
    res.status(202).json(await startFleetRefresh(only))
  } catch (err) { next(err) }
})

// GET /api/v1/hosts/pick?need=ios+always-on → { pick: { host, label, tags, reason } } | 409 no_capable_host.
// Mounted before /hosts/:host. The caller's own host is preferred (x-walnut-caller-sid).
hostsFleetV1Router.get('/hosts/pick', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { parseHostSelector, pickHost, HostSelectorError } = await import('../../core/hosts/host-select.js')
    const need = typeof req.query.need === 'string' ? req.query.need.trim() : ''
    let tags: string[] | null
    try {
      tags = parseHostSelector(need.startsWith('@') ? need : `@${need}`)
    } catch (err) {
      res.status(400).json({ error: (err as Error).message, code: 'bad_selector' }); return
    }
    if (!need || !tags) { res.status(400).json({ error: 'Name what the host needs: ?need=ios (several: ios+always-on)', code: 'bad_selector' }); return }
    let prefer: Array<{ host: string; why: string }> | undefined
    const rawSid = req.headers['x-walnut-caller-sid']
    const sid = (Array.isArray(rawSid) ? rawSid[0] : rawSid)?.trim()
    if (sid) {
      const { resolveCaller } = await import('../../core/sessions/session-send-core.js')
      const caller = await resolveCaller(sid).catch(() => null)
      if (caller?.kind === 'session') prefer = [{ host: caller.record.host || '__local__', why: 'is where the caller runs' }]
    }
    try {
      res.json({ pick: await pickHost(tags, { prefer }) })
    } catch (err) {
      if (err instanceof HostSelectorError) { res.status(err.code === 'bad_selector' ? 400 : 409).json({ error: err.message, code: err.code }); return }
      throw err
    }
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

// POST /api/v1/hosts/:host/boot-start → { host: FleetHost }: the Overview's "Set up" button. The host's
// boot start keeper probes now and sets the daemon up to start after a reboot when that is due; the
// answer is the card after it (held to a deadline: a setup still running reads setupRunning).
hostsFleetV1Router.post('/hosts/:host/boot-start', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const host = normalizeHost(String(req.params.host ?? ''))
    if (!ALIAS.test(host)) { res.status(400).json({ error: 'Invalid host alias', code: 'bad_host' }); return }
    const { checkHostBootStart, BootStartCheckError } = await import('../../core/hosts/fleet.js')
    try {
      res.json({ host: await checkHostBootStart(host) })
    } catch (err) {
      if (err instanceof BootStartCheckError) { res.status(err.code === 'unknown_host' ? 404 : err.code === 'check_failed' ? 502 : 409).json({ error: err.message, code: err.code }); return }
      throw err
    }
  } catch (err) { next(err) }
})
