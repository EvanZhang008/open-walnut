/**
 * A host replica that runs and judges its sessions (docs/plan/one-service-every-host.md, phase 2),
 * put together at boot when the switch is on (switch.ts) and this host can run sessions:
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
import { installSessionPort } from '../sessions/session-port.js'
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
  const { allowOwnRowWrites, noteOwnRowGone, setOwnRowsGoneStore, claimStartingRow, releaseStartingRow } = await import('../session-db.js')
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
  // Before the emitter subscribes: at a turn end each retrier takes it first, then the emitter stamps it.
  const resend = await startHostResendFamily({ say })
  await emitter.start()
  const [{ hostRunsSessionsNow }, { bus }, { readMachineId }] = await Promise.all([import('./switch.js'), import('../event-bus.js'), import('../machine-id.js')])
  // Made just below; a credential the leader issues pokes it.
  let dialerRef: HostDialer | null = null
  const routes = createHostSessionRoutes({
    enabled: hostRunsSessionsNow,
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
    claim: { take: claimStartingRow, release: releaseStartingRow },
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
    walnutId: o.walnutId, machineId: readMachineId, enabled: hostRunsSessionsNow,
    channel: () => current?.channel ?? null,
    routes: () => current?.routes ?? null,
    seenPermit: () => log.permitPair,
    // Tests: a shorter ping, so a leader that went silent is left in seconds (host-dialer.ts DOOR_PING_MS).
    ...(Number(process.env.WALNUT_HOST_DOOR_PING_MS) > 0 ? { pingMs: Number(process.env.WALNUT_HOST_DOOR_PING_MS) } : {}),
    log: say,
  })
  dialerRef = dialer
  const companion = startCompanionDialer({
    walnutId: o.walnutId, enabled: hostRunsSessionsNow,
    channel: () => current?.channel ?? null,
    routes: () => current?.routes ?? null,
    log: say,
  })
  current = { log, gone, channel, emitter, routes, bundles, resend, dialer, companion }
  // The session runner may reach the runtime in this process from now on (the own-sessions link).
  ;(await import('../../providers/daemon-connection.js')).setOwnSessionsLink(true)
  say('info', 'host sessions: this host runs and judges its sessions', { hostKey: o.hostKey, logId: log.logId, head: log.head })
  return current
}

export async function stopHostSessions(): Promise<void> {
  const c = current
  current = null
  if (!c) return
  ;(await import('../../providers/daemon-connection.js')).setOwnSessionsLink(false)
  c.dialer.stop()
  c.companion.stop()
  c.emitter.stop()
  c.resend.stop()
  c.routes.close()
  installSessionPort(null)
  const { allowOwnRowWrites, setOwnRowsGoneStore } = await import('../session-db.js')
  allowOwnRowWrites(null)
  setOwnRowsGoneStore(null)
  await c.gone.flush()
  await c.log.close()
}
