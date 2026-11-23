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
 *     the companion still sends from its old lead is refused. Under the leader
 *     switch's write permission the claim waits until this server may act (a
 *     restart after a switch rolled back boots waiting for its earlier handover
 *     to run out): a host never follows a leader whose permit record does not stand.
 */

import { IS_EPHEMERAL, WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { LEADER_HEARTBEAT_KIND, LEADER_HEARTBEAT_MS, LEADER_RESTART_GRACE_MS, type LeaderHeartbeatFrame } from './protocol.js'
import { isFollower } from '../server-role.js'
import { doorsClosed, onceOutwardDoorsOpened } from './switch/doors.js'

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
  if (isFollower()) return false
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
  const { hostRunsSessionsAnyNow } = await import('../session-channel/switch.js')
  return {
    walnutId: await walnutId(),
    backup: await backupLeaderAllowed(),
    ...(restartingMs ? { restartingMs } : {}),
    ...(await hostRunsSessionsAnyNow() ? { hostRunsSessions: true as const } : {}),
  }
}

/** One heartbeat down the bridge. False when there is no bridge lane right now. */
export async function sendLeaderHeartbeat(restartingMs?: number): Promise<boolean> {
  if (isFollower()) return false
  const { forwardMobileEventToBridge } = await import('../../web/routes/events-v1.js')
  return forwardMobileEventToBridge(LEADER_HEARTBEAT_KIND, await heartbeatFrame(restartingMs))
}

let heartbeatTimer: ReturnType<typeof setInterval> | null = null

export function startLeaderHeartbeat(): { stop: () => void } {
  if (isFollower()) return { stop: () => {} }
  const n = Number(process.env.WALNUT_LEADER_HEARTBEAT_MS)
  const every = Number.isFinite(n) && n >= 100 ? Math.floor(n) : LEADER_HEARTBEAT_MS
  const beat = () => { void sendLeaderHeartbeat().catch(() => { /* the next one lands */ }) }
  if (heartbeatTimer) clearInterval(heartbeatTimer)
  heartbeatTimer = setInterval(beat, every)
  heartbeatTimer.unref?.()
  beat()
  return { stop: () => { if (heartbeatTimer) clearInterval(heartbeatTimer); heartbeatTimer = null } }
}

/** Whether this process beats its regular heartbeat now (startLeaderHeartbeat ran, nothing stopped it). */
export function leaderHeartbeatRunning(): boolean {
  return heartbeatTimer !== null
}

/** The leader switch's stop: what the restart notice says instead of the grace (setRestartNotice). */
let nextRestartMs: number | null = null

/**
 * The restart notice of this process's stop says `ms` (capped at LEADER_RESTART_GRACE_MS, the
 * field's cap here; the companion caps it again at its own 10 minutes) instead of the grace: the
 * leader switch sets its commit window before the old leader's stop, so the companion's backup lead
 * holds off while the new leader commits (core/leader/switch/host-follow.ts). Null: the grace again.
 * A hint, not a safety argument: the hosts' fences decide who leads them.
 */
export function setRestartNotice(ms: number | null): number | null {
  nextRestartMs = ms === null || !Number.isFinite(ms) || ms <= 0 ? null : Math.min(Math.floor(ms), LEADER_RESTART_GRACE_MS)
  return nextRestartMs
}

/**
 * Tell the companion this box is going down for a restart (graceful shutdown),
 * so it waits LEADER_RESTART_GRACE_MS before it would take the lead. Bounded:
 * a shutdown never waits on a slow bridge.
 */
export async function announceLeaderRestart(maxWaitMs = 1_500): Promise<void> {
  if (isFollower()) return
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null }
  // WALNUT_LEADER_RESTART_GRACE_MS: the live tests' shorter grace, as WALNUT_LEADER_HEARTBEAT_MS.
  const n = Number(process.env.WALNUT_LEADER_RESTART_GRACE_MS)
  const grace = nextRestartMs ?? (Number.isFinite(n) && n >= 1_000 ? Math.floor(n) : LEADER_RESTART_GRACE_MS)
  await Promise.race([
    sendLeaderHeartbeat(grace).catch(() => false),
    new Promise((r) => { const t = setTimeout(r, maxWaitMs); t.unref?.() }),
  ])
}

/**
 * A change of `cloud_bridge.backup_leader` reaches every host (the next
 * leader.configure carries it) and the companion (the next heartbeat) at
 * once, not on the next reconnect. Returns the stop.
 */
export function watchBackupLeaderSetting(): () => void {
  if (isFollower()) return () => {}
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
  /**
   * The home the host keeps this Walnut under when a declared move made this data dir its alias
   * there (leader.configure's `homeHere`), else null: the name the host's own service and its mode
   * file use for this Walnut (one-service-mode.ts).
   */
  noteHomeHere?(home: string | null): void
}

/**
 * How this Walnut describes itself to a host (leader.configure). `formerHomes`: the data dirs it
 * declares it moved from, newest first (home-move.ts, under the one-service experiment only); the
 * first goes as `movedFrom` too.
 */
async function leaderDescription(formerHomes: string[] | null): Promise<Record<string, unknown>> {
  const backup = await backupLeaderAllowed()
  // `drains`: the journal v2 kinds this Mac applies (journal-v2); a daemon writes them only then.
  const { MAC_DRAINS } = await import('../offline-merge/apply-v2.js')
  const id = await walnutId()
  // An id this process keeps in memory only names no Walnut a host may continue (walnut-scope-core.ts).
  const { isVolatileInstanceId } = await import('../device-auth.js')
  const volatile = isVolatileInstanceId(id) ? { walnutIdVolatile: true } : {}
  const move = formerHomes && formerHomes.length > 0 ? { movedFrom: formerHomes[0], formerHomes } : {}
  return { home: WALNUT_HOME, walnutId: id, backup, drains: [...MAC_DRAINS], ...volatile, ...move }
}

/**
 * A Walnut whose data dir moved tells a host first, before any other frame of the connect
 * (daemon-connection.ts holds them for this), so the host keys everything that follows by the
 * Walnut's first home there: no set, copy or journal drain ever lands under the new path.
 * Sends nothing when no move is declared. It goes before the offline handover; that is safe:
 * the host answers a session's call itself while its journal still holds what the Mac has not
 * taken (offline-host-core.ts pendingHandover), as it does after the host.slice probe binds.
 */
export async function declareHomeMove(conn: LeaderHostConnection): Promise<void> {
  const { homeMoveToDeclare } = await import('../home-move.js')
  const formers = await homeMoveToDeclare()
  if (!formers) return
  const reply = await describeTo(conn, formers)
  await noteHomeAnswer(conn, reply, true)
}

/**
 * leader.configure, once more when the host refused a declared move because another copy of this
 * Walnut declared one there first (walnut_home_busy: it is where the Walnut is now there, at
 * `movedTo`, a data dir on this machine, since a move is declared only from the machine its
 * record names). When that folder no longer holds this Walnut's id (deleted, renamed, or another
 * Walnut's now), that copy is gone: the description goes again naming it (`copyGone`), and the
 * host gives this copy the place (walnut-scope-core.ts declareMove). Two live copies stay as the
 * host has them: a person picks one (the Health item says how, home-busy-health.ts).
 */
async function describeTo(conn: LeaderHostConnection, formers: string[] | null): Promise<Record<string, unknown>> {
  const description = await leaderDescription(formers)
  const reply = await conn.send('leader.configure', description, 15_000)
  const at = reply.movedTo
  if (!formers || reply.errorKind !== 'walnut_home_busy' || typeof at !== 'string' || !at.startsWith('/') || at === WALNUT_HOME) return reply
  if (description.walnutIdVolatile === true || typeof description.walnutId !== 'string') return reply
  const { walnutGoneAt } = await import('../device-store.js')
  if (!(await walnutGoneAt(at, description.walnutId))) return reply
  log.leader.info('home move: the copy of this Walnut a host follows is gone from this machine; this copy takes its place', { host: conn.hostKey, gone: at })
  return conn.send('leader.configure', { ...description, copyGone: at }, 15_000)
}

/** A host's `homeHere` (an absolute path other than this data dir), else null. */
function homeHereOf(reply: Record<string, unknown>): string | null {
  const h = reply.homeHere
  return typeof h === 'string' && h.startsWith('/') && h.length <= 1024 && !/[\u0000-\u001f]/.test(h) && h !== WALNUT_HOME ? h : null
}

/**
 * What a host said of this Walnut's description, as Walnut Health items (home-busy-health.ts): it
 * refused this data dir (the Walnut moved elsewhere there, or another Walnut left this path), or
 * it took the description but not the declared move. An answer that says neither clears them.
 */
async function noteHomeAnswer(conn: LeaderHostConnection, reply: Record<string, unknown>, declared: boolean): Promise<void> {
  const hostKey = conn.hostKey
  if (reply.ok === true) conn.noteHomeHere?.(homeHereOf(reply))
  const { noteHomeBusy, noteHomeServed, noteMoveNotTaken, noteMoveTaken } = await import('./home-busy-health.js')
  const movedTo = typeof reply.movedTo === 'string' ? reply.movedTo : ''
  if (reply.errorKind === 'walnut_home_busy' || reply.errorKind === 'walnut_home_taken') noteHomeBusy(hostKey, movedTo, reply.errorKind === 'walnut_home_taken' ? 'taken' : declared ? 'contested' : 'busy')
  else if (reply.ok === true) {
    noteHomeServed(hostKey)
    if (declared && typeof reply.moveNotTaken === 'string') noteMoveNotTaken(hostKey, reply.moveNotTaken)
    else if (declared) noteMoveTaken(hostKey)
  }
}

/**
 * Describe the Walnut to one host and hold the lead there. Runs after the
 * offline handover, so what the host did alone is already taken back (a declared home move
 * went first, declareHomeMove). With the one-service experiment known off it waits on nothing
 * of the home move.
 */
export async function configureHostLeader(conn: LeaderHostConnection): Promise<HostLeaderState | null> {
  const { homeMoveToDeclare, settledHomeMove } = await import('../home-move.js')
  const known = settledHomeMove()
  // Known: no wait (with the experiment off, the record is still kept in the background).
  if (known === null) void homeMoveToDeclare()
  const formers = known === undefined ? await homeMoveToDeclare() : known
  const reply = await describeTo(conn, formers)
  await noteHomeAnswer(conn, reply, !!formers)
  if (reply.ok !== true) {
    log.leader.warn('leader: host refused the Walnut description', { host: conn.hostKey, error: String(reply.error ?? '') })
    return null
  }
  let state: HostLeaderState = {
    epoch: Number(reply.epoch) || 0,
    holder: reply.holder === 'backup' ? 'backup' : 'primary',
    at: new Date().toISOString(),
  }
  if (state.holder === 'backup' && doorsClosed()) {
    // The companion leads this host and this server may not act yet: the host stays with the
    // backup, and the lead is taken back the moment the permission stands (described again then).
    onceOutwardDoorsOpened(`leader-claim:${conn.hostKey}`, () => {
      void configureHostLeader(conn).catch((err: unknown) => log.leader.warn('leader: taking the lead back once this server may act failed', { host: conn.hostKey, error: err instanceof Error ? err.message : String(err) }))
    })
    log.leader.info('leader: the cloud companion leads this host; the lead is taken back once this server holds the write permission', { host: conn.hostKey, epoch: state.epoch })
  } else if (state.holder === 'backup') {
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
