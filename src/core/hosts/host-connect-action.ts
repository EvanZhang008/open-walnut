/**
 * The ONE server side of every "connect this host now" and "is it ready now"
 * button (C28): Settings' Connect / Retry (POST /api/hosts/:host/connect), the
 * picker's and banner's Retry (POST /api/sessions/host-retry, same function),
 * the Start gate's fresh redial, and Check again (POST /api/hosts/:host/check).
 * Also the one place that builds a host's live frame, so the fixture, the
 * ephemeral "off" answer and the warmup's credential clock reach every surface
 * through the same code.
 */

import { CLOUD_MODE, IS_EPHEMERAL } from '../../constants.js'
import { log } from '../../logging/index.js'
import { bus, EventNames } from '../event-bus.js'
import {
  clearDaemonFailureCache, expediteReconnect, getDaemonConnectState, getDaemonConnection, reconnectHostNow, reconnectingHosts,
} from '../../providers/daemon-connection.js'
import { buildHostStatus, type HostDef, type HostStatus } from './host-status.js'
import { getHostWarmup } from './host-warmup-registry.js'
import { getHostReadiness, refreshHostReadiness, resetHostAutofixAttempts, type HostReadiness } from './host-readiness.js'
import { REMOTE_OFF_NOTE } from './host-problem.js'
import {
  bumpFixtureCounter, fixtureConnectAttempt, fixtureEphemeral, fixtureHost, fixtureHostStatus, fixtureNow,
  hostFixtureMode, isFixtureHost, seedFixtureReadiness,
} from './host-fixture.js'
import { maybeStartFixtureAutofix } from './host-fixture-autofix.js'

export type ConfigHostDef = HostDef & { shell_setup?: string }

/** An ephemeral test server refuses remote hosts by design (daemon-connection.ts ephemeralRemoteRefused). */
export function remoteHostsOff(): boolean {
  if (hostFixtureMode() && fixtureEphemeral()) return true
  return IS_EPHEMERAL && process.env.WALNUT_EPHEMERAL_REMOTE_HOSTS !== '1'
}

/** The live frame for one configured host (fixture, off, or the real connection + warmup + readiness). */
export function hostStatusFrame(host: string, def: HostDef, now: number = Date.now()): HostStatus {
  if (isFixtureHost(host)) {
    const s = fixtureHostStatus(host, def)
    if (s) return s
  }
  const warmup = getHostWarmup()
  const credentialRetryAt = warmup?.credentialRetryAt(host)
  return buildHostStatus(host, def, getDaemonConnectState(host), warmup?.stateOf(host), now, getHostReadiness(host), {
    off: remoteHostsOff(), ...(credentialRetryAt ? { credentialRetryAt } : {}),
  })
}

/** Push a host's frame on the existing HOST_STATUS event. Disabled hosts are never pushed. */
export function pushHostFrame(host: string, def: HostDef | undefined): void {
  if (!host || host === '__local__' || !def || def.enabled === false) return
  try {
    bus.emit(EventNames.HOST_STATUS, hostStatusFrame(host, def), ['web-ui'])
  } catch { /* a status push must never break a connect */ }
}

/** The host left Settings (removed or disabled): every surface drops it live. */
export function pushHostRemoved(host: string, now: number = hostFixtureMode() ? fixtureNow() : Date.now()): void {
  bus.emit(EventNames.HOST_STATUS, { host, removed: true, at: now, serverNow: now } as never, ['web-ui'])
}

export async function configHostDef(host: string): Promise<ConfigHostDef | undefined> {
  const { getConfig } = await import('../config-manager.js')
  const hosts = (await getConfig()).hosts ?? {}
  // hasOwn, not `hosts[host]`: `__proto__` / `constructor` are truthy lookups.
  return Object.hasOwn(hosts, host) ? hosts[host] as ConfigHostDef : undefined
}

export type ConnectOutcome = 'connected' | 'failed' | 'timeout' | 'started'

export interface ConnectNowResult {
  httpStatus: number
  body: Record<string, unknown>
  outcome?: ConnectOutcome
  status?: HostStatus
}

function refuse(httpStatus: number, error: string, code?: string): ConnectNowResult {
  return { httpStatus, body: { error, ...(code ? { code } : {}) } }
}

/** Resolve within `ms` with the attempt's outcome; the attempt itself keeps running. */
function withinDeadline(attempt: Promise<unknown>, ms: number): Promise<ConnectOutcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ConnectOutcome>((resolve) => { timer = setTimeout(() => resolve('timeout'), ms) })
  const settled = attempt.then(() => 'connected' as const, () => 'failed' as const)
  return Promise.race([settled, timeout]).finally(() => clearTimeout(timer))
}

/**
 * A human asked to connect now. Every caller (Settings, picker, banner, the
 * Start gate) runs exactly this: the enabled check, the failure cache cleared
 * (it throttles AUTOMATIC retries, never a deliberate one), every automatic
 * fix allowed once more, then the dial itself (a host in its reconnect loop
 * runs the loop's attempt now and keeps the loop), and a fresh readiness check
 * once connected. Automation never calls this (host-start-gate.ts `source`).
 * `deadlineMs`: wait for the attempt (the Start gate); otherwise it only starts it.
 */
export async function connectHostNow(host: string, opts: { deadlineMs?: number } = {}): Promise<ConnectNowResult> {
  if (!host || host === '__local__') return refuse(400, 'host is required')
  if (CLOUD_MODE) return refuse(409, 'a cloud replica cannot connect to hosts; run this on the primary')
  const def = await configHostDef(host)
  if (!def) return refuse(404, `Unknown host: ${host}`)
  // The warmup would skip it silently and the button would look dead.
  if (def.enabled === false) return refuse(409, `${host} is disabled; enable it in Settings > Remote Hosts first`, 'host_disabled')

  if (isFixtureHost(host)) {
    // The same prelude as a real host (the counter is the spec's evidence, C46),
    // then the fixture answers the dial instead of ssh.
    clearDaemonFailureCache(host)
    bumpFixtureCounter('failureCacheCleared', host)
    resetHostAutofixAttempts(host)
    log.session.info('host connect now', { host, fixture: true, failureCacheCleared: true, awaited: !!opts.deadlineMs })
    const r = fixtureConnectAttempt(host)
    if (r.connected) {
      seedFixtureReadiness(host)
      // Connected with a fixable problem: the real refresh would start the automatic fix now.
      if (!opts.deadlineMs) maybeStartFixtureAutofix(host, () => pushHostFrame(host, def))
    }
    const status = hostStatusFrame(host, def)
    pushHostFrame(host, def)
    return { httpStatus: 200, body: { ok: true, status }, outcome: r.connected ? 'connected' : 'failed', status }
  }
  if (remoteHostsOff()) return refuse(409, REMOTE_OFF_NOTE, 'host_off')

  clearDaemonFailureCache(host)
  resetHostAutofixAttempts(host)
  const target = { hostname: def.hostname, user: def.user, port: def.port }
  const before = getDaemonConnectState(host).phase
  // The reconnect loop owns the host: its attempt runs now, and a failure puts
  // the loop back on its schedule. Cancelling the loop and calling connect()
  // instead ended recovery for good the first time that dial failed.
  const joined = reconnectHostNow(host, target)
  log.session.info('host connect now', { host, failureCacheCleared: true, joinedReconnect: !!joined, phase: before, awaited: !!opts.deadlineMs })

  const warmup = getHostWarmup()
  let outcome: ConnectOutcome = 'started'
  if (joined) {
    if (opts.deadlineMs) outcome = await withinDeadline(joined, opts.deadlineMs)
    else joined.catch(() => { /* the loop recorded the cause and rescheduled */ })
  } else if (opts.deadlineMs) {
    outcome = await withinDeadline(getDaemonConnection(host, target), opts.deadlineMs)
  } else if (warmup && before !== 'reconnecting') {
    // Resolves once the host is QUEUED, so the reply already says so.
    await warmup.kick(host).catch(() => { /* kick never rejects */ })
  } else {
    getDaemonConnection(host, target).catch(() => { /* recorded in the failure cache and pushed */ })
  }

  const state = getDaemonConnectState(host)
  // Connected: the human is asking "is it ready now?" (they just installed claude).
  if (state.connected && !opts.deadlineMs) void refreshHostReadiness(host, { force: true })
  const status = hostStatusFrame(host, def)
  return { httpStatus: 200, body: { ok: true, status }, outcome: state.connected ? 'connected' : outcome, status }
}

/**
 * Check again: re-run the host's readiness probe now (force), and answer with
 * the fresh frame. `deadlineMs` caps the wait; the cached answer stands when it
 * runs out (the probe keeps going and pushes when it lands).
 */
export async function checkHostNow(host: string, opts: { deadlineMs?: number; force?: boolean } = {}): Promise<HostReadiness | null> {
  if (isFixtureHost(host)) {
    bumpFixtureCounter('check', host)
    const slow = fixtureHost(host)?.checkDelayMs ?? 0
    if (slow > 0) await new Promise((r) => setTimeout(r, Math.min(slow, opts.deadlineMs ?? slow)))
    return seedFixtureReadiness(host, { withShellSetup: true }) ? getHostReadiness(host) ?? null : null
  }
  const job = refreshHostReadiness(host, { force: opts.force !== false })
  if (!opts.deadlineMs) return job
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), opts.deadlineMs) })
  const answer = await Promise.race([job, late]).finally(() => clearTimeout(timer))
  return answer ?? getHostReadiness(host) ?? null
}

// ── Folder listing: which hosts list-dirs may dial ──

export type ListDirsRoute =
  | { kind: 'dial' }
  /** Answered without any connection (off on a test server, relayed from a replica). */
  | { kind: 'answer'; result: ListDirsAnswer }
  /** A fixture host: its "connection" is the MockDaemon, its state the fixture's. */
  | { kind: 'fixture'; connect: () => Promise<DaemonLsLike>; state: (host: string) => DaemonConnectState }

type ListDirsAnswer = import('../sessions/session-extras.js').ListDirsResult
type DaemonLsLike = { send(command: string, params: Record<string, unknown>): Promise<Record<string, unknown>> }
type DaemonConnectState = import('../../providers/daemon-connection.js').DaemonConnectState

/**
 * list-dirs must never be the thing that dials a host this server should not
 * reach: an ephemeral test server answers `hostError.kind 'ephemeral'` (no
 * DaemonConnection at all, C23), a replica relays `server.list-dirs` to the
 * primary exactly like the v1 route (C25), a fixture host lists through the
 * MockDaemon.
 */
export async function listDirsRoute(
  host: string, input: { prefix: string; depth: number; pending?: boolean; waitMs?: number },
): Promise<ListDirsRoute> {
  const path = await import('node:path')
  const dir = input.prefix.endsWith('/') ? input.prefix : path.dirname(input.prefix)
  // A fixture host answers for itself first: the Playwright server is itself
  // ephemeral, and only an ephemeral FIXTURE turns its hosts off.
  if (isFixtureHost(host) && !fixtureEphemeral()) {
    const { fixtureConnectState, fixtureListConnection } = await import('./host-fixture.js')
    bumpFixtureCounter('listDirs', host)
    return { kind: 'fixture', connect: () => fixtureListConnection(host), state: (h) => fixtureConnectState(h) ?? getDaemonConnectState(h) }
  }
  if (remoteHostsOff()) {
    return { kind: 'answer', result: { dirs: [], parent: dir, exists: true, hostError: { message: REMOTE_OFF_NOTE, kind: 'ephemeral', hint: '', retryable: false } } }
  }
  if (!CLOUD_MODE) return { kind: 'dial' }
  const { callPrimaryControl } = await import('../../web/routes/v1-control-relay.js')
  const r = await callPrimaryControl('server.list-dirs', '__server__', {
    prefix: input.prefix, host, depth: input.depth, ...(input.pending ? { pending: true } : {}),
    ...(typeof input.waitMs === 'number' ? { waitMs: input.waitMs } : {}),
  }, 20_000)
  if (r.ok) return { kind: 'answer', result: r.result as unknown as ListDirsAnswer }
  const { SessionControlError } = await import('../sessions/session-controls.js')
  if (!input.pending) throw new SessionControlError(r.failure.message, 400)
  return { kind: 'answer', result: { dirs: [], parent: dir, exists: true, hostError: { message: r.failure.message, kind: 'unknown', hint: 'The computer running Walnut is not reachable from here right now.', retryable: true } } }
}

// ── Wake / network change: redial what is down, once (C51) ──

/**
 * Server wiring for host-wake-signal.ts: each signal redials every enabled
 * host that is failed or reconnecting, once. A pending reconnect runs now
 * (keeping its backoff place); a failed first connect is handed to the warmup.
 */
/** One host's redial on a wake or network signal: the loop's attempt now, else one warmup dial. */
export function redialAfterWake(host: string): void {
  if (expediteReconnect(host)) return
  // No warmup, no redial: clearing the cache alone made the failure vanish
  // from every surface while nothing tried again.
  const warmup = getHostWarmup()
  if (!warmup) return
  clearDaemonFailureCache(host)
  void warmup.kick(host).catch(() => { /* kick never rejects */ })
}

export async function startHostWakeRedial(hosts: () => Record<string, HostDef>): Promise<() => void> {
  const { startHostWakeSignal } = await import('./host-wake-signal.js')
  const sig = startHostWakeSignal({
    hostsToRedial: () => {
      const defs = hosts()
      const enabled = (h: string) => Object.hasOwn(defs, h) && defs[h].enabled !== false
      const failed = Object.keys(defs).filter((h) => h !== '__local__' && enabled(h) && getDaemonConnectState(h).phase === 'failed')
      return [...reconnectingHosts().filter(enabled), ...failed]
    },
    redial: redialAfterWake,
  })
  return sig.stop
}
