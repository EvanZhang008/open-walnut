/**
 * The leader's boot wiring of the hosts that run and judge their sessions (leader-side.ts): real
 * data, the host-server manager's views and links, this server's bus. Started by the web server on
 * every leader: it links only to hosts that name session-judge-v1, and with the switch off for a
 * host every new start there is 'here', run by the leader (judge-of.ts), while the sessions it already runs keep
 * reporting. The start decision is per host (switch.ts hostRunsSessionsFor).
 *
 * With the switch on for any host it also serves the door hosts dial into (host-door.ts, `/host-door`) and
 * issues each host that names host-door-v1 its door credential (leader-issue.ts); off, the door is
 * shut and nothing is issued.
 */
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../event-bus.js'
import { createLeaderSide, reportHostChecks, reportJudges, reportReadsHistory, reportResumes, reportResumesAcp, reportTakesCompleteStop, reportTakesTaskRows, type LeaderSide } from './leader-side.js'
import { noteHostTakesTaskRows } from './start-task-rows.js'
import { noteHostReadsHistory, setHostHistoryCaller } from '../sessions/host-history-reads.js'
import { noteHostSessionSide } from './host-side-health.js'
import { hostRunsSessionsAnyNow, hostSwitchNow } from './switch.js'
import { reemitDestinations } from './event-classes.js'
import { forgetHostJudged, judgingHostOf, noteHostJudged, seedHostJudgedRuntimes, setHostJudgeProbe } from '../sessions/judge-of.js'
import { noteHostTakesChecks } from '../sessions/session-command-gate.js'
import { leaderDropHosts, leaderDropsOf } from './leader-drops.js'
import { forgetHostResumes, noteHostResumes, noteSwitchAnyHost, setHostSwitchProbe } from './resume-hosts.js'
import { NOT_OWN_SESSION } from './host-api.js'
import type { PermitPair } from './channel.js'
import { leaderPermitNumberForHosts, runningLeaderPermit } from './leader-permit.js'
import { HELD_SAY_AGAIN_MS } from './stand-down-held.js'

/** How often the ban is read again from the credential records (another process may write it). */
const REVOKED_RECHECK_MS = 60_000

let active: LeaderSide | null = null
let standing: ((hostKey: string) => LeaderStanding) | null = null
let pushDoors: ((doors: readonly string[]) => Promise<HostDoorsPush>) | null = null

/**
 * This leader's standing toward a host (channel.ts PermitPair) and who holds the write permission:
 * the permit's record number (leader-permit.ts, the one read of it) and holder (B1,
 * src/core/leader/switch/), 0 and this machine's id while the permit system is off, and the
 * leader's claim epoch on that host (primary-leader.ts).
 */
export interface LeaderStanding { pair: PermitPair; holder: string }

/** The running leader side's standing toward `hostKey`, or null when the leader side is not on. */
export function leaderStandingOf(hostKey: string): LeaderStanding | null {
  return standing?.(hostKey) ?? null
}

/** What a doors push reached: hosts told over their dialed socket, over their daemon link, and the ones that did not take it. */
export interface HostDoorsPush { dialed: string[]; routed: string[]; failed: string[] }

/**
 * Tell every linked host the door list `doors` now (the leader switch, before it hands over): a
 * `doors` frame on each host-dialed socket, `POST /host-api/doors` over the daemon link of every
 * other host that names the door capability. Each host keeps it only from a standing not below
 * what it holds. Nothing while the leader side is not on.
 */
export async function pushHostDoors(doors: readonly string[]): Promise<HostDoorsPush> {
  return pushDoors ? pushDoors(doors) : { dialed: [], routed: [], failed: [] }
}
const CONFIG_SUBSCRIBER = 'host-session-switch'
const DELETE_SUBSCRIBER = 'host-session-deletes'

/** The running leader side, or null (a follower, not started yet). */
export function activeLeaderSide(): LeaderSide | null {
  return active
}

export { hostResumesSessions, _setHostResumesForTesting } from './resume-hosts.js'

/** Tests: stand a fake leader side in (null removes it). */
export function _setActiveLeaderSideForTesting(side: LeaderSide | null): void {
  active = side
  if (!side) forgetHostResumes()
}

/**
 * Say one host fact (or flow event) on this leader's bus, as the channel applies it: to the
 * destinations the host's emit named (never the phone's push), `source: 'host-channel'`, `late` for
 * one read back long after it happened, and its original time as the event's timestamp, so a
 * subscriber that records a time counts the fact where it happened (EmitOptions.timestamp).
 */
export function sayHostFact(name: string, data: unknown, opts: { late: boolean; to?: string[]; at?: number }): void {
  bus.emit(name, data, reemitDestinations(opts.to, bus.subscriberNames()), {
    source: 'host-channel',
    ...(opts.late ? { late: true as const } : {}),
    ...(typeof opts.at === 'number' && Number.isFinite(opts.at) ? { timestamp: opts.at } : {}),
  })
}

export async function startLeaderSessionChannels(): Promise<() => void> {
  if (active) return () => {}
  const [{ applyHostChannelBatch, loadChannelCursor }, hostServer, { hostLeaderStates }, { getInstanceId }, remote, { saidHereAlready, hostStartsInFlight, noteHostStartBorn, attemptStartedOn }, { permitHolderId }, { cleanDoorUrls }, { sessionTaskAndEngineInStore }] = await Promise.all([
    import('../session-tracker.js'),
    import('../host-server/index.js'),
    import('../leader/primary-leader.js'),
    import('../device-auth.js'),
    import('../../providers/remote-judged-session.js'),
    import('../../providers/host-judged-runner.js'),
    import('../machine-id.js'),
    import('./door-wire.js'),
    import('../session-db.js'),
  ])
  const [{ linesNotOthers, noteLinesHanded }, { hostRevokedNow, anyHostRevoked }, { setQueuedRowLedger }, { hostRunsSessionsAnyNow }] = await Promise.all([
    import('./handed-sessions.js'), import('./revoked-hosts.js'), import('../session-message-queue.js'), import('./switch.js'),
  ])
  // Every queue row's session, while any host runs its sessions (only then can a host's fact name
  // one): a fact may name its own session's rows and none of another's (fact-keys.ts, scoped keys).
  let ledgerOn = false
  const readLedgerSwitch = async (): Promise<void> => { ledgerOn = await hostRunsSessionsAnyNow().catch(() => ledgerOn) }
  await readLedgerSwitch()
  setQueuedRowLedger((sid, id) => {
    if (!ledgerOn) return
    void noteLinesHanded(sid, [id]).catch((err: unknown) => log.session.warn('session channel: a queue row\'s session was not noted', { sessionId: sid, messageId: id, error: err instanceof Error ? err.message : String(err) }))
  })
  const ownMachine = permitHolderId() ?? ''
  const standingNow = (hostKey: string): LeaderStanding => {
    const permit = runningLeaderPermit()
    return {
      pair: { permitNumber: leaderPermitNumberForHosts(), epoch: hostLeaderStates()[hostKey]?.epoch ?? 0 },
      holder: permit?.runtime.status().record?.holder ?? permit?.machine ?? ownMachine,
    }
  }
  // M3: the turn ends a stop of this leader's left unsaid (committed, the phase not written), per
  // host, once its link applied what its log held (its rows current here): the marks made before this
  // start, and at every later catch-up the marks still standing long past the wait for a host to say
  // a stand-down's turn end again (turn-ends.ts catchUpReconciler).
  const catchUp = (await import('./turn-ends.js')).catchUpReconciler({ bootAt: Date.now(), staleMs: 2 * HELD_SAY_AGAIN_MS, log: (level, msg, data) => log.session[level](msg, data) })
  const reconcileTurnEnds = (hostId: string): void => {
    void catchUp(hostId).catch((err: unknown) => {
      log.session.warn('session channel: the reconcile of host turn ends failed', { host: hostId, error: err instanceof Error ? err.message : String(err) })
    })
  }
  const side = createLeaderSide({
    walnutId: async () => getInstanceId(),
    permit: (hostId) => standingNow(hostId).pair,
    // The start decision is per host (hosts.<name>.runs_sessions, else the experiment).
    switchNow: hostSwitchNow,
    openStream: async (hostKey, purpose) => {
      const link = hostServer.hostServerLink(hostKey)
      if (!link) throw new Error(`the host ${hostKey} is not connected`)
      return link.openStream('follower', purpose)
    },
    applyBatch: applyHostChannelBatch,
    leaderDrops: async (hostId) => leaderDropsOf(hostId),
    loadCursor: async (hostId) => loadChannelCursor(hostId),
    emit: (name, data, opts) => {
      if (saidHereAlready(name, data)) return
      // The host's ledger, with the rows of the Walnut subagents this leader runs for the session.
      const sid = (data as { sessionId?: unknown } | null)?.sessionId
      const said = name === EventNames.SESSION_BACKGROUND_TASKS && typeof sid === 'string' && data && typeof data === 'object'
        ? remote.withLeaderSubagentRows(data as Record<string, unknown>, sid) : data
      sayHostFact(name, said, opts)
    },
    noteLive: (sid, state, hostId) => remote.noteLiveState(sid, state, hostId),
    noteBorn: noteHostStartBorn,
    onLinkLost: (hostId) => {
      const n = remote.markHostLiveUnknown(hostId)
      log.session.warn('session channel: the link to a host stayed down; its sessions read unknown here until it links again', { host: hostId, sessions: n })
    },
    noteRename: (from, to) => {
      remote.renameRemoteJudgedSession(from, to)
      void import('./leader-tasks.js').then((m) => m.noteHostSessionRenamed(from, to))
    },
    noteHostJudged,
    ownerOf: judgingHostOf,
    startsInFlight: hostStartsInFlight,
    // Lines that did not reach a host (its link was down, an answer lost) go again when it links.
    onLinked: (host) => {
      // The clocks of hand-overs re-armed at boot count from this first link (host-handover.ts).
      void import('../../providers/host-handover.js').then((m) => m.noteHostLinked(host)).catch(() => {})
      void import('../../providers/host-judged-send.js').then((m) => m.redeliverWaitingFor(host)).catch((err: unknown) => {
        log.session.warn('host-run sessions: redelivering what waited for a host failed', { host, error: err instanceof Error ? err.message : String(err) })
      })
      // The stops of completed tasks that did not reach this host (sessions/host-judged-complete.ts).
      void import('../sessions/host-judged-complete.js').then((m) => m.retryCompletionStopsFor(host)).catch(() => {})
    },
    onCaughtUp: reconcileTurnEnds,
    refused: (hostId, sids) => { void import('./refused-sessions.js').then((m) => m.noteRefusedSessions(hostId, sids, 'record')) },
    // A host's fact says the task of this leader's own row of its session (leader-apply.ts).
    taskOf: (sid) => sessionTaskAndEngineInStore(sid)?.taskId,
    // The leader objects a host's fact may name: the queue rows and transfer attempts it handed that session.
    scopeIds: (hostId, sid, key, ids) => (key === 'attemptId' ? ids.filter((a) => attemptStartedOn(hostId, a)) : linesNotOthers(sid, ids)),
    // A revoked host's channel is cut (revoked-hosts.ts, read from the credential records by leader-issue.ts).
    revoked: hostRevokedNow,
    log: (level, msg, data) => log.session[level](msg, data),
  })
  active = side
  standing = standingNow
  // The door hosts dial into, and their credentials (host-door.ts, leader-issue.ts).
  const [{ startHostDoor, pushDoorsToDialed }, issue, { setLeaderDoorOpen }, { pooledMachineIdOf, liveSameDaemonHosts }, { standbyRunner }, { isFollower }, { getConfig }] = await Promise.all([
    import('./host-door.js'), import('./leader-issue.js'), import('../leader-doors.js'), import('../../providers/daemon-connection.js'),
    import('../standby/runner.js'), import('../server-role.js'), import('../config-manager.js'),
  ])
  // A ban is of the machine: a key is read with its machine id and the other keys of its daemon
  // (revoked-hosts.ts revokedAs), from what the links already hold (never a dial or a file read).
  const [{ setRevokedHostResolver }, { daemonTwinsOfNow }] = await Promise.all([import('./revoked-hosts.js'), import('../hosts/daemon-twins.js')])
  const machineIdOf = (hostKey: string): string | null => hostServer.hostServerLink(hostKey)?.helloMachineId ?? pooledMachineIdOf(hostKey)
  // This leader's own machine id is never a banned machine (a home copied to another box shares it: N1).
  setRevokedHostResolver({
    machineOf: machineIdOf, aliasesOf: (hostKey) => [...daemonTwinsOfNow(hostKey), ...liveSameDaemonHosts(hostKey)], ownMachine: () => ownMachine || null,
    // What one name's records may grant another: only this leader's own links to one live daemon (oneDaemonNow).
    sameDaemonNow: liveSameDaemonHosts,
  })
  // The ban read again at boot, at a revoke event here, at a config write and every minute (a ban
  // another process wrote): a host whose standing changed is cut, or may link again (noteRevoked).
  const revokedWatch = await issue.watchRevokedHosts((changed) => { for (const k of changed.length > 0 ? changed : ['']) side.noteRevoked(k) }, REVOKED_RECHECK_MS, (err) => {
    log.session.warn('host door: reading the revoked hosts failed', { error: err instanceof Error ? err.message : String(err) })
  })
  const recheckRevoked = revokedWatch.recheck
  const doorUrls = async (): Promise<string[]> => cleanDoorUrls((await getConfig()).session?.host_door_urls)
  // The hosts in this leader's config now: only they are issued, let in and kept linked at the door.
  let configured: Set<string> | null = null
  const readConfigured = async (): Promise<Set<string> | null> => {
    try { configured = issue.configuredHostKeys((await getConfig()).hosts) } catch { /* the last one read stands */ }
    return configured
  }
  await readConfigured()
  const isConfigured = (hostKey: string): boolean => configured?.has(hostKey) ?? false
  // A host removed from the config (or turned off) loses its credential and its sockets.
  const revokeGone = async (): Promise<void> => {
    const now = await readConfigured()
    if (!now) return
    const gone = await issue.revokeHostsGone(now).catch((err: unknown) => { log.session.warn('host door: revoking the credentials of removed hosts failed', { error: err instanceof Error ? err.message : String(err) }); return [] })
    if (gone.length > 0) log.session.info('host door: revoked the credentials of hosts no longer in the config', { machines: gone.length })
  }
  const stopDoor = await startHostDoor({
    walnutId: async () => getInstanceId(),
    standing: standingNow,
    doors: doorUrls,
    configured: isConfigured,
    adopt: (hostKey, sock) => side.adopt(hostKey, sock),
    log: (level, msg, data) => log.session[level](msg, data),
  })
  const syncStandby = async () => (await standbyRunner()?.runOnce()) ?? null
  issue.setRevokeStandbySync(syncStandby)
  const issuer = issue.startCredentialIssuer({
    walnutId: async () => getInstanceId(),
    flagOn: hostRunsSessionsAnyNow,
    doorUrls,
    // The machine id the host's daemon link said in its hello (the link the manager holds, else the pooled one).
    machineIdOf,
    openStream: async (hostKey, purpose) => {
      const link = hostServer.hostServerLink(hostKey)
      if (!link) throw new Error(`the host ${hostKey} is not connected`)
      return link.openStream('follower', purpose)
    },
    standing: (hostKey) => standingNow(hostKey).pair,
    configured: isConfigured,
    syncStandby,
    log: (level, msg, data) => log.session[level](msg, data),
  })
  // Open only on the leader (never a replica: the companion's own door is /host-listen) while the switch is on.
  const syncDoor = async (): Promise<void> => {
    const on = !isFollower() && await hostRunsSessionsAnyNow().catch(() => false)
    setLeaderDoorOpen('/host-door', on)
    // A delivery to a legacy session reads it sync (host-resume.ts resumeHostOf): off reads no row.
    noteSwitchAnyHost(on)
  }
  await syncDoor()
  pushDoors = async (doors) => {
    const clean = cleanDoorUrls(doors)
    const dialed = clean.length > 0 && await hostRunsSessionsAnyNow().catch(() => false) ? pushDoorsToDialed(clean) : []
    const { told, failed } = await issuer.pushDoors(clean, new Set(dialed))
    return { dialed, routed: told, failed }
  }
  // A start on another name of a machine whose service goes by one name goes to that service (leader-side.ts startKeyOf).
  setHostJudgeProbe((host) => side.startKeyOf(host))
  setHostSwitchProbe((host) => side.switchOn(host))
  // The per-host switch is read now, not only at a host's first view or a config write.
  await side.refreshFlag()
  // A runner call or a read the host refuses because it does not own the session: the same recovery as a send's.
  const disowned = (host: string, sid: string) => (err: unknown): never => {
    if (err instanceof Error && err.message.endsWith(`: ${NOT_OWN_SESSION}`)) void import('../../providers/host-judged-send.js').then((m) => m.confirmHostDisowns(sid, host)).catch(() => {})
    throw err
  }
  remote.setRemoteJudgedCaller((host, body, timeoutMs) => side.callHost(host, body, timeoutMs).catch(disowned(host, body.sid)))
  // A host-judged session's transcript is read and parsed on its host (sessions/host-history-reads.ts).
  setHostHistoryCaller((host, body, timeoutMs) => side.callHost(host, body, timeoutMs).catch(disowned(host, body.sid)))
  const look = (view: { hostKey: string; phase: string; server?: { capabilities?: unknown; sessionSide?: { state?: unknown } | null } | null }) => {
    const connected = hostServer.hostServerLink(view.hostKey) !== null
    void side.noteHost(view.hostKey, { connected, judges: view.phase === 'running' && reportJudges(view.server) })
    // A host seen while a ban stands may be a name of the banned machine its hello just told: every link is judged again (N2).
    if (anyHostRevoked()) side.noteRevoked(view.hostKey)
    noteHostResumes(view.hostKey, view.phase === 'running' && reportResumes(view.server), view.phase === 'running' && reportResumesAcp(view.server))
    noteHostTakesChecks(view.hostKey, view.phase === 'running' && reportHostChecks(view.server))
    noteHostTakesTaskRows(view.hostKey, view.phase === 'running' && reportTakesTaskRows(view.server))
    noteHostReadsHistory(view.hostKey, view.phase !== 'running' ? 'down' : reportReadsHistory(view.server) ? 'answers' : 'old')
    // Whether it takes a completed task's stop itself; the asks that waited to know go now (sessions/host-judged-complete.ts).
    void import('../sessions/host-judged-complete.js').then((m) => m.noteHostCompleteStop(view.hostKey,
      view.phase !== 'running' ? 'down' : reportTakesCompleteStop(view.server) ? 'takes' : 'old')).catch(() => {})
    lookIssue(view)
    // A host that stood down, or waits on a channel this leader has not opened: Walnut Health (host-side-health.ts).
    noteHostSessionSide(view.hostKey, view.phase === 'running' ? view.server?.sessionSide?.state : null)
  }
  const lookIssue = (view: { hostKey: string; phase: string; server?: { capabilities?: unknown } | null }) => {
    issuer.noteHost(view.hostKey, { connected: hostServer.hostServerLink(view.hostKey) !== null, dials: view.phase === 'running' && issue.reportDials(view.server) })
  }
  // A revoke or an allow made from a route (leader-issue.ts revokeHostDoorNow, allowHostDoorNow).
  issue.setDoorHostHooks({
    machineIdOf,
    recheck: (hostKey) => {
      issuer.refresh()
      for (const v of hostServer.peekHostServerViews()) if (v.hostKey === hostKey) lookIssue(v)
    },
    cut: (hostKey) => side.noteRevoked(hostKey),
  })
  const { startHostSessionTasks } = await import('./leader-tasks.js')
  const stopTasks = startHostSessionTasks()
  // A host's retriers run there: their turn state and give-ups reach this leader's readers.
  const [{ startLeaderRetryOver }, { setHostTurnSource }] = await Promise.all([import('./leader-retry-over.js'), import('../sessions/turn-run-host.js')])
  const stopRetryOver = startLeaderRetryOver()
  setHostTurnSource((sid) => remote.hostTurnStateOf(sid))
  const unlisten = hostServer.onHostServerView(look)
  // The switch is read again at every config write, so a start after it went off stays here.
  bus.subscribe(CONFIG_SUBSCRIBER, () => {
    void side.refreshFlag(); void syncDoor(); issuer.refresh(); void recheckRevoked(); void readLedgerSwitch()
    void revokeGone().then(() => { for (const v of hostServer.peekHostServerViews()) lookIssue(v) })
  }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
  void revokeGone()
  // A delete of a host's session: its host drops its row too (leader-drops.ts), now when linked, else at its next link.
  bus.subscribe(DELETE_SUBSCRIBER, (event) => {
    const ids = (event.data as { sessionIds?: unknown } | null)?.sessionIds
    if (!Array.isArray(ids)) return
    const sids = ids.filter((x): x is string => typeof x === 'string' && x !== '')
    for (const [host, mine] of leaderDropHosts(sids)) {
      for (const sid of mine) { forgetHostJudged(sid); remote.forgetRemoteJudgedSession(sid) }
      void side.dropOnHost(host)
    }
  }, { global: true, interest: [EventNames.SESSION_DELETED] })
  for (const view of hostServer.peekHostServerViews()) look(view)
  // The runtimes of host-judged ACP sessions, read once here so no send reads the store (sessions/session-command-gate.ts).
  setImmediate(() => { seedHostJudgedRuntimes() })
  // Hand-overs this leader had no answer to when it stopped: their lost checks run again (host-handover.ts).
  void import('../../providers/host-resume.js').then((m) => m.rearmHandOversAtBoot()).catch((err: unknown) => {
    log.session.warn('host hand-over: the unanswered hand-overs were not armed again', { error: err instanceof Error ? err.message : String(err) })
  })
  log.session.info('session channels: the leader side is on (hosts that name session-judge-v1 run their sessions)')
  return () => {
    unlisten()
    bus.unsubscribe(CONFIG_SUBSCRIBER)
    bus.unsubscribe(DELETE_SUBSCRIBER)
    stopTasks()
    stopRetryOver()
    setHostTurnSource(null)
    setLeaderDoorOpen('/host-door', false)
    issuer.stop()
    issue.setRevokeStandbySync(null)
    issue.setDoorHostHooks(null)
    revokedWatch.stop()
    setRevokedHostResolver(null)
    setQueuedRowLedger(null)
    stopDoor()
    side.stop()
    setHostJudgeProbe(null)
    remote.setRemoteJudgedCaller(null)
    setHostHistoryCaller(null)
    if (active === side) { active = null; standing = null; pushDoors = null; forgetHostResumes() }
  }
}
