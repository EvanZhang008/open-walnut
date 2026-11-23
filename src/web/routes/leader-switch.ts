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
 *                   With a switch id: the ticket and the target job over the copy link, then the
 *                   wait for its switch stop (core/leader/switch/final-stop.ts)
 *   POST /cancel    takes a handover it wrote back and leads again
 *   POST /switch/begin       the trust rule of a switch, and the record of who began it
 *   POST /switch/check       the new leader's own check (its target job in check mode), its report
 *   GET  /switch/target      the target job's state, over the copy link
 *   POST /switch/final-stop  the switch stop: the final batch as this server's last step, then it exits
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

/**
 * The switch's handover. With `switchId` (a switch job asks), the copy link to `to` is checked first,
 * and once the record stands the server writes the ticket over it and starts the target job there
 * (core/leader/switch/peer.ts); it then waits for its switch stop, and cancels the handover itself
 * when none comes within stop_wait_s.
 */
leaderSwitchRouter.post('/handover', thisMachineOnly, async (req, res) => {
  const p = currentLeaderPermit()
  const to = typeof req.body?.to === 'string' ? req.body.to : ''
  const switchId: unknown = req.body?.switchId
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  if (!to || to === p.machine) { res.status(400).json({ ok: false, why: 'name the machine to hand over to' }); return }
  const [{ beforeHandover }, { listeningAddress }, { WALNUT_HOME }] = await Promise.all([
    import('../../core/leader/switch/before-handover.js'), import('../server.js'), import('../../constants.js'),
  ])
  let link: Awaited<ReturnType<typeof switchLink>> | null = null
  if (switchId !== undefined) {
    const [{ isSwitchId }, { wasTakenBack }] = await Promise.all([import('../../core/leader/switch/ticket.js'), import('../../core/leader/switch/final-stop.js')])
    if (!isSwitchId(switchId)) { res.status(400).json({ ok: false, why: 'not a switch id' }); return }
    // Its target job holds the first handover's number and deadline: a switch taken back begins anew.
    if (wasTakenBack(switchId)) { res.status(409).json({ ok: false, why: `this server took the handover of switch ${switchId} back: begin a new switch` }); return }
    link = await switchLink(to, p.machine)
    if ('refused' in link) { res.status(409).json({ ok: false, why: link.refused }); return }
  }
  // What must land before the handover record (this machine's console on the new leader, ...).
  const before = await beforeHandover({ to, machine: p.machine, home: WALNUT_HOME, address: listeningAddress() })
  if (!before.ok) { if (link && !('refused' in link)) link.peer.close(); res.status(409).json({ ok: false, why: before.why }); return }
  // A switch's steps for its hosts and this machine's daemon (handover-host-steps.ts), the last of them right before the record.
  const hostSteps = link && !('refused' in link) && typeof switchId === 'string' ? await hostStepsContext(link.settings, p.machine, to, switchId) : null
  if (hostSteps) {
    const { beforeHandoverRecord } = await import('../../core/leader/switch/handover-host-steps.js')
    const h = await beforeHandoverRecord(hostSteps)
    if (!h.ok) { await withdrawConsoleQuietly(p.machine, WALNUT_HOME); link!.peer.close(); res.status(409).json({ ok: false, why: `the hosts could not be readied for ${to}: ${h.why}` }); return }
  }
  const r = await p.runtime.handover(to)
  // Not handed over: the console minted for it will never stand, nor the host steps.
  if (!r.ok) await withdrawConsoleQuietly(p.machine, WALNUT_HOME)
  if (!r.ok && hostSteps) await (await import('../../core/leader/switch/handover-host-steps.js')).undoHostSteps(hostSteps)
  if (r.ok && hostSteps) await (await import('../../core/leader/switch/handover-host-steps.js')).afterHandoverRecord(hostSteps)
  if (!r.ok && link && !('refused' in link)) link.peer.close()
  if (!r.ok || !link || 'refused' in link || typeof switchId !== 'string') {
    res.status(r.ok ? 200 : 409).json({ ok: r.ok, ...(r.record ? { record: r.record.number } : {}), ...(r.why ? { why: r.why } : {}) })
    return
  }
  const started = await startTargetSide({ switchId, to, record: r.record!.number, link, home: WALNUT_HOME, machine: p.machine, test: req.body?.test })
  if (!started.ok) {
    // The new leader's machine has no ticket or no job: take the handover back, lead on.
    const c = await takeBackHandover('the switch job did not start on the new leader\'s machine')
    res.status(409).json({ ok: false, why: `${c.ok ? 'the handover is taken back' : `the handover could not be taken back yet (${c.why})`}: ${started.why}` })
    return
  }
  res.json({ ok: true, record: r.record!.number, commitDeadline: started.commitDeadline })
})

/**
 * The copy link to `to` (core/leader/switch/peer.ts) and the settings, or why there is none. Every switch
 * call that acts on `to` (the begin, the check, the handover) passes the same trust rule here first
 * (final-stop.ts beginRefusal); a target reached as a host must also say its service can lead.
 */
async function switchLink(to: string, me: string): Promise<{ peer: import('../../core/leader/switch/peer.js').SwitchPeer; settings: import('../../core/leader/switch/settings.js').LeaderSwitchSettings } | { refused: string }> {
  const [{ readHomeSwitchConfig, machineById }, { peerFor }, { beginRefusal }, { WALNUT_HOME }, { getConfig }] = await Promise.all([
    import('../../core/leader/switch/settings.js'), import('../../core/leader/switch/peer.js'), import('../../core/leader/switch/final-stop.js'), import('../../constants.js'), import('../../core/config-manager.js'),
  ])
  const cfg = readHomeSwitchConfig(WALNUT_HOME)
  if (!cfg.settings) return { refused: cfg.problem ?? 'no leader_switch section' }
  if (!machineById(cfg.settings, me)) return { refused: `this machine (${me}) is not in leader_switch.machines` }
  const raw = (await getConfig()).standby ?? {}
  const standby = { ...(raw.dir ? { dir: raw.dir } : {}), ...(raw.host ? { host: raw.host } : {}) }
  // A target reached as a host: what this leader's link knows of its service (hello serviceRoles, launcher goodRoles).
  const hostService = standby.host ? ((await (await import('../../core/hosts/fleet.js')).getFleetHost(standby.host).catch(() => null))?.daemon ?? null) : undefined
  const why = beginRefusal({ settings: cfg.settings, me, to, standby, ...(hostService !== undefined ? { hostService } : {}) })
  if (why) return { refused: why }
  const peer = peerFor({ to: machineById(cfg.settings, to)!, standby })
  return 'refused' in peer ? peer : { peer, settings: cfg.settings }
}

/** What the host steps of this switch's handover need, or null when this machine or `to` is not in the list. */
async function hostStepsContext(settings: import('../../core/leader/switch/settings.js').LeaderSwitchSettings, me: string, to: string, switchId: string): Promise<import('../../core/leader/switch/handover-host-steps.js').HostStepsContext | null> {
  const [{ machineById }, { thisWalnutId }, { WALNUT_HOME }] = await Promise.all([
    import('../../core/leader/switch/settings.js'), import('../../core/leader/switch/witness-transport.js'), import('../../constants.js'),
  ])
  const self = machineById(settings, me)
  const target = machineById(settings, to)
  const walnutId = await thisWalnutId().catch(() => null)
  if (!self || !target || !walnutId) return null
  return { home: WALNUT_HOME, walnutId, machineId: me, self, target, commitWindowMs: settings.commitWindowMs, switchId, log: (level, msg, data) => log.web[level](msg, data) }
}

/**
 * Takes this server's handover back (a cancel by hand, the stop wait, a target side that did not start):
 * never while its switch stop runs (final-stop.ts beginTakeBack), the console minted for it withdrawn.
 */
async function takeBackHandover(why: string, o: { begun?: import('../../core/leader/switch/final-stop.js').HandedOverSwitch } = {}): Promise<{ ok: boolean; why?: string }> {
  const p = currentLeaderPermit()
  const stop = await import('../../core/leader/switch/final-stop.js')
  if (!p || p.trial) { if (o.begun) stop.endTakeBack(o.begun, false); return { ok: false, why: 'this server does not hold the write permission' } }
  // The stop wait began its take-back already (synchronously, in its timer); everyone else begins it here.
  let begun = o.begun ? { ok: true as const, sw: o.begun } : stop.beginTakeBack()
  if (!begun.ok && stop.handedOverSwitch()?.phase === 'cancelling') {
    // A cancel by hand while the server's own take-back runs: wait for it (one take-back at a time), then answer its outcome.
    const id = stop.handedOverSwitch()!.switchId
    const until = Date.now() + 60_000
    while (stop.handedOverSwitch()?.phase === 'cancelling' && Date.now() < until) await new Promise((r) => setTimeout(r, 200))
    if (stop.wasTakenBack(id)) return { ok: true }
    begun = stop.beginTakeBack()
  }
  if (!begun.ok) return { ok: false, why: begun.why }
  log.web.warn(`leader switch: this server takes its handover back (${why})`, { switchId: begun.sw?.switchId ?? null })
  const r = await p.runtime.cancel().catch((err: unknown) => ({ ok: false, why: err instanceof Error ? err.message : String(err) }))
  // Not taken back: the switch waits for its stop again, and the take-back is tried again in 5 s, unless it never can
  // stand (the new leader committed, or this process holds no handover any more): then nothing waits.
  const state = p.runtime.status().state
  if (!r.ok && (/committed before the cancel/.test(r.why ?? '') || (state !== 'handed-over' && state !== 'lost'))) stop.dropHandedOver(begun.sw)
  else stop.endTakeBack(begun.sw, r.ok)
  if (r.ok) {
    const { WALNUT_HOME } = await import('../../constants.js')
    await withdrawConsoleQuietly(p.machine, WALNUT_HOME)
    // The host steps of that handover, taken back while this server runs on (none ran: nothing to take back).
    const { undoHostSteps } = await import('../../core/leader/switch/handover-host-steps.js')
    const walnutId = await (await import('../../core/leader/switch/witness-transport.js')).thisWalnutId().catch(() => null)
    if (begun.sw && walnutId) await undoHostSteps({ home: WALNUT_HOME, walnutId, machineId: p.machine, log: (level, msg, data) => log.web[level](msg, data) })
  } else log.web.warn('leader switch: the handover could not be taken back yet', { switchId: begun.sw?.switchId ?? null, why: r.why })
  return r
}

/** The test knobs of a switch call (where a job or this server dies, the ledger control, a pause in the final batch): only in a rehearsal's server. */
function testKnobs(raw: unknown): { killAt?: string; skipLedgerRewrite?: true; pauseAfterFirstBatchMs?: number } | undefined {
  if (process.env.WALNUT_LEADER_SWITCH_TEST_KNOBS !== '1' || !raw || typeof raw !== 'object') return undefined
  const t = raw as { killAt?: unknown; skipLedgerRewrite?: unknown; pauseAfterFirstBatchMs?: unknown }
  const out = {
    ...(typeof t.killAt === 'string' ? { killAt: t.killAt } : {}),
    ...(t.skipLedgerRewrite === true ? { skipLedgerRewrite: true as const } : {}),
    ...(typeof t.pauseAfterFirstBatchMs === 'number' ? { pauseAfterFirstBatchMs: Math.min(60_000, Math.max(0, t.pauseAfterFirstBatchMs)) } : {}),
  }
  return Object.keys(out).length ? out : undefined
}

/** After the handover stood: the ticket and the target job over the copy link, and the wait for the switch stop. */
async function startTargetSide(o: { switchId: string; to: string; record: number; link: { peer: import('../../core/leader/switch/peer.js').SwitchPeer; settings: import('../../core/leader/switch/settings.js').LeaderSwitchSettings }; home: string; machine: string; test?: unknown }): Promise<{ ok: true; commitDeadline: string } | { ok: false; why: string }> {
  const [{ noteHandedOver, handedOverSwitch, forgetHandedOver }, { ticketName }, { machineById }, { getVersion }] = await Promise.all([
    import('../../core/leader/switch/final-stop.js'), import('../../core/leader/switch/ticket.js'), import('../../core/leader/switch/settings.js'), import('../../core/version.js'),
  ])
  const { peer, settings } = o.link
  const self = machineById(settings, o.machine)
  const target = machineById(settings, o.to)!
  if (!self) return { ok: false, why: `this machine (${o.machine}) is not in leader_switch.machines` }
  // A resumed source job asks again: the same switch keeps its deadline.
  const had = handedOverSwitch()
  const deadline = had && had.switchId === o.switchId ? had.commitDeadline : Date.now() + settings.commitWindowMs
  // From here the stop wait runs: whatever fails below, the take-back of this handover is retried until it stands.
  // An ordinary stop of this server ends that wait first (no take-back runs through its teardown).
  ;(await import('../server.js')).onPlainStop(() => forgetHandedOver())
  noteHandedOver({
    switchId: o.switchId, to: o.to, peer, commitDeadline: deadline, stopWaitMs: settings.stopWaitMs,
    // No stop within the wait: take the handover back; when the witnesses do not answer, try again every 5 s
    // (a stop that comes between two tries is taken: the handover still stands).
    onStopWaitOver: (sw) => { void takeBackHandover(`no switch stop came within ${Math.round(settings.stopWaitMs / 1000)} s`, { begun: sw }) },
  })
  const onHosts = await homeOnHostsNow().catch(() => null)
  const knobs = testKnobs(o.test)
  const test = knobs ? { ...(knobs.killAt ? { killAt: knobs.killAt } : {}), ...(knobs.skipLedgerRewrite ? { skipLedgerRewrite: true } : {}) } : undefined
  const ticket = {
    v: 1, switchId: o.switchId, from: o.machine, to: o.to, handover: o.record,
    sourceHome: o.home, targetHome: target.home, reverseStandbyDir: self.standbyDir,
    ...(self.accountHome ? { sourceAccountHome: self.accountHome } : {}), ...(target.accountHome ? { targetAccountHome: target.accountHome } : {}),
    sourceVersion: process.env.WALNUT_LEADER_SWITCH_FAKE_VERSION || getVersion(),
    ...(onHosts?.home ? { sourceHomeOnHosts: { home: onHosts.home, formerHomes: onHosts.formerHomes ?? [] } } : {}),
    commitDeadline: new Date(deadline).toISOString(), issuedAt: new Date().toISOString(),
    ...(test && Object.keys(test).length ? { test } : {}),
  }
  try {
    await peer.writeFile(ticketName(o.switchId), ticket)
  } catch (err) {
    return { ok: false, why: `the ticket could not be written on ${o.to}: ${err instanceof Error ? err.message : String(err)}` }
  }
  const job = await peer.startTargetJob(o.switchId, { check: false }).catch((err: unknown) => ({ ok: false, why: err instanceof Error ? err.message : String(err) }))
  if (!job.ok) return { ok: false, why: `the switch job on ${o.to} did not start: ${job.why ?? 'no reason'}` }
  return { ok: true, commitDeadline: ticket.commitDeadline }
}

/**
 * The switch stop (core/leader/switch/final-stop.ts): answered 202, then this server stops as planned, sends its
 * final batch over the copy link until one finds nothing changed, writes the final mark, and exits.
 */
leaderSwitchRouter.post('/switch/final-stop', thisMachineOnly, async (req, res) => {
  const p = currentLeaderPermit()
  const switchId = typeof req.body?.switchId === 'string' ? req.body.switchId : ''
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  if (p.runtime.status().state !== 'handed-over') { res.status(409).json({ ok: false, why: `this server has not handed over (${p.runtime.status().state})` }); return }
  const [{ beginSwitchStop, abandonSwitchStop, finishSwitchStop }, server, { WALNUT_HOME }] = await Promise.all([
    import('../../core/leader/switch/final-stop.js'), import('../server.js'), import('../../constants.js'),
  ])
  // The switch's own state first: a resumed job asking again is told it is in its stop already.
  const begun = beginSwitchStop(switchId)
  if (!begun.ok) { res.status(409).json({ ok: false, why: begun.why }); return }
  if (!server.switchStopAvailable()) {
    abandonSwitchStop(begun.sw)
    res.status(409).json({ ok: false, why: 'this server cannot stop itself for a switch (it was not started by `walnut web`, or it is stopping already)' })
    return
  }
  const knobs = testKnobs(req.body?.test)
  const test = knobs ? { ...(knobs.killAt ? { killAt: knobs.killAt } : {}), ...(knobs.pauseAfterFirstBatchMs ? { pauseAfterFirstBatchMs: knobs.pauseAfterFirstBatchMs } : {}) } : undefined
  const abort = new AbortController()
  const stoppedAt = new Date().toISOString()
  const sw = begun.sw
  log.web.info('leader switch: the switch stop begins (doors closed, then the final batch)', { switchId, to: sw.to })
  res.status(202).json({ ok: true, stoppedAt })
  // After the answer is on its way, whether or not the caller is still there to read it (a dropped
  // caller must not leave this server taken for a stop that never runs).
  setImmediate(() => {
    const taken = server.requestSwitchStop({
      windowMs: Math.max(0, sw.commitDeadline - Date.now()),
      abort: (why) => abort.abort(why),
      run: async () => {
        const r = await finishSwitchStop({ home: WALNUT_HOME, sw, stoppedAt, signal: abort.signal, ...(test ? { test } : {}), log: (level, msg, data) => log.web[level](msg, data) })
        // The last command to the other machine is behind it: every host link closes with this process.
        try { (await import('../../providers/daemon-connection.js')).disconnectAllDaemons() } catch { /* none open */ }
        return r.ok
      },
    })
    if (!taken) {
      log.web.warn('leader switch: the switch stop could not start in this process; it waits for its stop again', { switchId })
      abandonSwitchStop(sw)
    }
  })
})

/** The target job's state on the new leader's machine, read over the copy link while this server runs. */
leaderSwitchRouter.get('/switch/target', thisMachineOnly, async (req, res) => {
  const switchId = typeof req.query.switchId === 'string' ? req.query.switchId : ''
  const [{ handedOverSwitch }, { targetStateName }] = await Promise.all([import('../../core/leader/switch/final-stop.js'), import('../../core/leader/switch/ticket.js')])
  const sw = handedOverSwitch()
  if (!sw || sw.switchId !== switchId) { res.status(404).json({ ok: false, why: `this server handed over no switch ${switchId}` }); return }
  res.json({ ok: true, state: await sw.peer.readFile(targetStateName(switchId)).catch(() => null) })
})

/** The candidate's check: the target job in check mode on the new leader's machine, started over the copy link; its report. */
leaderSwitchRouter.post('/switch/check', thisMachineOnly, async (req, res) => {
  const to = typeof req.body?.to === 'string' ? req.body.to : ''
  const [{ isSwitchId, checkReportName, removeSwitchFile }] = await Promise.all([import('../../core/leader/switch/ticket.js')])
  const switchId: unknown = req.body?.switchId
  if (!isSwitchId(switchId)) { res.status(400).json({ ok: false, why: 'not a switch id' }); return }
  const p = currentLeaderPermit()
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  const link = await switchLink(to, p.machine)
  if ('refused' in link) { res.status(409).json({ ok: false, why: link.refused }); return }
  if (link.peer.kind === 'local') removeSwitchFile(link.peer.standbyDir, checkReportName(switchId))
  const job = await link.peer.startTargetJob(switchId, { check: true })
  if (!job.ok) { res.status(409).json({ ok: false, why: `the check did not start on ${to}: ${job.why}` }); return }
  try {
    const until = Date.now() + 90_000
    while (Date.now() < until) {
      const report = await link.peer.readFile(checkReportName(switchId)).catch(() => null)
      if (report) { res.json({ ok: true, report }); return }
      await new Promise((r) => setTimeout(r, 300))
    }
    res.status(504).json({ ok: false, why: `the check on ${to} did not report within 90 s` })
  } finally {
    link.peer.close()
  }
})

/**
 * A switch's begin: the trust rule (core/leader/switch/final-stop.ts beginRefusal), and the record of who began it
 * on which machine, in this server's log (its console) and in Walnut Health. From this machine only today; a begin
 * forwarded by the new leader's replica (the next step) is taken only from that machine itself.
 */
leaderSwitchRouter.post('/switch/begin', thisMachineOnly, async (req, res) => {
  const p = currentLeaderPermit()
  const to = typeof req.body?.to === 'string' ? req.body.to : ''
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  const [{ beganLine }, { isSwitchId }] = await Promise.all([import('../../core/leader/switch/final-stop.js'), import('../../core/leader/switch/ticket.js')])
  const switchId: unknown = req.body?.switchId
  if (!isSwitchId(switchId)) { res.status(400).json({ ok: false, why: 'not a switch id' }); return }
  const link = await switchLink(to, p.machine)
  if ('refused' in link) { res.status(403).json({ ok: false, why: link.refused }); return }
  link.peer.close()
  const startedBy = { machine: p.machine, via: 'cli' as const }
  const line = beganLine({ switchId, from: p.machine, to, by: startedBy })
  log.web.info(`leader switch: ${line.title}`, { switchId, from: p.machine, to, startedBy })
  const { raiseHealthItem } = await import('../../core/notifications/health-items.js')
  void raiseHealthItem({ kind: 'operation-error', severity: 'info', title: line.title, body: line.body, dedupKey: `leader-switch-began:${switchId}`, category: 'Leader switch' }, 'leader-switch')
  res.json({ ok: true, startedBy })
})

leaderSwitchRouter.post('/cancel', thisMachineOnly, async (_req, res) => {
  // A switch stop under way is past taking back: its final batch decides (a cancel would race its mark).
  const r = await takeBackHandover('cancelled by hand')
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
