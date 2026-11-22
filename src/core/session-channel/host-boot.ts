/**
 * A host replica that runs and judges its sessions (docs/plan/one-service-every-host.md, phase 2),
 * put together at boot when the switch is on (switch.ts) and this host can run sessions:
 *
 *   the fact log    one per Walnut, keyed by its instance id (WALNUT_WALNUT_ID), under this host's
 *                   own state dir
 *   the channel     HostChannel over that log; its rows are this host's own (rowOwnedHere)
 *   the port        hostSessionPort (host-port.ts), installed for the session classes
 *   the emitter     bus events and row writes of own sessions -> records (host-emitter.ts)
 *   the routes      on the leader door (host-routes.ts), and SESSION_JUDGE_CAP in the report the
 *                   leader reads of this host's service (replica/front.ts status)
 *
 * "Can run sessions": the host service holds the session runtime itself (server-role.ts
 * hasLocalDaemon, true once the one-service host keeps the in-process runtime), or this process
 * was started with the runtime in process (WALNUT_IN_PROCESS_DAEMON=1): the seam a test harness
 * uses until then, giving the runner its daemon itself.
 */
import path from 'node:path'
import { FactLog } from './fact-log.js'
import { HostChannel } from './channel.js'
import { SESSION_JUDGE_CAP } from './switch.js'
import { createHostEmitter, type HostEmitter } from './host-emitter.js'
import { createHostSessionPort, selfOwnApi, StartBundles } from './host-port.js'
import { createHostSessionRoutes, type HostSessionRoutes } from './host-routes.js'
import { liveStateOf, type LiveRunnerLike } from './host-live.js'
import { installSessionPort } from '../sessions/session-port.js'
import { rowOwnedHere } from '../sessions/session-row-owner.js'
import { hasLocalDaemon, isHostReplica } from '../server-role.js'
import type { SessionRecord } from '../types.js'

export interface HostSessions {
  log: FactLog
  channel: HostChannel
  emitter: HostEmitter
  routes: HostSessionRoutes
  bundles: StartBundles
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

/** Can this host replica run sessions itself (see the header)? */
export function hostCanRunSessions(env: NodeJS.ProcessEnv = process.env): boolean {
  return isHostReplica() && (hasLocalDaemon() || env.WALNUT_IN_PROCESS_DAEMON === '1')
}

export interface StartHostSessionsOptions {
  walnutId: string
  hostKey: string
  /** This host's own state dir (the fact log and spilled prompts go under it). */
  stateDir: string
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
  const dir = path.join(o.stateDir, 'session-channel')
  const log = await FactLog.open({ dir, walnutId: o.walnutId, log: say })
  // The copy's store is read only here: rows of this host's own sessions go through the own-row writer.
  const { allowOwnRowWrites } = await import('../session-db.js')
  allowOwnRowWrites(o.hostKey)
  const channel = new HostChannel({ log, walnutId: o.walnutId, hostId: o.hostKey, ownRows: () => ownRows(o.hostKey), onLog: say })
  const { sessionRunner } = await import('../../providers/claude-code-session.js')
  const runner = sessionRunner as unknown as LiveRunnerLike & { findSessionByClaudeId(sid: string): { consumedOffset?: number } | undefined }
  const bundles = new StartBundles()
  const emitter = createHostEmitter({
    log, channel, hostKey: o.hostKey,
    ownRows: () => ownRows(o.hostKey),
    liveOf: (sid) => liveStateOf(runner, sid),
    offsetOf: (sid) => runner.findSessionByClaudeId(sid)?.consumedOffset,
    onLog: say,
  })
  installSessionPort(createHostSessionPort({
    hostKey: o.hostKey, bundles, api: selfOwnApi,
    sessionOfTask: (taskId) => emitter.ownSessionOfTask(taskId),
    onRename: (from, to) => emitter.noteRename(from, to),
    onDrop: (sids) => emitter.noteDrop(sids),
    log: say,
  }))
  await emitter.start()
  const [{ hostRunsSessionsNow }, { bus }] = await Promise.all([import('./switch.js'), import('../event-bus.js')])
  const routes = createHostSessionRoutes({
    enabled: hostRunsSessionsNow,
    runner: async () => sessionRunner as never,
    bundles,
    channel: () => current?.channel ?? null,
    emit: (name, data, source) => bus.emit(name, data, ['session-runner'], { source }),
    enqueue: async (sid, lines) => {
      const { enqueueMessage } = await import('../session-message-queue.js')
      for (const l of lines) {
        await enqueueMessage(sid, l.message, {
          ...(l.id ? { id: l.id } : {}), ...(l.userUuid ? { userUuid: l.userUuid } : {}), ...(l.lineUuid ? { lineUuid: l.lineUuid } : {}),
          ...(l.closesPrompt ? { closesPrompt: true } : {}), ...(l.sentBy ? { sentBy: l.sentBy } : {}),
        })
      }
    },
    spillDir: path.join(dir, 'prompts'),
    log: say,
  })
  current = { log, channel, emitter, routes, bundles }
  say('info', 'host sessions: this host runs and judges its sessions', { hostKey: o.hostKey, logId: log.logId, head: log.head })
  return current
}

export async function stopHostSessions(): Promise<void> {
  const c = current
  current = null
  if (!c) return
  c.emitter.stop()
  c.routes.close()
  installSessionPort(null)
  const { allowOwnRowWrites } = await import('../session-db.js')
  allowOwnRowWrites(null)
  await c.log.close()
}
