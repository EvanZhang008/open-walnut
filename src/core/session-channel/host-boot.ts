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
import { SESSION_JUDGE_CAP } from './switch.js'
import { HOST_DOOR_CAP } from './door-wire.js'
import { startHostDialer, type HostDialer } from './host-dialer.js'
import { startCompanionDialer, type CompanionDialer } from './companion-dialer.js'
import { createHostEmitter, type HostEmitter } from './host-emitter.js'
import { createHostSessionPort, selfOwnApi, StartBundles } from './host-port.js'
import { createHostSessionRoutes, type HostSessionRoutes } from './host-routes.js'
import { liveStateOf, type LiveRunnerLike } from './host-live.js'
import { startHostResendFamily, turnEndStamp, turnOfOwnSession, type HostResendFamily } from './host-resend.js'
import { startOldLeaderWatch, type OldLeaderWatch } from './old-leader-watch.js'
import { installSessionPort } from '../sessions/session-port.js'
import { heldOnThisHost, startStrandedSweep, type StrandedSweep } from '../sessions/stranded-own-rows.js'
import { rowOwnedHere } from '../sessions/session-row-owner.js'
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
}

let current: HostSessions | null = null

/** The routes the leader door serves, or null when this host does not run its sessions. */
export function hostSessionRoutes(): HostSessionRoutes | null {
  return current?.routes ?? null
}

/** What this host's service adds to the capabilities its report names. */
export function hostSessionCapabilities(): string[] {
  return current ? [SESSION_JUDGE_CAP, HOST_DOOR_CAP] : []
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
  const channel = new HostChannel({
    log, walnutId: o.walnutId, hostId: o.hostKey, ownRows: () => ownRows(o.hostKey), onLog: say,
    onResync: (sids) => { void emitterRef?.resync(sids).catch((err: unknown) => say('warn', 'host sessions: a resync failed', { error: err instanceof Error ? err.message : String(err) })) },
    goneRows: () => gone.list(),
    // A leader keeps the live state only in memory: each link gets it again.
    onLeaderLinked: () => emitterRef?.relive(),
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
    offsetOf: (sid) => runner.findSessionByClaudeId(sid)?.consumedOffset,
    onOwnRow: (sid) => gone.forget(sid),
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
  const stranded = startStrandedSweep({
    held: (row) => heldOnThisHost(row, {
      runnerHolds: (sid) => !!(runner.findSessionByClaudeId?.(sid) || runner.findAcpSession?.(sid)),
      runtimeAlive: runtimeHoldsCli,
    }),
    onHandedBack: (sids) => emitter.disown(sids),
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
  const [{ leaderPresence }, { setHostStandsDown }] = await Promise.all([import('../server-role.js'), import('../sessions/judge-of.js')])
  const oldLeader = startOldLeaderWatch({
    leaderAnswers: () => leaderPresence().answers,
    channelLinked: () => channel.leaderLive() || dialer.linked(),
    // Every member of the resend family acts only on what judgedHere names (none, standing down); the
    // family stays subscribed in its order before the emitter. The CLIs, routes, log and emitter go on.
    standDown: () => setHostStandsDown(true),
    standUp: () => setHostStandsDown(false),
    log: say,
  })
  current = { log, gone, channel, emitter, routes, bundles, resend, dialer, companion, stranded, oldLeader }
  // The session runner may reach the runtime in this process from now on (the own-sessions link).
  ;(await import('../../providers/daemon-connection.js')).setOwnSessionsLink(true)
  // The boot pass: a row a start claimed before this service stopped (its claim was in memory only).
  void stranded.run().catch(() => {})
  say('info', 'host sessions: this host runs and judges its sessions', { hostKey: o.hostKey, logId: log.logId, head: log.head })
  return current
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
export async function followHostSwitch(o: StartHostSessionsOptions): Promise<() => void> {
  const say = o.log ?? (() => {})
  const [{ hostRunsSessionsAny }, { getConfig }, { onConfigCopyChanged }] = await Promise.all([
    import('./switch.js'), import('../config-manager.js'), import('../replication/kinds/config.js'),
  ])
  let starting: Promise<void> | null = null
  let stopped = false
  const look = (): Promise<void> => {
    if (stopped || current) return Promise.resolve()
    starting ??= (async () => {
      const on = hostRunsSessionsAny(await getConfig().catch(() => null)) || hostRanSessions(o.walnutId, o.stateDir)
      if (!on || stopped || current) return
      await startHostSessions(o)
    })().catch((err: unknown) => {
      say('warn', 'host sessions: not started; the leader runs this host\'s sessions as before', { error: err instanceof Error ? err.message : String(err) })
    }).finally(() => { starting = null })
    return starting
  }
  await look()
  if (current) return () => {}
  const off = onConfigCopyChanged(() => { void look().then(() => { if (current) off() }) })
  return () => { stopped = true; off() }
}

export async function stopHostSessions(): Promise<void> {
  const c = current
  current = null
  if (!c) return
  ;(await import('../../providers/daemon-connection.js')).setOwnSessionsLink(false)
  c.oldLeader.stop()
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
 * The runtime's word on a session's CLI (its `status` answer through the own-sessions link): alive,
 * dead, or null when the link or the answer did not come within a few seconds.
 */
async function runtimeHoldsCli(sid: string): Promise<boolean | null> {
  const dc = await import('../../providers/daemon-connection.js')
  const { getLocalDaemonConnection } = await import('../../providers/local-daemon-dial.js')
  const { statusReplyAlive } = await import('../../providers/daemon-status-reply.js')
  const within = <T>(p: Promise<T>, ms: number): Promise<T | null> => new Promise((resolve) => {
    const t = setTimeout(() => resolve(null), ms)
    t.unref?.()
    p.then((v) => { clearTimeout(t); resolve(v) }, () => { clearTimeout(t); resolve(null) })
  })
  const conn = dc.getConnectedDaemonConnection('__local__') ?? await within(getLocalDaemonConnection(), 3_000)
  if (!conn) return null
  const reply = await within(conn.send('status', { sid }, 3_000), 3_500)
  return reply ? statusReplyAlive(reply as { ok?: unknown; exists?: unknown; alive?: unknown }) : null
}
