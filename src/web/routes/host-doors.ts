/**
 * /api/host-doors: the door credentials this leader issues its hosts (core/session-channel/
 * host-credentials.ts, leader-issue.ts), one host at a time.
 *
 *   GET  /:hostKey          { hostKey, revoked, at?, by?, as?, allowed?, credentials }   (never a key)
 *   POST /:hostKey/revoke   a ban: its key is dropped, its door socket closes, its session channel
 *                           is cut on every link (nothing it sends is applied), a start aimed at it
 *                           fails on every path, its sessions' relayed calls are refused, its journal
 *                           is held on it, and nothing is issued to it until an allow → the GET's
 *                           answer, `closed`, `refused` and `stillReaches` (both from one table:
 *                           revoked-reach.ts REVOKED_REACH). A ban is of the host's machine: under
 *                           any of its names (aliases of one daemon), the GET says `as` when the
 *                           ban was made under another name; only an allow under that name lifts it
 *                           (another name answers 409 `banned_as`, naming it)
 *   POST /:hostKey/allow    let it be issued a key again (at its next link check, at once when linked)
 *                           → the GET's answer and `allowedNow` (false: it was not revoked). What the
 *                           host kept while revoked comes in as it is: its journal drains, and the
 *                           channel records it was refused (never acked) are sent again on its next
 *                           link and judged by the rules of then (a session it was handed, its task).
 *   Both answer `standbySynced: false` when the standby batch did not end in time.
 *
 * A person and a session may both do it (CLAUDE.md, "Every human action is an agent action too");
 * the record says who (`by`, changed-by.ts: `human`, `task:<id>`, `agent`, and the host a call came
 * through). Never the host itself: a call that came through `hostKey`'s own link (its sessions'
 * calls, relayed by its daemon: x-walnut-origin `host:<hostKey>`, which a caller can only lower) is
 * refused 403 `own_host`, as is a call whose origin is not known. What stays after a revoke is the
 * leader's daemon link of a host in its config (`stillReaches`): removing it from the config, or
 * turning it off, ends that (revokeHostsGone). Leader only: a replica answers 404. Nothing here waits on a host:
 * the standby batch an act takes is bounded (leader-issue.ts syncStandbyBounded).
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { isFollower } from '../../core/server-role.js'
import { log } from '../../logging/index.js'
import { changedBy } from './changed-by.js'
import { requestOrigin } from '../middleware/request-origin.js'
import { UNKNOWN_ORIGIN } from '../../lib/caller-origin.js'

export const hostDoorsRouter = Router()

const HOST_KEY = /^[A-Za-z0-9._-]{1,64}$/

hostDoorsRouter.use((_req, res, next) => {
  if (isFollower()) { res.status(404).json({ error: 'not_found' }); return }
  next()
})

function hostKeyOf(req: Request, res: Response): string | null {
  const hostKey = String(req.params.hostKey ?? '')
  if (HOST_KEY.test(hostKey)) return hostKey
  res.status(400).json({ error: 'not a host key', code: 'bad_host_key' })
  return null
}

/**
 * A revoke or an allow of `hostKey` that came through that host's own link, through any name of its
 * machine, through any host a ban covers now (a revoked host never revokes or allows anything, under
 * whatever name it calls from: S1 of the C7 review), or from nowhere known: refused.
 */
async function refusedCaller(req: Request, res: Response, hostKey: string): Promise<boolean> {
  const origin = requestOrigin(req)
  // fromHost: a call relayed over another alias of the same daemon is that host's too.
  const [{ fromHost }, { revokedAs, sameMachine }] = await Promise.all([import('../../core/hosts/session-host-origin.js'), import('../../core/session-channel/revoked-hosts.js')])
  const via = origin.startsWith('host:') ? origin.slice('host:'.length) : ''
  const covered = !!via && (revokedAs(via) !== null || sameMachine(via, hostKey))
  if (origin !== UNKNOWN_ORIGIN && !covered && !(await fromHost(hostKey, origin))) return false
  log.web.warn('host door: a revoke or allow was refused (it came through the host itself, a revoked host, or from an unknown origin)', { host: hostKey, origin })
  res.status(403).json({ error: `A host's door is revoked or allowed from this leader or another machine that is not revoked, never through ${hostKey} itself.`, code: 'own_host' })
  return true
}

/** The door of `hostKey`'s machine, under whichever of its names its record was issued (`as`: the name of the ban when it is another). */
async function doorOf(hostKey: string) {
  const { hostCredentials, hostRecordsIn, revokedHostIn } = await import('../../core/session-channel/host-credentials.js')
  const all = await hostCredentials()
  const recs = hostRecordsIn(all, hostKey)
  const ban = revokedHostIn(all, hostKey)
  const allowed = recs.find((d) => d.allowed)?.allowed
  const revoked = ban ? { at: ban.at, by: ban.by, ...(ban.as !== hostKey ? { as: ban.as } : {}) } : null
  return { hostKey, revoked: !!revoked, ...(revoked ?? {}), ...(allowed ? { allowed } : {}), credentials: recs.filter((d) => !!d.verifyKey).length }
}

hostDoorsRouter.get('/:hostKey', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hostKey = hostKeyOf(req, res)
    if (hostKey) res.json(await doorOf(hostKey))
  } catch (err) { next(err) }
})

hostDoorsRouter.post('/:hostKey/revoke', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hostKey = hostKeyOf(req, res)
    if (!hostKey || await refusedCaller(req, res, hostKey)) return
    const by = await changedBy(req)
    const [{ revokeHostDoorNow }, { REVOKED_STILL_REACHES, REVOKED_REFUSED }] = await Promise.all([
      import('../../core/session-channel/leader-issue.js'), import('../../core/session-channel/revoked-reach.js'),
    ])
    const out = await revokeHostDoorNow(hostKey, by)
    if (!out.revoked) {
      // A record only the machine id this key's hello claims ties to it is another host's: named, not banned (N1).
      const skipped = out.skipped.length ? `; its daemon names the machine of ${out.skipped.join(', ')}, which is not banned by this key: revoke that host by its own name` : ''
      res.status(404).json({ error: `${hostKey} holds no door credential here and has not linked yet; there is nothing to revoke${skipped}`, code: 'no_door_credential', ...(out.skipped.length ? { skipped: out.skipped } : {}) })
      return
    }
    log.web.info('host door: a host was revoked', { host: hostKey, by, closed: out.closed })
    res.json({
      ...(await doorOf(hostKey)), closed: out.closed, refused: REVOKED_REFUSED, stillReaches: REVOKED_STILL_REACHES, standbySynced: out.standbySynced,
      ...(out.skipped.length ? { skipped: out.skipped } : {}), ...(out.tunnelBack ? { tunnel: 'the tunnel ran there; it runs here again' } : {}),
      // Its cloud bridge tokens, deleted at the companion; one it did not answer for is tried again each minute.
      ...(out.bridgeTokens.revoked.length || out.bridgeTokens.failed.length ? { bridgeTokens: out.bridgeTokens } : {}),
    })
  } catch (err) { next(err) }
})

hostDoorsRouter.post('/:hostKey/allow', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hostKey = hostKeyOf(req, res)
    if (!hostKey || await refusedCaller(req, res, hostKey)) return
    const by = await changedBy(req)
    const { allowHostDoorNow } = await import('../../core/session-channel/leader-issue.js')
    const { HostBannedAs } = await import('../../core/session-channel/host-credentials.js')
    const out = await allowHostDoorNow(hostKey, by).catch((err: unknown) => {
      if (err instanceof HostBannedAs) { res.status(409).json({ error: err.message, code: 'banned_as', as: err.as }); return null }
      throw err
    })
    if (!out) return
    if (out.allowed) log.web.info('host door: a revoked host was allowed again', { host: hostKey, by })
    res.json({ ...(await doorOf(hostKey)), allowedNow: out.allowed, standbySynced: out.standbySynced })
  } catch (err) { next(err) }
})
