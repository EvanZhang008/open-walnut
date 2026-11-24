/**
 * A host replica that runs and judges its sessions (docs/plan/one-service-every-host.md, phase 2),
 * put together when the switch is on (switch.ts) and this host can run sessions: at boot, or the
 * moment a config copy turns it on (followHostSwitch):
 *
 *   the fact log    one per Walnut, keyed by its instance id (WALNUT_WALNUT_ID), under this host's
 *                   own state dir
 *   the channel     HostChannel over that log; its rows are this host's own (rowOwnedHere)
 *   the port        hostSessionPort (host-port.ts), installed for the session classes
 *   the emitter     bus events and row writes of own sessions -> records (host-emitter.ts)
 *   the resend family  queue-after-turn, the waits, the recoveries, the respawns, for own rows
 *                   (host-resend.ts), subscribed before the emitter
 *   the routes      on the leader door (host-routes.ts), and SESSION_JUDGE_CAP in the report the
 *                   leader reads of this host's service (replica/front.ts status)
 *   the dialer      the leader's door, with the credential the leader issued over its link
 *                   (host-dialer.ts, host-credential-file.ts), and HOST_DOOR_CAP in the report
 *   the listener link  the cloud companion's listener door, with the bridge link's own token
 *                   (companion-dialer.ts): the phone sees and operates these sessions there while
 *                   the leader is away
 *   the old-leader watch  a leader that answers but never opens the channel is an older Walnut that
 *                   judges every session itself: this host judges none of its rows (its resend family
 *                   acts on none) until a leader opens the channel again (old-leader-watch.ts)
 *
 * "Can run sessions": this is a host's one Walnut service (src/binary/service-entry.ts), which holds
 * the host's session runtime in its own process (server-role.ts hasLocalDaemon). While its sessions
 * run here, its session runner reaches that runtime through the own-sessions link (daemon-connection.ts
 * assertLocalDialAllowed), the one '__local__' connection a replica may hold; a plain host server
 * (a daemon program beside it) runs none and the leader runs this host's sessions as before.
 */
import fs from 'node:fs'
import path from 'node:path'
import { FactLog } from './fact-log.js'
import { GoneRows } from './gone-rows.js'
import { HostChannel } from './channel.js'
import { SESSION_JUDGE_CAP, SESSION_RESUME_ACP_CAP, SESSION_RESUME_CAP } from './switch.js'
import { HOST_DOOR_CAP } from './door-wire.js'
import { startHostDialer, type HostDialer } from './host-dialer.js'
import { startCompanionDialer, type CompanionDialer } from './companion-dialer.js'
import { createHostEmitter, type HostEmitter } from './host-emitter.js'
import { createHostSessionPort, selfOwnApi, StartBundles } from './host-port.js'
import { createHostSessionRoutes, type HostSessionRoutes } from './host-routes.js'
import { liveStateOf, type LiveRunnerLike } from './host-live.js'
import { startHostResendFamily, turnEndStamp, turnOfOwnSession, type HostResendFamily } from './host-resend.js'
import { LEADER_CHANNEL_CAP, startOldLeaderWatch, type OldLeaderWatch, type SessionSideState } from './old-leader-watch.js'
import { createStandDownHeld } from './stand-down-held.js'
import { installSessionPort } from '../sessions/session-port.js'
import { heldOnThisHost, startStrandedSweep, type StrandedSweep } from '../sessions/stranded-own-rows.js'
import { rowOwnedHere } from '../sessions/session-row-owner.js'
import type { LiveCli } from './host-judged-lines.js'
import { noteSessionRowWritten } from './row-hook.js'
import { hasLocalDaemon, isHostReplica } from '../server-role.js'
import { WALNUT_HOME } from '../../constants.js'
import type { SessionRecord } from '../types.js'

export interface HostSessions {
  log: FactLog
  gone: GoneRows
  channel: HostChannel
  emitter: HostEmitter
  routes: HostSessionRoutes
  bundles: StartBundles
  resend: HostResendFamily
  dialer: HostDialer
  companion: CompanionDialer
  stranded: StrandedSweep
  oldLeader: OldLeaderWatch
  /** The stop of the attach rule and the boot attach of the own rows (host-judged-lines.ts). */
  ownAttach: () => void
}

let current: HostSessions | null = null

const STAND_DOWN_HELD_SUBSCRIBER = 'host-stand-down-held'

/** The routes the leader door serves, or null when this host does not run its sessions. */
export function hostSessionRoutes(): HostSessionRoutes | null {
  return current?.routes ?? null
}

/** What this host's service adds to the capabilities its report names. */
export function hostSessionCapabilities(): string[] {
  return current ? [SESSION_JUDGE_CAP, SESSION_RESUME_CAP, SESSION_RESUME_ACP_CAP, HOST_DOOR_CAP] : []
}

/**
 * What this host's status report says of its session side (replica/front.ts `sessionSide`), or null
 * when it does not run its sessions: judging, waiting on a channel its leader says it has, or
 * stood down for an older leader (old-leader-watch.ts). The leader's Walnut Health shows the last two.
 */
export function hostSessionSideReport(): { state: SessionSideState; since: number | null } | null {
  return current ? current.oldLeader.state() : null
}

export function hostSessionsRunning(): HostSessions | null {
  return current
}

/**
 * Has this host run sessions of its own for this Walnut (its fact log exists)? The log lives under
 * this host's own home, `session-channel/` (home manifest: session-channel, a machine's place).
 */
export function hostRanSessions(walnutId: string, stateDir: string = WALNUT_HOME): boolean {
  if (!walnutId) return false
  return fs.existsSync(path.join(stateDir, 'session-channel', `facts-${walnutId}.ndjson`))
}

/** Can this host replica run sessions itself (see the header)? */
export function hostCanRunSessions(): boolean {
  return isHostReplica() && hasLocalDaemon()
}

export interface StartHostSessionsOptions {
  walnutId: string
  hostKey: string
  /** This host's own state dir (the fact log and spilled prompts go under it); its home by default. */
  stateDir?: string
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}

async function ownRows(hostKey: string): Promise<SessionRecord[]> {
  const { listSessions } = await import('../session-tracker.js')
  return (await listSessions()).filter((r) => rowOwnedHere(r, hostKey))
}

/** Does the leader that answers now say it speaks the channel (old-leader-watch.ts LEADER_CHANNEL_CAP)? */
export async function leaderSaysChannelNow(d: { caps(): Promise<unknown>; heardAt(): Promise<number>; presenceSince(): number }): Promise<boolean> {
  const caps = await d.caps()
  if (!Array.isArray(caps) || !caps.includes(LEADER_CHANNEL_CAP)) return false
  return (await d.heardAt()) > d.presenceSince()
}

/** Put the pieces together (once). Null, with the reason logged, when this host cannot. */
export async function startHostSessions(o: StartHostSessionsOptions): Promise<HostSessions | null> {
  if (current) return current
  const say = o.log ?? (() => {})
  if (!o.walnutId || !o.hostKey) {
    say('warn', 'host sessions: not started, this host does not know its Walnut id or its host key yet', { walnutId: !!o.walnutId, hostKey: !!o.hostKey })
    return null
  }
  const { stateDir = WALNUT_HOME } = o
  const dir = path.join(stateDir, 'session-channel')
  const log = await FactLog.open({ dir, walnutId: o.walnutId, log: say })
  // The own rows this host removed, kept on disk next to the log (gone-rows.ts).
  const gone = await GoneRows.open(dir, o.walnutId)
  // The copy's store is read only here: rows of this host's own sessions go through the own-row writer.
  const { allowOwnRowWrites, noteOwnRowGone, setOwnRowsGoneStore, claimStartingRow, releaseStartingRow, setLeaderDisownNotice } = await import('../session-db.js')
  allowOwnRowWrites(o.hostKey)
  setOwnRowsGoneStore(gone)
  // The emitter is made just below; the leader's resync asks reach it once it is.
  let emitterRef: HostEmitter | null = null
  // The old-leader watch, made below: a leader's link makes it look at once.
  let watchRef: OldLeaderWatch | null = null
  const channel = new HostChannel({
    log, walnutId: o.walnutId, hostId: o.hostKey, ownRows: () => ownRows(o.hostKey), onLog: say,
    onResync: (sids) => { void emitterRef?.resync(sids).catch((err: unknown) => say('warn', 'host sessions: a resync failed', { error: err instanceof Error ? err.message : String(err) })) },
    goneRows: () => gone.list(),
    // A leader keeps the live state only in memory: each link gets it again.
    onLeaderLinked: () => { emitterRef?.relive(); void watchRef?.tick() },
  })
  const { sessionRunner } = await import('../../providers/claude-code-session.js')
  const runner = sessionRunner as unknown as LiveRunnerLike & { findSessionByClaudeId(sid: string): { consumedOffset?: number } | undefined }
  const bundles = new StartBundles()
  const [stamp, turnOf] = await Promise.all([turnEndStamp(), turnOfOwnSession()])
  const emitter = createHostEmitter({
    log, channel, hostKey: o.hostKey,
    ownRows: () => ownRows(o.hostKey),
    liveOf: (sid) => liveStateOf(runner, sid, turnOf),
    stamp,
    // The line the runner has read up to: the fact log keeps the furthest one told (fact-log.ts toldLine),
    // where an attach after a restart reads on from (host-judged-lines.ts).
    offsetOf: (sid) => { const at = (runner.findSessionByClaudeId(sid) as { readOffset?: number } | undefined)?.readOffset; return typeof at === 'number' && at >= 0 ? at : undefined },
    onOwnRow: (sid) => gone.forget(sid),
    handOf: (row) => bundles.handFor(row.taskId),
    onLog: say,
  })
  emitterRef = emitter
  const port = createHostSessionPort({
    hostKey: o.hostKey, bundles, api: selfOwnApi,
    sessionOfTask: (taskId) => emitter.ownSessionOfTask(taskId),
    // A row removed here is not taken back from the leader's copy before the leader applied it (session-db.ts noteOwnRowGone).
    beforeRename: (from, to) => emitter.expectRename(from, to),
    renameFailed: (from, to) => emitter.cancelRename(from, to),
    onRename: (from, to) => { noteOwnRowGone(from); emitter.noteRename(from, to) },
    onDrop: (sids) => { for (const sid of sids) noteOwnRowGone(sid); emitter.noteDrop(sids) },
    log: say,
  })
  installSessionPort(port)
  // Own rows no session here holds while the leader says they are not this host's go back to the
  // leader's version (stranded-own-rows.ts): at boot, on a clock, after a copy that disowns one, and
  // at a failed start's release.
  // The runner's objects of `sid` that hold nothing let go (claude-code-session.ts dropDeadWrapper).
  const dropIdle = (sid: string): void => sessionRunner.resumeView().dropDeadWrapper(sid)
  // Does a session of `sid` live in this host's runner (a stranded row is held, a resume is refused)?
  const runnerHolds = (sid: string): boolean => !!(runner.findSessionByClaudeId?.(sid) || runner.findAcpSession?.(sid))
  const stranded = startStrandedSweep({
    held: (row) => heldOnThisHost(row, { runnerHolds, runtimeAlive: (sid) => runtimeHoldsCli(sid) }),
    // Given back: the runner's objects of them that hold nothing go too (a later resume builds anew).
    onHandedBack: (sids) => { emitter.disown(sids); for (const sid of sids) dropIdle(sid) },
    log: say,
  })
  setLeaderDisownNotice(() => stranded.poke())
  // Before the emitter subscribes: at a turn end each retrier takes it first, then the emitter stamps it.
  const resend = await startHostResendFamily({ say })
  await emitter.start()
  const [{ hostRunsSessionsAnyNow }, { bus }, { readMachineId }] = await Promise.all([import('./switch.js'), import('../event-bus.js'), import('../machine-id.js')])
  // Made just below; a credential the leader issues pokes it.
  let dialerRef: HostDialer | null = null
  const routes = createHostSessionRoutes({
    enabled: hostRunsSessionsAnyNow,
    runner: async () => sessionRunner as never,
    bundles,
    channel: () => current?.channel ?? null,
    emit: (name, data, source) => bus.emit(name, data, ['session-runner'], { source }),
    // The leader's queue rows for a session here, framed as its send route framed them, holds kept (sessions/handed-holds.ts).
    enqueue: async (sid, lines, source) => (await import('../sessions/handed-holds.js')).queueLinesOnHost(sid, lines, source),
    // The leader deleted these (leader-drops.ts): this host's own rows of them go, and each gets its
    // `drop` record, also one this host no longer has (the leader's proof that nothing is left here).
    drop: async (sids) => {
      const { getSessionByClaudeId } = await import('../session-tracker.js')
      const own: string[] = []
      for (const sid of sids) if (rowOwnedHere(await getSessionByClaudeId(sid), o.hostKey)) own.push(sid)
      const removed = own.length ? await port.records.tracker.deleteSessionRecords(new Set(own), 'leader-deleted') : 0
      const told = new Set(removed > 0 ? own : [])
      emitter.noteDrop(sids.filter((sid) => !told.has(sid)), { answer: true })
      say('info', 'host sessions: dropped the sessions the leader deleted', { count: sids.length, removed })
      return sids.length
    },
    spillDir: path.join(dir, 'prompts'),
    // A start the leader handed names its session: that row is this host's from its first write.
    claim: { take: claimStartingRow, release: (sid) => { releaseStartingRow(sid); void stranded.run(sid).catch(() => {}) } },
    // A resume taken: its idle objects go, and its claimed row is this host's own now (the emitter
    // takes it as the runner's first write would: an ACP attach makes none, and its live state counts).
    taken: async (sid) => {
      dropIdle(sid)
      const row = await (await import('../session-tracker.js')).getSessionByClaudeId(sid).catch(() => null)
      if (row) noteSessionRowWritten(row)
    },
    // A resume of a session its leader ran: refused while anything of it runs here.
    notAtRest: (sid, row) => resumeNotAtRest(sid, row, {
      holds: (id) => sessionRunner.holdsSessionForResume(id),
      rowOf: async (id) => (await import('../session-tracker.js')).getSessionByClaudeId(id).catch(() => null),
    }),
    // A session this host runs: the emitter knows it, or its row says so (a start whose row is just written).
    owns: async (sid) => {
      if (emitter.owns(sid)) return true
      const { getSessionByClaudeId } = await import('../session-tracker.js')
      return rowOwnedHere(await getSessionByClaudeId(sid).catch(() => null), o.hostKey)
    },
    // The leader's door credential (host-credential-file.ts): only this Walnut's, only this machine's.
    credential: { walnutId: o.walnutId, machineId: readMachineId, seenPermit: () => log.permitPair, onIssued: () => dialerRef?.poke(), onDoors: () => dialerRef?.poke() },
    log: say,
  })
  const dialer = startHostDialer({
    walnutId: o.walnutId, machineId: readMachineId, enabled: hostRunsSessionsAnyNow,
    channel: () => current?.channel ?? null,
    routes: () => current?.routes ?? null,
    seenPermit: () => log.permitPair,
    // Tests: a shorter ping, so a leader that went silent is left in seconds (host-dialer.ts DOOR_PING_MS).
    ...(Number(process.env.WALNUT_HOST_DOOR_PING_MS) > 0 ? { pingMs: Number(process.env.WALNUT_HOST_DOOR_PING_MS) } : {}),
    log: say,
  })
  dialerRef = dialer
  const companion = startCompanionDialer({
    walnutId: o.walnutId, enabled: hostRunsSessionsAnyNow,
    channel: () => current?.channel ?? null,
    routes: () => current?.routes ?? null,
    log: say,
  })
  const [{ leaderPresence }, { setHostStandsDown, hostStandsDown }, { getConfig }] = await Promise.all([import('../server-role.js'), import('../sessions/judge-of.js'), import('../config-manager.js')])
  // The turn ends the family skipped while standing down, for its stand-up (stand-down-held.ts).
  const held = createStandDownHeld({ standingDown: hostStandsDown, owns: (sid) => emitter.owns(sid), offsetOf: (sid) => runner.findSessionByClaudeId(sid)?.consumedOffset, log: say })
  bus.subscribe(STAND_DOWN_HELD_SUBSCRIBER, (event) => held.note(event), { global: true, interest: ['session:'] })
  const oldLeader = startOldLeaderWatch({
    leaderAnswers: () => leaderPresence().answers,
    channelLinked: () => channel.leaderLive() || dialer.linked(),
    // The leader's own word in its config copy: one that speaks the channel never makes this host
    // stand down on the timeout. Only a copy heard since the leader that answers now began answering
    // counts: a row an earlier leader left (a straight downgrade) says nothing of this one.
    leaderSaysChannel: async () => leaderSaysChannelNow({
      caps: async () => (await getConfig().catch(() => null))?.leader_capabilities,
      heardAt: async () => (await import('../replication/kinds/config.js')).configCopyHeardAt().catch(() => 0),
      presenceSince: () => leaderPresence().since,
    }),
    // Every member of the resend family acts only on what judgedHere names (none, standing down); the
    // family stays subscribed in its order before the emitter. The CLIs, routes, log and emitter go on.
    standDown: () => setHostStandsDown(true),
    standUp: () => {
      setHostStandsDown(false)
      const ends = held.take()
      if (ends.length === 0) return
      say('info', 'host sessions: handing the turn ends of the stand-down to the resend family', { count: ends.length, sessionIds: ends.slice(0, 20).map((e) => (e.data as { sessionId?: string }).sessionId) })
      resend.replay(ends)
    },
    log: say,
  })
  watchRef = oldLeader
  const up: HostSessions = { log, gone, channel, emitter, routes, bundles, resend, dialer, companion, stranded, oldLeader, ownAttach: () => {} }
  current = up
  // The session runner may reach the runtime in this process from now on (the own-sessions link).
  ;(await import('../../providers/daemon-connection.js')).setOwnSessionsLink(true)
  // A line into an own session's CLI by any path but its runner waits for the runner to watch it, and
  // the own rows whose CLI survived this service's restart are watched again at once (host-judged-lines.ts).
  const [{ selfHostConnection }, { getSessionByClaudeId }] = await Promise.all([import('../../replica/self-host.js'), import('../session-tracker.js')])
  const delayMs = Number(process.env.WALNUT_HOST_OWN_ATTACH_DELAY_MS)
  up.ownAttach = await (await import('./host-judged-lines.js')).installOwnAttach({
    runner: sessionRunner, holds: runnerHolds, ownRows: () => ownRows(o.hostKey), runnerReady: sessionRunner.initialized,
    engineOf: async (sid) => (await getSessionByClaudeId(sid).catch(() => null))?.engine ?? undefined,
    liveCli: (sid) => runtimeLiveCli(sid), toldLine: (sid) => log.toldLine(sid),
    readsReady: () => selfHostConnection(o.hostKey)?.connected === true,
    // Tests: the boot passes wait this much longer, so only the attach before a write can take a session.
    ...(delayMs > 0 ? { delayMs } : {}), log: say,
  })
  // Stopped while it was put in place: it goes too.
  if (current !== up) up.ownAttach()
  // The boot pass: a row a start claimed before this service stopped (its claim was in memory only).
  void stranded.run().catch(() => {})
  say('info', 'host sessions: this host runs and judges its sessions', { hostKey: o.hostKey, logId: log.logId, head: log.head })
  return up
}

/**
 * The session side follows the switch (switch.ts hostRunsSessionsAny on this host's config copy):
 * started now when the switch is on for any host or this host ran sessions before (its fact log, so
 * the sessions it ran keep reporting after the switch went off), and else started, with no restart,
 * after the first copy round that turns it on. Once up it stays up when the switch goes off again:
 * a new start answers host_runs_sessions_off (host-routes.ts), and the door and companion dialers do
 * not dial again once their link drops (host-dialer.ts, companion-dialer.ts); the sessions it runs,
 * its fact log and the leader's own link to its channel go on. Returns the stop of the following.
 */
export async function followHostSwitch(o: StartHostSessionsOptions): Promise<() => Promise<void>> {
  const say = o.log ?? (() => {})
  const [{ hostRunsSessionsAny }, { getConfig }, { onConfigCopyChanged }] = await Promise.all([
    import('./switch.js'), import('../config-manager.js'), import('../replication/kinds/config.js'),
  ])
  return followSwitch({
    isOn: async () => hostRunsSessionsAny(await getConfig().catch(() => null)) || hostRanSessions(o.walnutId, o.stateDir),
    isUp: () => current !== null,
    start: async () => { await startHostSessions(o) },
    stop: stopHostSessions,
    onChange: onConfigCopyChanged,
    log: say,
  })
}

/**
 * The following itself (followHostSwitch), over seams for tests: look now, and at every change
 * until up. Its stop waits for a start still in flight and then stops what it brought up, so a
 * stop of the server during a late start leaves no dialer or timer running (review round 1, N1).
 */
export async function followSwitch(d: {
  isOn(): Promise<boolean>
  isUp(): boolean
  start(): Promise<void>
  stop(): Promise<void>
  onChange(fn: () => void): () => void
  log?: (level: 'info' | 'warn', msg: string, data?: Record<string, unknown>) => void
}): Promise<() => Promise<void>> {
  let starting: Promise<void> | null = null
  let stopped = false
  let startedHere = false
  const look = (): Promise<void> => {
    if (stopped || d.isUp()) return Promise.resolve()
    starting ??= (async () => {
      const on = await d.isOn()
      if (!on || stopped || d.isUp()) return
      await d.start()
      startedHere = d.isUp()
    })().catch((err: unknown) => {
      d.log?.('warn', 'host sessions: not started; the leader runs this host\'s sessions as before', { error: err instanceof Error ? err.message : String(err) })
    }).finally(() => { starting = null })
    return starting
  }
  await look()
  let off: (() => void) | null = null
  if (!d.isUp()) off = d.onChange(() => { void look().then(() => { if (d.isUp()) { off?.(); off = null } }) })
  return async () => {
    stopped = true
    off?.(); off = null
    const inFlight = starting
    if (inFlight) await inFlight
    // A start that finished after the stop began: what it brought up goes too.
    if (startedHere && d.isUp()) await d.stop()
  }
}

export async function stopHostSessions(): Promise<void> {
  const c = current
  current = null
  if (!c) return
  c.ownAttach()
  ;(await import('../../providers/daemon-connection.js')).setOwnSessionsLink(false)
  c.oldLeader.stop()
  ;(await import('../event-bus.js')).bus.unsubscribe(STAND_DOWN_HELD_SUBSCRIBER)
  ;(await import('../sessions/judge-of.js')).setHostStandsDown(false)
  c.dialer.stop()
  c.companion.stop()
  c.stranded.stop()
  c.emitter.stop()
  c.resend.stop()
  c.routes.close()
  installSessionPort(null)
  const { allowOwnRowWrites, setOwnRowsGoneStore, setLeaderDisownNotice } = await import('../session-db.js')
  setLeaderDisownNotice(null)
  allowOwnRowWrites(null)
  setOwnRowsGoneStore(null)
  await c.gone.flush()
  await c.log.close()
}

/**
 * Why a resume the leader hands this host is refused, or null when nothing of it runs here.
 * `holds`: the runner's test, the same as the leader's (claude-code-session.ts holdsSessionForResume),
 * so an ACP object that holds nothing (one this host judged and gave back) refuses no later resume.
 * An ACP engine's CLI is its worker, which the runtime knows by the row's runtime id: the row the
 * resume names, else this host's copy of it.
 */
export async function resumeNotAtRest(
  sid: string, row: SessionRecord | undefined,
  o: { holds(sid: string): boolean; rowOf(sid: string): Promise<SessionRecord | null>; runtime?: Parameters<typeof runtimeHoldsCli>[2] },
): Promise<string | null> {
  if (o.holds(sid)) return 'a live session of it is in this host\'s runner'
  const cli = await runtimeHoldsCli(sid, row ?? await o.rowOf(sid), o.runtime)
  if (cli === true) return 'its CLI runs in this host\'s runtime'
  return cli === null ? 'this host\'s runtime did not say whether its CLI runs' : null
}

type RuntimeConn = { send(cmd: string, params: Record<string, unknown>, timeoutMs?: number): Promise<unknown> }

/** This host's own link to its runtime (the own-sessions link), or null when it did not come within a few seconds. */
async function runtimeConn(given?: RuntimeConn | null): Promise<RuntimeConn | null> {
  if (given) return given
  const [dc, { getLocalDaemonConnection }, { within }] = await Promise.all([
    import('../../providers/daemon-connection.js'), import('../../providers/local-daemon-dial.js'), import('./host-judged-lines.js'),
  ])
  return dc.getConnectedDaemonConnection('__local__') ?? (await within(getLocalDaemonConnection(), 3_000)) ?? null
}

/**
 * The runtime's word on a session's CLI (its `status` answer through the own-sessions link): alive,
 * dead, or null when the link or the answer did not come within a few seconds. For a row of an ACP
 * engine, its worker's (`acpState` by the row's runtime id; no runtime id is no answer).
 */
export async function runtimeHoldsCli(
  sid: string, row?: Pick<SessionRecord, 'engine' | 'acpRuntimeId'> | null,
  /** Tests: the runtime's connection (else this host's own link to its runtime). */
  given?: RuntimeConn | null,
): Promise<boolean | null> {
  const { acpWorkerReplyAlive, statusReplyAlive } = await import('../../providers/daemon-status-reply.js')
  const { isAcpEngine } = await import('../agents/engine-registry.js')
  const { within } = await import('./host-judged-lines.js')
  const conn = await runtimeConn(given)
  if (!conn) return null
  if (row && isAcpEngine(row.engine ?? undefined)) {
    if (!row.acpRuntimeId) return null
    return acpWorkerReplyAlive(((await within(conn.send('acpState', { sid: row.acpRuntimeId }, 3_000), 3_500)) ?? null) as { ok?: unknown; errorKind?: unknown } | null)
  }
  const reply = await within(conn.send('status', { sid }, 3_000), 3_500)
  return reply ? statusReplyAlive(reply as { ok?: unknown; exists?: unknown; alive?: unknown }) : null
}

/** A native session's CLI as the runtime holds it now (its registry, whatever the row says): alive with its pid, or null. */
export async function runtimeLiveCli(sid: string, given?: RuntimeConn | null): Promise<LiveCli> {
  const { statusReplyAlive } = await import('../../providers/daemon-status-reply.js')
  const { within } = await import('./host-judged-lines.js')
  const conn = await runtimeConn(given)
  if (!conn) return null
  const reply = (await within(conn.send('status', { sid }, 3_000), 3_500)) as { ok?: unknown; exists?: unknown; alive?: unknown; pid?: unknown } | undefined
  if (!reply || statusReplyAlive(reply) !== true) return null
  return typeof reply.pid === 'number' ? { pid: reply.pid } : {}
}
