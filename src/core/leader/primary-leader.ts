/**
 * The primary's side of who leads a Walnut (docs/plan/walnut-control-plane.md).
 * Primary box only.
 *
 *   - Every 15s it tells the cloud companion it is alive (a `leader-heartbeat`
 *     frame down its own bridge), and before a planned restart it says how
 *     long it will be gone, so a deploy never hands the lead over.
 *   - On every (re)connect to a host's daemon, after taking back what the host
 *     did alone (the offline handover), it describes the Walnut to that host
 *     (`leader.configure`: its data dir, its id, whether the companion may
 *     lead) and, when the companion holds the lead there, takes it back
 *     (`leader.claim`). The host's leader book raises the epoch, so anything
 *     the companion still sends from its old lead is refused.
 */

import { CLOUD_MODE, IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { LEADER_HEARTBEAT_KIND, LEADER_HEARTBEAT_MS, LEADER_RESTART_GRACE_MS, type LeaderHeartbeatFrame } from './protocol.js'

export interface HostLeaderState {
  epoch: number
  holder: 'primary' | 'backup'
  at: string
  /** Set when this connect took the lead back from the companion. */
  tookBackAt?: string
  backupLedMs?: number
}

const hostState = new Map<string, HostLeaderState>()

/** Whether the companion may lead while this box is away (config, default on). */
export async function backupLeaderAllowed(): Promise<boolean> {
  if (CLOUD_MODE) return false
  // A test server over copied data never lets anything lead the user's hosts;
  // a test that builds its own companion says so explicitly.
  if (IS_EPHEMERAL) return process.env.WALNUT_EPHEMERAL_BACKUP_LEADER === '1'
  try {
    const { getConfig } = await import('../config-manager.js')
    return (await getConfig()).cloud_bridge?.backup_leader !== false
  } catch {
    return true
  }
}

async function walnutId(): Promise<string> {
  const { getInstanceId } = await import('../device-auth.js')
  return getInstanceId()
}

async function heartbeatFrame(restartingMs?: number): Promise<LeaderHeartbeatFrame> {
  return {
    walnutId: await walnutId(),
    backup: await backupLeaderAllowed(),
    ...(restartingMs ? { restartingMs } : {}),
  }
}

/** One heartbeat down the bridge. False when there is no bridge lane right now. */
export async function sendLeaderHeartbeat(restartingMs?: number): Promise<boolean> {
  if (CLOUD_MODE) return false
  const { forwardMobileEventToBridge } = await import('../../web/routes/events-v1.js')
  return forwardMobileEventToBridge(LEADER_HEARTBEAT_KIND, await heartbeatFrame(restartingMs))
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function startLeaderHeartbeat(): { stop: () => void } {
  if (CLOUD_MODE) return { stop: () => {} }
  const n = Number(process.env.WALNUT_LEADER_HEARTBEAT_MS)
  const every = Number.isFinite(n) && n >= 100 ? Math.floor(n) : LEADER_HEARTBEAT_MS
  const beat = () => { void sendLeaderHeartbeat().catch(() => { /* the next one lands */ }) }
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(beat, every)
  heartbeatTimer.unref?.()
  beat()
  return { stop: () => { if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = null } }
}

/**
 * Tell the companion this box is going down for a restart (graceful shutdown),
 * so it waits LEADER_RESTART_GRACE_MS before it would take the lead. Bounded:
 * a shutdown never waits on a slow bridge.
 */
export async function announceLeaderRestart(maxWaitMs = 1_500): Promise<void> {
  if (CLOUD_MODE) return
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  await Promise.race([
    sendLeaderHeartbeat(LEADER_RESTART_GRACE_MS).catch(() => false),
    new Promise((r) => { const t = setTimeout(r, maxWaitMs); t.unref?.() }),
  ])
}

/**
 * A change of `cloud_bridge.backup_leader` reaches every host (the next
 * leader.configure carries it) and the companion (the next heartbeat) at
 * once, not on the next reconnect. Returns the stop.
 */
export function watchBackupLeaderSetting(): () => void {
  if (CLOUD_MODE) return () => {}
  const name = 'leader-backup-setting'
  let last: boolean | null = null
  void backupLeaderAllowed().then((v) => { if (last === null) last = v })
  void import('../event-bus.js').then(({ bus, EventNames }) => {
    bus.subscribe(name, async (event) => {
      if (event.name !== EventNames.CONFIG_CHANGED) return
      const now = await backupLeaderAllowed()
      if (now === last) return
      last = now
      log.leader.info('leader: the companion may lead while this box is away: ' + (now ? 'yes' : 'no'))
      const { refreshLeaderOnAllHosts } = await import('../../providers/daemon-connection.js')
      refreshLeaderOnAllHosts()
      void sendLeaderHeartbeat().catch(() => { /* the next one lands */ })
    }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
  })
  return () => { void import('../event-bus.js').then(({ bus }) => bus.unsubscribe(name)) }
}

/** What a daemon connection needs to describe the Walnut and take the lead. */
export interface LeaderHostConnection {
  hostKey: string
  send(cmd: string, params?: Record<string, unknown>, timeoutMs?: number): Promise<Record<string, unknown>>
}

/**
 * Describe the Walnut to one host and hold the lead there. Runs after the
 * offline handover, so what the host did alone is already taken back.
 */
export async function configureHostLeader(conn: LeaderHostConnection): Promise<HostLeaderState | null> {
  const backup = await backupLeaderAllowed()
  const reply = await conn.send('leader.configure', { home: WALNUT_HOME, walnutId: await walnutId(), backup }, 15_000)
  if (reply.ok !== true) {
    log.leader.warn('leader: host refused the Walnut description', { host: conn.hostKey, error: String(reply.error ?? '') })
    return null
  }
  let state: HostLeaderState = {
    epoch: Number(reply.epoch) || 0,
    holder: reply.holder === 'backup' ? 'backup' : 'primary',
    at: new Date().toISOString(),
  }
  if (state.holder === 'backup') {
    const since = typeof reply.since === 'number' ? reply.since : Date.now()
    const claim = await conn.send('leader.claim', { home: WALNUT_HOME }, 15_000)
    if (claim.ok !== true) throw new Error(`leader.claim refused: ${String(claim.error ?? '')}`)
    state = {
      epoch: Number(claim.epoch) || state.epoch + 1,
      holder: 'primary',
      at: new Date().toISOString(),
      tookBackAt: new Date().toISOString(),
      backupLedMs: Math.max(0, Date.now() - since),
    }
    log.leader.info('leader: took the lead back from the cloud companion', { host: conn.hostKey, epoch: state.epoch, backupLedMs: state.backupLedMs })
  }
  hostState.set(conn.hostKey, state)
  return state
}

/** Per host: the last lead this box saw or took (status, tests). */
export function hostLeaderStates(): Record<string, HostLeaderState> {
  return Object.fromEntries(hostState)
}
