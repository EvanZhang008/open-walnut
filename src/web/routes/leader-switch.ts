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
 *   POST /switch/catch-up    the standby caught up while this leader serves (core/leader/switch/catch-up.ts),
 *                            the preflight's last step: refused, the final batch would not fit in the commit window
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
import { withDeadline } from '../../lib/with-deadline.js'

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
/**
 * The handover's answer comes within this (the source job waits 150 s for it, source-job.ts): the steps before the
 * record start it only with AFTER_RECORD_MS left, the retell's wait fits in what is left, and a target side that does
 * not start within the rest is taken back.
 */
const HANDOVER_DEADLINE_MS = 140_000
/** What the steps after the record need at least: a short retell and the target side's ticket and job start. */
const AFTER_RECORD_MS = 45_000
/** Kept for the target side after the retell's wait. */
const TARGET_SIDE_MS = 30_000

leaderSwitchRouter.post('/handover', thisMachineOnly, async (req, res) => {
  const deadline = Date.now() + HANDOVER_DEADLINE_MS
  const left = () => deadline - Date.now()
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
    const linking = switchLink(to, p.machine)
    link = await withDeadline(linking, Math.max(1, left() - AFTER_RECORD_MS), () => ({ refused: `the copy link to ${to} did not answer within the handover's deadline` }))
    if ('refused' in link) {
      // A link that came after the deadline is closed when it comes.
      void linking.then((l) => { if (!('refused' in l) && l !== link) l.peer.close() }, () => {})
      res.status(409).json({ ok: false, why: link.refused })
      return
    }
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
  // Too late for what comes after the record: no record, the steps before it taken back.
  if (link && !('refused' in link) && left() < AFTER_RECORD_MS) {
    await withdrawConsoleQuietly(p.machine, WALNUT_HOME)
    if (hostSteps) await (await import('../../core/leader/switch/handover-host-steps.js')).undoHostSteps(hostSteps)
    link.peer.close()
    res.status(504).json({ ok: false, why: `the steps before the handover record took past its deadline (${HANDOVER_DEADLINE_MS / 1000} s): nothing was handed over` })
    return
  }
  const r = await p.runtime.handover(to)
  // Not handed over: the console minted for it will never stand, nor the host steps.
  if (!r.ok) await withdrawConsoleQuietly(p.machine, WALNUT_HOME)
  if (!r.ok && hostSteps) await (await import('../../core/leader/switch/handover-host-steps.js')).undoHostSteps(hostSteps)
  if (r.ok && hostSteps && link && !('refused' in link) && typeof switchId === 'string') {
    // The switch is noted before the wait below: a take-back of it then retries until it stands, marks the switch taken
    // back, and takes the host steps back (takeBackHandover), whichever way it comes (this wait, the stop wait, a cancel).
    const hs = await import('../../core/leader/switch/handover-host-steps.js')
    // The retell's wait fits in the deadline (the target side keeps its share); the stop wait starts after it.
    hostSteps.retellWaitMs = Math.max(5_000, Math.min(hs.retellWaitMs(hostSteps), left() - TARGET_SIDE_MS))
    await noteSwitchHandover({ switchId, to, link, extraWaitMs: hs.retellWaitMs(hostSteps) })
    const { handedOverSwitch } = await import('../../core/leader/switch/final-stop.js')
    // Still this route's handover: not taken back meanwhile (the stop wait, a cancel by hand), nor in a stop.
    const stillOurs = () => { const sw = handedOverSwitch(); return !!sw && sw.switchId === switchId && sw.phase === 'waiting' }
    // Nothing stops while a net host would still let in only this leader: not all told within the wait, the handover is
    // taken back. A take-back that lands meanwhile keeps this machine's daemon duties (no drop after it; its undo waits).
    const after = await hs.afterHandoverRecord(hostSteps, { stillOurs })
    if (!stillOurs()) {
      res.status(409).json({ ok: false, why: 'the handover was taken back while the hosts were told (its stop wait ran out, or a cancel)' })
      return
    }
    if (!after.ok) {
      const c = await takeBackHandover('the network\'s hosts did not all take the new leader')
      res.status(409).json({ ok: false, why: `${c.ok ? 'the handover is taken back' : `the handover could not be taken back yet, it is tried again every 5 s (${c.why})`}: ${after.why}` })
      return
    }
  }
  if (!r.ok && link && !('refused' in link)) link.peer.close()
  if (!r.ok || !link || 'refused' in link || typeof switchId !== 'string') {
    res.status(r.ok ? 200 : 409).json({ ok: r.ok, ...(r.record ? { record: r.record.number } : {}), ...(r.why ? { why: r.why } : {}) })
    return
  }
  const started = await withDeadline(
    startTargetSide({ switchId, to, record: r.record!.number, link, home: WALNUT_HOME, machine: p.machine, test: req.body?.test }),
    Math.max(1, left()), () => ({ ok: false as const, why: `the ticket and the target job did not start on ${to} within the handover's deadline` }),
  )
  if (!started.ok) {
    // The new leader's machine has no ticket or no job: take the handover back, lead on.
    const c = await takeBackHandover('the switch job did not start on the new leader\'s machine')
    res.status(409).json({ ok: false, why: `${c.ok ? 'the handover is taken back' : `the handover could not be taken back yet (${c.why})`}: ${started.why}` })
    return
  }
  res.json({ ok: true, record: r.record!.number, commitDeadline: started.commitDeadline })
})

/** The copy link to `to` and the trust rule of every switch call (core/leader/switch/switch-link.ts). */
async function switchLink(to: string, me: string): Promise<import('../../core/leader/switch/switch-link.js').SwitchLink> {
  return (await import('../../core/leader/switch/switch-link.js')).switchLink(to, me)
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

/**
 * The handover of `switchId` stood: from here the stop wait runs, and whatever fails after it, the take-back of this
 * handover is retried until it stands (final-stop.ts). Its commit deadline: a resumed source job asking again keeps
 * the first one. An ordinary stop of this server ends that wait first (no take-back runs through its teardown).
 */
async function noteSwitchHandover(o: { switchId: string; to: string; link: { peer: import('../../core/leader/switch/peer.js').SwitchPeer; settings: import('../../core/leader/switch/settings.js').LeaderSwitchSettings }; extraWaitMs?: number }): Promise<number> {
  const { noteHandedOver, handedOverSwitch, forgetHandedOver } = await import('../../core/leader/switch/final-stop.js')
  const { settings } = o.link
  const had = handedOverSwitch()
  if (had && had.switchId === o.switchId) return had.commitDeadline
  ;(await import('../server.js')).onPlainStop(() => forgetHandedOver())
  return noteHandedOver({
    // The stop wait counts from the end of the retell's wait (noted before it, so a take-back in it works the same).
    switchId: o.switchId, to: o.to, peer: o.link.peer, commitDeadline: Date.now() + settings.commitWindowMs, stopWaitMs: settings.stopWaitMs + (o.extraWaitMs ?? 0),
    // No stop within the wait: take the handover back; when the witnesses do not answer, try again every 5 s
    // (a stop that comes between two tries is taken: the handover still stands).
    onStopWaitOver: (sw) => { void takeBackHandover(`no switch stop came within ${Math.round((settings.stopWaitMs + (o.extraWaitMs ?? 0)) / 1000)} s`, { begun: sw }) },
  }).commitDeadline
}

/** After the handover stood: the ticket and the target job over the copy link, and the wait for the switch stop. */
async function startTargetSide(o: { switchId: string; to: string; record: number; link: { peer: import('../../core/leader/switch/peer.js').SwitchPeer; settings: import('../../core/leader/switch/settings.js').LeaderSwitchSettings }; home: string; machine: string; test?: unknown }): Promise<{ ok: true; commitDeadline: string } | { ok: false; why: string }> {
  const [{ ticketName }, { machineById }, { getVersion }] = await Promise.all([
    import('../../core/leader/switch/ticket.js'), import('../../core/leader/switch/settings.js'), import('../../core/version.js'),
  ])
  const { peer, settings } = o.link
  const self = machineById(settings, o.machine)
  const target = machineById(settings, o.to)!
  if (!self) return { ok: false, why: `this machine (${o.machine}) is not in leader_switch.machines` }
  const deadline = await noteSwitchHandover({ switchId: o.switchId, to: o.to, link: o.link })
  const onHosts = await homeOnHostsNow().catch(() => null)
  const knobs = testKnobs(o.test)
  const test = knobs ? { ...(knobs.killAt ? { killAt: knobs.killAt } : {}), ...(knobs.skipLedgerRewrite ? { skipLedgerRewrite: true } : {}) } : undefined
  const ticket = {
    v: 1, switchId: o.switchId, from: o.machine, to: o.to, handover: o.record,
    sourceHome: o.home, targetHome: target.home, reverseStandbyDir: self.standbyDir,
    // Over a daemon the new leader sends its copy back the same way: to this machine, by the name its config gives it.
    // Its sessions there name this machine by that key, and the new machine's name none (session-hosts.ts): the new
    // machine by its hosts key, or the name this leader's standby gives it (beginRefusal allows its machine id there).
    ...(peer.kind === 'daemon' && self.hostKey ? { reverseStandbyHost: self.hostKey, ...((target.hostKey ?? peer.host) ? { targetHostKey: target.hostKey ?? peer.host } : {}) } : {}),
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
  // The last look (catch-up.ts lastLook): what came since the catch-up must stand in one batch within its budget,
  // else the final batch would not fit the commit window. Refused here, nothing stopped: the source job takes the
  // handover back and this server leads again at once.
  const [{ readHomeSwitchConfig }, { lastLook }, { standbyRunner }] = await Promise.all([
    import('../../core/leader/switch/settings.js'), import('../../core/leader/switch/catch-up.js'), import('../../core/standby/runner.js'),
  ])
  const window = readHomeSwitchConfig(WALNUT_HOME).settings?.commitWindowMs ?? Math.max(0, begun.sw.commitDeadline - Date.now())
  const runner = standbyRunner()
  const look = await lastLook({ runOnce: () => (runner ? runner.runOnce() : Promise.resolve(null)), commitWindowMs: window })
  log.web[look.ok ? 'info' : 'warn'](`leader switch: the last look before the stop ${look.ok ? 'found the standby caught up' : 'found the standby behind; the stop is refused'}`, { switchId, ms: look.ms, budgetMs: look.budgetMs, batches: look.batches, ...(look.ok ? {} : { why: look.why }) })
  if (!look.ok) {
    abandonSwitchStop(begun.sw)
    res.status(409).json({ ok: false, why: `the standby fell behind after its catch-up, so the final batch would not fit in the commit window (nothing stopped; the handover is taken back): ${look.why}` })
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
  setImmediate(async () => {
    // The copy link outlives the stop's teardown of every host link (a stopping server dials nothing): the final
    // batch and the mark go over it last, none of it past the commit deadline. Held before the stop starts, within
    // 10 s; without it the stop would find no link for its final batch, so this server does not stop: the switch
    // waits for its stop again (the source job asks again, or the stop wait takes the handover back).
    const notHeld = await withDeadline(
      sw.peer.hold({ until: sw.commitDeadline }).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err))),
      10_000, () => 'no link within 10 s',
    )
    if (notHeld) {
      sw.peer.unhold()
      log.web.warn('leader switch: the copy link could not be held for the stop; this server does not stop, the switch waits for its stop again', { switchId, why: notHeld })
      abandonSwitchStop(sw)
      return
    }
    const taken = server.requestSwitchStop({
      windowMs: Math.max(0, sw.commitDeadline - Date.now()),
      abort: (why) => abort.abort(why),
      run: async (writers) => {
        const r = await finishSwitchStop({ home: WALNUT_HOME, sw, stoppedAt, signal: abort.signal, writers, ...(test ? { test } : {}), log: (level, msg, data) => log.web[level](msg, data) })
        // The last command to the other machine is behind it: every host link closes with this process.
        try { (await import('../../providers/daemon-connection.js')).disconnectAllDaemons() } catch { /* none open */ }
        return r.ok
      },
    })
    if (!taken) {
      log.web.warn('leader switch: the switch stop could not start in this process; it waits for its stop again', { switchId })
      sw.peer.unhold()
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
  // Within its deadline (the source job asks every 300 ms within its own 30 s): a link that does not answer is said so.
  try {
    const state = await withDeadline(sw.peer.readFile(targetStateName(switchId)), TARGET_READ_MS, () => { throw new Error(`the copy link did not answer within ${TARGET_READ_MS / 1000} s`) })
    res.json({ ok: true, state })
  } catch (err) {
    res.status(502).json({ ok: false, why: `the target job's state on ${sw.to} could not be read: ${err instanceof Error ? err.message : String(err)}` })
  }
})

/** How long GET /switch/target waits for the copy link; how long /switch/check takes in all (its link, the clear, the verify, the job, its report). */
const TARGET_READ_MS = 10_000
const CHECK_DEADLINE_MS = 150_000
/** Kept for the check job and its report after the verify (a verify waits for an apply under way only until then). */
const CHECK_AFTER_VERIFY_MS = 60_000

/** The candidate's check: the target job in check mode on the new leader's machine, started over the copy link; its report. */
leaderSwitchRouter.post('/switch/check', thisMachineOnly, async (req, res) => {
  const to = typeof req.body?.to === 'string' ? req.body.to : ''
  const [{ isSwitchId, checkReportName }] = await Promise.all([import('../../core/leader/switch/ticket.js')])
  const switchId: unknown = req.body?.switchId
  if (!isSwitchId(switchId)) { res.status(400).json({ ok: false, why: 'not a switch id' }); return }
  const p = currentLeaderPermit()
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  // One deadline for all of it (a link that drops would otherwise hold each step for its own wait); the peer is
  // closed however it ends.
  const until = Date.now() + CHECK_DEADLINE_MS
  const left = () => Math.max(0, until - Date.now())
  const late = (what: string) => (): never => { throw new Error(`${what} did not finish within the check's ${CHECK_DEADLINE_MS / 1000} s`) }
  let peer: import('../../core/leader/switch/peer.js').SwitchPeer | null = null
  const linking = switchLink(to, p.machine)
  try {
    const link = await withDeadline(linking, left(), late('the copy link'))
    if ('refused' in link) { res.status(409).json({ ok: false, why: link.refused }); return }
    peer = link.peer
    // An earlier report of this switch is cleared first (on every kind: a null report is none). Not cleared, an
    // old report could be read as this check's: the check does not run.
    const cleared = await withDeadline(link.peer.writeFile(checkReportName(switchId), null).then(() => null, (err: unknown) => (err instanceof Error ? err.message : String(err))), left(), late('clearing the last report'))
    if (cleared) { res.status(409).json({ ok: false, why: `the last check report on ${to} could not be cleared: ${cleared}` }); return }
    // The copy there, verified before the candidate reads it (repaired from its chunks where it drifted). This leader's
    // own periodic batch may be applying there: waited out (the target refuses a verify meanwhile), within the deadline.
    const { whenStandbyIdle } = await import('../../core/leader/switch/catch-up.js')
    const verifyBy = Date.now() + Math.max(0, left() - CHECK_AFTER_VERIFY_MS)
    const verified = await withDeadline(whenStandbyIdle(() => link.peer.verify(), { untilMs: verifyBy }).catch((err: unknown) => ({ error: err instanceof Error ? err.message : String(err) })), left(), late('the verify'))
    const job = await withDeadline(link.peer.startTargetJob(switchId, { check: true }), left(), late('starting the check'))
    if (!job.ok) { res.status(409).json({ ok: false, why: `the check did not start on ${to}: ${job.why}` }); return }
    const reportMs = Math.min(90_000, left())
    const reportBy = Date.now() + reportMs
    while (Date.now() < reportBy) {
      const report = await withDeadline(link.peer.readFile(checkReportName(switchId)).catch(() => null), Math.max(1, reportBy - Date.now()), () => null)
      if (report) { res.json({ ok: true, report, verify: verified }); return }
      await new Promise((r) => setTimeout(r, 300))
    }
    res.status(504).json({ ok: false, why: `the check on ${to} did not report within ${Math.round(reportMs / 1000)} s` })
  } catch (err) {
    res.status(504).json({ ok: false, why: err instanceof Error ? err.message : String(err) })
    // A link that came after the deadline is closed when it comes.
    if (!peer) void linking.then((l) => { if (!('refused' in l)) l.peer.close() }, () => {})
  } finally {
    peer?.close()
  }
})

/**
 * The standby caught up while this leader still serves (core/leader/switch/catch-up.ts): its own standby batches,
 * back to back, until one takes at most a quarter of the commit window. Refused (409, why): the final batch would not
 * fit in the commit window, and nothing was handed over. Within one commit window (the source job waits a minute more).
 */
leaderSwitchRouter.post('/switch/catch-up', thisMachineOnly, async (req, res) => {
  const p = currentLeaderPermit()
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  const [{ isSwitchId }, { readHomeSwitchConfig }, { catchUpStandby }, { standbyRunner }, { WALNUT_HOME }] = await Promise.all([
    import('../../core/leader/switch/ticket.js'), import('../../core/leader/switch/settings.js'), import('../../core/leader/switch/catch-up.js'),
    import('../../core/standby/runner.js'), import('../../constants.js'),
  ])
  const switchId: unknown = req.body?.switchId
  if (!isSwitchId(switchId)) { res.status(400).json({ ok: false, why: 'not a switch id' }); return }
  const cfg = readHomeSwitchConfig(WALNUT_HOME)
  if (!cfg.settings) { res.status(409).json({ ok: false, why: cfg.problem ?? 'no leader_switch section' }); return }
  // A history rewrite or gc of the data repo runs for minutes: the switch stop would end it part way. Try again after it.
  const gitSync = await import('../../integrations/git-sync.js')
  if (gitSync.compactionInProgress) { res.status(409).json({ ok: false, why: 'a history rewrite or gc of the data repo runs now (minutes): switch once it ended' }); return }
  const runner = standbyRunner()
  const r = await catchUpStandby({ runOnce: () => (runner ? runner.runOnce() : Promise.resolve(null)), commitWindowMs: cfg.settings.commitWindowMs })
  log.web.info(`leader switch: the standby ${r.ok ? 'caught up' : 'did not catch up'}`, { switchId, ms: r.ms, budgetMs: r.budgetMs, batches: r.batches, ...(r.ok ? {} : { why: r.why }) })
  res.status(r.ok ? 200 : 409).json(r)
})

/**
 * A switch's begin: the trust rule (core/leader/switch/final-stop.ts beginRefusal), and the record of who began it
 * on which machine, in this server's log (its console) and in Walnut Health. From this machine only; a begin made on
 * the new leader's machine comes over its host link to the relay door (core/leader/switch/leader-relay-door.ts),
 * taken only from that machine itself, and this is then its source job asking again.
 */
leaderSwitchRouter.post('/switch/begin', thisMachineOnly, async (req, res) => {
  const p = currentLeaderPermit()
  const to = typeof req.body?.to === 'string' ? req.body.to : ''
  if (!p || p.trial) { res.status(409).json({ ok: false, why: 'this server does not hold the write permission' }); return }
  const [{ recordBegin, forwardedBeginOf }, { isSwitchId }, { WALNUT_HOME }] = await Promise.all([import('../../core/leader/switch/leader-relay-door.js'), import('../../core/leader/switch/ticket.js'), import('../../constants.js')])
  const switchId: unknown = req.body?.switchId
  if (!isSwitchId(switchId)) { res.status(400).json({ ok: false, why: 'not a switch id' }); return }
  // The source job of a begin forwarded by `to` (leader-relay-door.ts): that begin was checked and recorded already
  // over its host link; this is its job's preflight asking again, with the same switch id and machine.
  // In memory, else as the relay door kept it on disk (a restart of this server since): only the link's word counts.
  const fwd = forwardedBeginOf(switchId, WALNUT_HOME)
  if (fwd && fwd.to !== to) { res.status(409).json({ ok: false, why: `switch ${switchId} was begun for ${fwd.to}` }); return }
  const link = await switchLink(to, p.machine)
  if ('refused' in link) { res.status(403).json({ ok: false, why: link.refused }); return }
  link.peer.close()
  if (fwd) { res.json({ ok: true, startedBy: fwd.by }); return }
  const startedBy = { machine: p.machine, via: 'cli' as const }
  await recordBegin({ switchId, from: p.machine, to, by: startedBy })
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
