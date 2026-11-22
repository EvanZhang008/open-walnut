/**
 * /api/leader: this server's side of a switchable leader (core/leader/switch/). Mounted only
 * while the permit runs (experiment switchable_leader with a leader_switch section).
 *
 *   GET  /status    its program version, machine, whether it is a trial start, its permission
 *   POST /handover  { to }: this server writes the switch's handover record (the witnesses take
 *                   it only from the process that holds the permission), and acts no more
 *   POST /cancel    takes a handover it wrote back and leads again
 *
 * The two POSTs are the switch command's, run on this machine: they answer only a request from
 * this machine (fromThisMachine), whatever token another device holds.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { getVersion } from '../../core/version.js'
import { currentLeaderPermit } from '../../core/leader/switch/boot.js'
import { fromThisMachine } from '../middleware/local-trust.js'

export const leaderSwitchRouter = Router()

leaderSwitchRouter.get('/status', (_req, res) => {
  const p = currentLeaderPermit()
  // WALNUT_LEADER_SWITCH_FAKE_VERSION: the rehearsal's way to start a server that claims an older program.
  const version = process.env.WALNUT_LEADER_SWITCH_FAKE_VERSION || getVersion()
  res.json({ version, machine: p?.machine ?? null, trial: p?.trial ?? false, permit: p?.runtime.status() ?? null })
})

const thisMachineOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!fromThisMachine(req)) { res.status(403).json({ ok: false, why: 'only the switch command on this machine may hand the permission over' }); return }
  next()
}

leaderSwitchRouter.post('/handover', thisMachineOnly, async (req, res) => {
  const p = currentLeaderPermit()
  const to = typeof req.body?.to === 'string' ? req.body.to : ''
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  if (!to || to === p.machine) { res.status(400).json({ ok: false, why: 'name the machine to hand over to' }); return }
  const r = await p.runtime.handover(to)
  res.status(r.ok ? 200 : 409).json({ ok: r.ok, ...(r.record ? { record: r.record.number } : {}), ...(r.why ? { why: r.why } : {}) })
})

leaderSwitchRouter.post('/cancel', thisMachineOnly, async (_req, res) => {
  const p = currentLeaderPermit()
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  const r = await p.runtime.cancel()
  res.status(r.ok ? 200 : 409).json(r)
})
