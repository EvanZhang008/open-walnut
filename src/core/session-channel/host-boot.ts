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
 *
 * "Can run sessions": the host service holds the session runtime itself (server-role.ts
 * hasLocalDaemon, true once the one-service host keeps the in-process runtime), or this process
 * was started with the runtime in process (WALNUT_IN_PROCESS_DAEMON=1): the seam a test harness
 * uses until then, giving the runner its daemon itself.
 */
import fs from 'node:fs'
import path from 'node:path'
import { FactLog } from './fact-log.js'
import { GoneRows } from './gone-rows.js'
import { HostChannel } from './channel.js'
import { SESSION_JUDGE_CAP } from './switch.js'
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
}

let current: HostSessions | null = null

/** The routes the leader door serves, or null when this host does not run its sessions. */
export function hostSessionRoutes(): HostSessionRoutes | null {
  return current?.routes ?? null
}

/** What this host's service adds to the capabilities its report names. */
export function hostSessionCapabilities(): string[] {
  return current ? [SESSION_JUDGE_CAP] : []
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
export function hostCanRunSessions(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHostReplica() && (hasLocalDaemon() || env.WALNUT_IN_PROCESS_DAEMON === '1')
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
  const { allowOwnRowWrites, noteOwnRowGone, setOwnRowsGoneStore } = await import('../session-db.js')
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
  const [{ hostRunsSessionsNow }, { bus }] = await Promise.all([import('./switch.js'), import('../event-bus.js')])
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
    // A session this host runs: the emitter knows it, or its row says so (a start whose row is just written).
    owns: async (sid) => {
      if (emitter.owns(sid)) return true
      const { getSessionByClaudeId } = await import('../session-tracker.js')
      return rowOwnedHere(await getSessionByClaudeId(sid).catch(() => null), o.hostKey)
    },
    log: say,
  })
  current = { log, gone, channel, emitter, routes, bundles, resend }
  say('info', 'host sessions: this host runs and judges its sessions', { hostKey: o.hostKey, logId: log.logId, head: log.head })
  return current
}

export async function stopHostSessions(): Promise<void> {
  const c = current
  current = null
  if (!c) return
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
