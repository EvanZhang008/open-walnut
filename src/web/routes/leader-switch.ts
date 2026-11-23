/**
 * /api/leader: this server's side of a switchable leader (core/leader/switch/). Mounted only
 * while the permit runs (experiment switchable_leader with a leader_switch section).
 *
 *   GET  /status    its program version, machine, whether it is a trial start, its permission,
 *                   and the data dir its hosts know it by (`homeOnHosts`: a switch declares it to
 *                   them as where the Walnut moved from, core/leader/switch/moved-home.ts)
 *   POST /handover  { to }: this server writes the switch's handover record (the witnesses take
 *                   it only from the process that holds the permission), and acts no more.
 *                   First what must land before it (core/leader/switch/before-handover.ts)
 *   POST /cancel    takes a handover it wrote back and leads again
 *   GET  /witnesses the witnesses' record as this server reads it over its own links (the switch command
 *                   and `walnut leader status` read remote witnesses only through it)
 *   POST /witnesses/init   sets the remote witnesses of leader_switch up over this server's host links
 *                   (`walnut leader witnesses init` calls it: only a leader server may describe this
 *                   Walnut to a host, so a command-line process cannot reach them itself)
 *
 * The two POSTs are the switch command's, run on this machine: they answer only a request from
 * this machine (fromThisMachine), whatever token another device holds.
 */
import { Router, type Request, type Response, type NextFunction } from 'express'
import { getVersion } from '../../core/version.js'
import { currentLeaderPermit } from '../../core/leader/switch/boot.js'
import { fromThisMachine } from '../middleware/local-trust.js'
import { log } from '../../logging/index.js'
import { homeOnHosts as homeOnHostsNow } from '../../core/home-move.js'

export const leaderSwitchRouter = Router()

leaderSwitchRouter.get('/status', async (_req, res) => {
  const p = currentLeaderPermit()
  // WALNUT_LEADER_SWITCH_FAKE_VERSION: the rehearsal's way to start a server that claims an older program.
  const version = process.env.WALNUT_LEADER_SWITCH_FAKE_VERSION || getVersion()
  const homeOnHosts = await homeOnHostsNow().catch(() => null)
  res.json({ version, machine: p?.machine ?? null, trial: p?.trial ?? false, permit: p?.runtime.status() ?? null, ...(homeOnHosts ? { homeOnHosts } : {}) })
})

const thisMachineOnly = (req: Request, res: Response, next: NextFunction) => {
  if (!fromThisMachine(req)) { res.status(403).json({ ok: false, why: 'only the switch command on this machine may use this' }); return }
  next()
}

leaderSwitchRouter.post('/handover', thisMachineOnly, async (req, res) => {
  const p = currentLeaderPermit()
  const to = typeof req.body?.to === 'string' ? req.body.to : ''
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  if (!to || to === p.machine) { res.status(400).json({ ok: false, why: 'name the machine to hand over to' }); return }
  // What must land before the handover record (this machine's console on the new leader, ...).
  const [{ beforeHandover }, { listeningAddress }, { WALNUT_HOME }] = await Promise.all([
    import('../../core/leader/switch/before-handover.js'), import('../server.js'), import('../../constants.js'),
  ])
  const before = await beforeHandover({ to, machine: p.machine, home: WALNUT_HOME, address: listeningAddress() })
  if (!before.ok) { res.status(409).json({ ok: false, why: before.why }); return }
  const r = await p.runtime.handover(to)
  // Not handed over: the console minted for it will never stand.
  if (!r.ok) await withdrawConsoleQuietly(p.machine, WALNUT_HOME)
  res.status(r.ok ? 200 : 409).json({ ok: r.ok, ...(r.record ? { record: r.record.number } : {}), ...(r.why ? { why: r.why } : {}) })
})

leaderSwitchRouter.post('/cancel', thisMachineOnly, async (_req, res) => {
  const p = currentLeaderPermit()
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  const r = await p.runtime.cancel()
  // This server leads on: the console minted for the handover will never stand.
  if (r.ok) await withdrawConsoleQuietly(p.machine, (await import('../../constants.js')).WALNUT_HOME)
  res.status(r.ok ? 200 : 409).json(r)
})

/** How long init's read of the witnesses waits for one that has not answered yet. */
const SETUP_READ_WAIT_MS = 10_000

leaderSwitchRouter.post('/witnesses/init', thisMachineOnly, async (_req, res) => {
  const p = currentLeaderPermit()
  // Before it leads a server opens no link that describes this Walnut to a host as its leader: its first setups go
  // only where that needs none (its own machine's witness, a registered reach, a direct door's companion lane).
  // Once it leads, records exist: a witness still missing is added through the permit core's list change, over
  // its link (docs/reference/leader-switch.md, "Setup only from nothing" and "A witness that joins later").
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server is not running the write permission (start it as the leader with the experiment and leader_switch set)' }); return }
  const [{ readHomeSwitchConfig, isRemoteWitness }, { setUpRemoteWitnesses }, { hostLinkCall, thisWalnutId }, { setUpCompanionWitness }, { witnessRoot }, { WALNUT_HOME }] = await Promise.all([
    import('../../core/leader/switch/settings.js'), import('../../core/leader/switch/witness-setup.js'), import('../../core/leader/switch/witness-transport.js'),
    import('../../core/leader/switch/witness-direct.js'), import('../../core/leader/switch/machine-id.js'), import('../../constants.js'),
  ])
  const cfg = readHomeSwitchConfig(WALNUT_HOME)
  if (!cfg.settings) { res.status(409).json({ ok: false, why: cfg.problem ?? 'no leader_switch section' }); return }
  const list = cfg.settings.witnesses.map((w) => w.id)
  const walnutId = await thisWalnutId()
  // The ways and keys init just wrote, for this server's own permit client: only the same fixed list (ids and order).
  if (!p.runtime.setWitnessPlaces(cfg.settings.witnesses)) {
    res.status(409).json({ ok: false, why: 'leader_switch.witnesses names other witnesses than this server started with: restart the leader server, then run this again' })
    return
  }
  // The setup's evidence: a witness not heard from in time counts as unreached and stops a first setup, so this read
  // waits longer than a status read (a first TLS handshake to a door, a busy link); it ends once every witness answered.
  const seen = await p.runtime.readWitnesses(SETUP_READ_WAIT_MS)
  const runtime = p.runtime
  // Read live at each call: a link opens only while this server leads.
  const leading = () => runtime.status().state === 'leading'
  const results = await setUpRemoteWitnesses({
    places: cfg.settings.witnesses.filter(isRemoteWitness), list, walnutId, sightings: seen.sightings, here: { machineId: p.machine, root: witnessRoot() },
    call: hostLinkCall({ daemonLink: leading }),
    companion: (w, evidence, join) => setUpCompanionWitness(w, list, walnutId, evidence, undefined, join),
    ...(leading() ? { join: { current: () => runtime.witnessList(), change: (next: string[]) => runtime.changeWitnessList(next), generation: () => runtime.joinGeneration() } } : {}),
  })
  res.json({ ok: results.every((r) => r.ok), results })
})

leaderSwitchRouter.get('/witnesses', thisMachineOnly, async (_req, res) => {
  const p = currentLeaderPermit()
  // A trial start opens no host link, so it cannot read remote witnesses.
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server is not running the write permission as a leader' }); return }
  res.json({ ok: true, ...(await p.runtime.readWitnesses()) })
})

/** withdrawConsole, logged and never failing the answer it rides on (core/leader/switch/console-credential.ts). */
async function withdrawConsoleQuietly(machine: string, home: string): Promise<void> {
  try {
    const { withdrawConsole } = await import('../../core/leader/switch/console-credential.js')
    const w = await withdrawConsole({ home, machine })
    if (w.device || w.files.length) log.web.info('leader switch: this machine\'s console withdrawn (no handover)', { device: w.device, files: w.files.length })
  } catch (err) {
    log.web.warn('leader switch: this machine\'s console could not be withdrawn', { error: err instanceof Error ? err.message : String(err) })
  }
}
