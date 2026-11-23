/**
 * A machine on the host network (`transport: net`) gets this server's daemon build
 * the way an SSH host does, only over the daemon link itself: there is no SSH to
 * it, and nothing on the machine updates its daemon by itself (2026-11-03: a joined
 * Mac ran a daemon 8 hours older than the server, and a fix that lived in the
 * daemon never reached it).
 *
 * When such a host connects with a daemon of another build, and that daemon is a
 * service Walnut may update (a user or cron service, the only scopes the server
 * updates on any host), the server uploads this build's daemon for the host's
 * target and runs `walnut daemon update` there (daemon-service-update.ts through
 * daemon-net-update-io.ts). The daemon is the prebuilt binary in dist/daemon-binaries
 * when this build has one for the target, else, on a compiled server (singleFile(),
 * which ships no daemon binaries), the host's walnut file of this build
 * (host-file.ts), as the SSH path's deployWalnutFile uses: it answers
 * `__daemon --version` with the daemon build. Either way the host checks the upload's
 * sha256 and that version before the service is touched. The same guards as the SSH path: never from a
 * test server, never `__local__`, never while a write is in flight, one attempt per
 * build in UPGRADE_RETRY_COOLDOWN_MS (then again later, waiting longer each time, and
 * no more automatic tries of a build after MAX_AUTO_FAILURES).
 *
 * Contested: once this server put its build there, a connect with another build means
 * something on that machine put its own back (its own Walnut's LocalDaemon updates the
 * same service to its build on every reconnect). Updating again would swap the service
 * back and forth, so the automatic update stops for that build and says so once.
 *
 * A host whose config says `autofix: false` (or a server with WALNUT_HOST_AUTOFIX=0)
 * is held: someone guards that machine and picks the moment. The hold is logged once
 * per build, and the update runs on request (`host_daemon_update`, this file's
 * `request`). WALNUT_NET_DAEMON_UPDATE=0 turns the automatic update off.
 *
 * The host's mode (one-service-mode.ts) rides this update as it rides the SSH one: a switch due on
 * the current build is an update of its own, every update carries the `--serve`/`--no-serve` words,
 * and `--serve` sends the walnut file (it holds the server), never the daemon-only binary
 * (2026-11-22: a mode due on a host network machine went to the SSH check and failed every minute).
 */
import { daemonBusyRefusal, execRunsHold } from './exec-runs-hold.js'
import { ACP_BUSY_FILE, acpTurnsHold, acpTurnsReason } from './acp-upgrade-hold.js'
import { daemonUpdateOverdue, OVERDUE_GATE_WAIT_MS } from './daemon-update-behind.js'
import { daemonUpdateGapWhy, daemonUpdateMinGapMs, daemonUpdateWaitMs } from './daemon-update-gap.js'
import { log } from '../logging/index.js'
import { HoldNews, holdLog } from './daemon-hold-news.js'
import type { HostFileTarget } from '../core/host-server/host-target.js'
import { updateRemoteDaemonService } from './daemon-service-update.js'
import { sharedDaemonVerdict, walnutKeyOf, type DaemonServes } from './daemon-shared.js'
import { WALNUT_HOME } from '../constants.js'
import { netDaemonUpdateTurnedOff } from './daemon-update-paths.js'
import { createNetUpdateIo, netReadText, NetUpdateHeldError, NetUpdateUnansweredError, shq, type NetUpdateConn, type NetUpdateIoOptions } from './daemon-net-update-io.js'
import { LaunchedNetUpdate, type DaemonUpdateView } from './daemon-net-update-record.js'
import { afterUpdateFailure, stageCutByLink } from './daemon-update-readback.js'
import { BUILD_BACKOFF_MS, buildBackedOff, readBuildBackoff, writeBuildBackoff, type BuildBackoffEntry } from './daemon-build-backoff.js'
import type { DaemonLinkKind } from './daemon-update-paths.js'
import type { ServesAs, ServiceModeAsk } from './one-service-mode.js'
import { netDaemonSource, type NetUpdateSource } from './daemon-net-update-source.js'
import { claimDaemonUpdate, daemonUpdateHeldBy, peerUpdatingWhy } from './daemon-update-claim.js'

export { localDaemonBinary, netDaemonSource, type NetSourceDeps, type NetUpdateSource } from './daemon-net-update-source.js'

export type NetUpdateSkip =
  | 'not-net' | 'local' | 'test-server' | 'follower' | 'no-build-version' | 'current' | 'unmanaged'
  | 'old-daemon' | 'turned-off' | 'held' | 'contested' | 'shared' | 'gave-up' | 'cooldown' | 'recent' | 'platform-unknown' | 'no-binary'
  // The task that asked for it may no longer have it run (its grant was revoked, the host closed).
  | 'refused'

/** Daemon commands the update runs on the host. */
export const NET_UPDATE_CAPABILITIES = ['host-exec-v1', 'fs-write-part-v1', 'service-update-v1'] as const
/** Automatic tries of one build that may fail before only a request tries it again. */
export const MAX_AUTO_FAILURES = 4

/** This build's daemon for the host: a prebuilt binary, the host's walnut file (gzipped), or why there is none. */

export interface NetUpdateFacts {
  kind: DaemonLinkKind
  host: string
  /** An ephemeral server, or one that only reads a host the real Walnut shares. */
  testServer: boolean
  /** A follower (the companion, a host server): it may run another build than the leader. */
  follower: boolean
  expected: string | null
  /** The daemon's own build, from its hello. */
  running: string | null
  /** hello cronSupervision.startup: 'service' for a daemon an OS service runs. */
  startup: string
  serviceExecutable: string | null
  has: (capability: string) => boolean
  /** autofixDisabledReason: 'config' (the host's `autofix: false`), 'env', or null. */
  autofixOff: string | null
  /** WALNUT_NET_DAEMON_UPDATE=0. */
  turnedOff: boolean
  /** Someone asked for it (host_daemon_update): no autofix hold, no cooldown. */
  requested: boolean
  lastAttempt: { expected: string; at: number } | null
  /** This server put `expected` there, and the host came back on another build since. */
  contested?: boolean
  /** Why the running daemon is kept: another Walnut uses it and this build brings nothing it lacks (daemon-shared.ts). */
  shared?: string | null
  /** Automatic tries of `expected` that failed. */
  failedTries?: number
  now: number
  cooldownMs: number
  /** How long the running daemon has run (its hello's startedAt), and the gap between replacements (daemon-update-gap.ts). */
  daemonAgeMs?: number | null
  minGapMs?: number
  /** How long this build's update has been held by the gap already (it waits one gap at most). */
  gapHeldForMs?: number
  /** A switch of the host's mode alone is due (one-service-mode.ts serviceModeDue): an update on the current build. */
  modeDue?: boolean
  /** Looked up only when everything above allows an update: undefined = not yet. */
  target?: HostFileTarget | null
  source?: NetUpdateSource | { missing: string }
}

export type NetUpdateDecision =
  | { go: true; source: NetUpdateSource; target: HostFileTarget }
  | { go: 'lookup' }
  | { go: false; skip: NetUpdateSkip; why: string; retryInMs?: number }

const no = (skip: NetUpdateSkip, why: string, retryInMs?: number): NetUpdateDecision => ({ go: false, skip, why, ...(retryInMs ? { retryInMs } : {}) })

/** Whether this connect updates the host's daemon, from what is known; pure. */
export function decideNetUpdate(f: NetUpdateFacts): NetUpdateDecision {
  if (f.kind === 'local' || f.host === '__local__') return no('local', 'this Mac\'s own daemon is updated by LocalDaemon')
  if (f.kind !== 'net') return no('not-net', `a ${f.kind} host has its own update path (daemon-update-paths.ts)`)
  if (f.testServer) return no('test-server', 'a test server never changes a host\'s daemon')
  if (f.follower) return no('follower', 'only the leader updates a host\'s daemon: two servers of different builds would undo each other')
  if (!f.expected) return no('no-build-version', 'this server runs from source and names no daemon build')
  if (f.running === f.expected && !f.modeDue) return no('current', `its daemon is this build (${f.expected})`)
  if (f.startup !== 'service' || !f.serviceExecutable || !f.has('service-update-v1')) {
    return no('unmanaged', 'its daemon is not a service Walnut can update (no service-update-v1 service)')
  }
  const missing = NET_UPDATE_CAPABILITIES.filter((c) => !f.has(c))
  if (missing.length) return no('old-daemon', `its daemon lacks ${missing.join(', ')}; update Walnut on that machine once`)
  if (!f.requested && f.turnedOff) return no('turned-off', 'WALNUT_NET_DAEMON_UPDATE=0 turns the automatic update off')
  if (!f.requested && f.autofixOff) {
    return no('held', f.autofixOff === 'config'
      ? `the host's setting says autofix: false, so it is updated only on request (host_daemon_update ${f.host})`
      : f.autofixOff === 'config-unreadable'
        ? `the config could not be read, so whether the host allows it is unknown; it is updated only on request (host_daemon_update ${f.host})`
        : `automatic host fixes are off (WALNUT_HOST_AUTOFIX), so it is updated only on request (host_daemon_update ${f.host})`)
  }
  if (!f.requested && f.shared) {
    return no('shared', `${f.shared}, so it keeps running; it is updated on request (host_daemon_update ${f.host})`)
  }
  if (!f.requested && f.contested) {
    return no('contested', `something on that machine (its own Walnut) put another build back after this server updated it to ${f.expected}; `
      + `updating again would swap them back and forth, so it is updated only on request (host_daemon_update ${f.host})`)
  }
  if (!f.requested && (f.failedTries ?? 0) >= MAX_AUTO_FAILURES) {
    return no('gave-up', `${f.failedTries} automatic updates to ${f.expected} failed; it is tried again on request (host_daemon_update ${f.host}) or with the next build`)
  }
  if (!f.requested && f.lastAttempt?.expected === f.expected && f.now - f.lastAttempt.at < f.cooldownMs) {
    return no('cooldown', `an update to ${f.expected} was tried ${Math.round((f.now - f.lastAttempt.at) / 1000)} s ago`,
      f.cooldownMs - (f.now - f.lastAttempt.at))
  }
  // The gap is between builds (as on the SSH path): a switch of the mode alone does not wait for it.
  const gapWait = f.requested || f.running === f.expected ? 0 : daemonUpdateWaitMs(f.daemonAgeMs, f.minGapMs ?? 0, f.gapHeldForMs ?? 0)
  if (gapWait > 0) return no('recent', daemonUpdateGapWhy(f.daemonAgeMs!, gapWait), gapWait)
  if (f.target === undefined || f.source === undefined) return { go: 'lookup' }
  // Both may pass (a probe that timed out, a download that failed): asked again after a cooldown.
  if (!f.target) return no('platform-unknown', 'Walnut does not know which system and processor that machine has', f.cooldownMs)
  if ('missing' in f.source) return no('no-binary', f.source.missing, f.cooldownMs)
  return { go: true, source: f.source, target: f.target }
}

/** The scope `walnut daemon status` names, when Walnut may update it there; pure. */
export function scopeFromStatus(output: string): { scope: 'user' | 'cron' } | { why: string } {
  let s: { installed?: unknown; foreign?: unknown; scope?: unknown }
  try { s = JSON.parse(output.slice(output.indexOf('{'))) } catch { return { why: 'walnut daemon status gave no answer Walnut could read' } }
  if (s.installed !== true) return { why: 'no service of Walnut\'s is installed there' }
  if (s.foreign === true) return { why: 'its service config is not Walnut\'s own' }
  if (s.scope !== 'user' && s.scope !== 'cron') return { why: `its ${String(s.scope)} service needs an administrator` }
  return { scope: s.scope }
}

export interface NetUpdateLink extends NetUpdateConn {
  readonly host: string
  readonly connected: boolean
  readonly daemonVersion: string | null
  readonly daemonStartup: string
  readonly serviceExecutable: string | null
  /** hello `served` (daemon-shared.ts); absent on an older link. */
  readonly daemonServes?: DaemonServes | null
  /** hello `startedAt` (ms epoch on the host); absent on an older link. */
  readonly daemonStartedAt?: number | null
  /** hello `dir`, where the daemon keeps its acp-busy.json; absent on an older link. */
  readonly daemonDir?: string | null
  hasCapability(cap: string): boolean
}

/**
 * Open ACP turns on a host network machine hold its update, as on every other path (an SSH host:
 * DaemonConnection.acpTurnsOpen; this Mac: local-daemon.ts): the swap ends a running Codex turn.
 * The daemon's acp-busy.json is read over the link (fs.read), judged by the one reader and the one
 * clock (acp-upgrade-hold.ts: a turn open past ACP_UPGRADE_HOLD_MAX_MS no longer holds it). Null
 * when none is open, or when the file cannot be read (an update is never held on a guess).
 */
export async function acpTurnsHoldOverLink(c: NetUpdateLink, now: number = Date.now()): Promise<string | null> {
  if (!c.connected || !c.daemonDir) return null
  const raw = await netReadText(c)(`${c.daemonDir.replace(/\/+$/, '')}/${ACP_BUSY_FILE}`)
  const { busySids, holds, heldMs } = acpTurnsHold(c.host, raw, now)
  if (busySids.length > 0 && !holds) {
    log.session.warn('DaemonConnection: host network daemon update goes ahead over ACP turns open too long', { host: c.host, busySids, heldMs })
    return null
  }
  return acpTurnsReason(busySids)
}

export interface NetUpdaterDeps {
  conn: NetUpdateLink
  kind: () => DaemonLinkKind
  testServer: () => boolean
  /** This server follows a leader (core/server-role.ts isFollower). */
  follower?: () => boolean
  expectedVersion: () => string | null
  /** Why the daemon must not stop now (session or file writes in flight), or null. */
  hold: () => string | null
  /**
   * Why the host's daemon must not stop now, asked of the host, or null. Default: its host_exec
   * runs (exec-runs-hold.ts), then its open ACP turns (acpTurnsHoldOverLink).
   */
  busy?: () => Promise<string | null>
  cooldownMs: number
  /** Overdue: hold this server's file changes to the host while the swap runs (DaemonConnection); returns the release. */
  fence?: () => () => void
  /** Every host name that reaches this daemon (DaemonConnection.sameDaemonHosts): one update claim for all of them. */
  sameDaemon?: () => Promise<string[]>
  /** The gap between automatic replacements (daemon-update-gap.ts); default from the env. */
  minGapMs?: number
  autofixOff?: () => Promise<string | null>
  /** The host's target, read with host-target.ts's probe over exec.run (as the SSH path reads it). */
  target?: (run: (command: string, timeoutMs?: number) => Promise<string>) => Promise<HostFileTarget | null>
  source?: (t: HostFileTarget, expected: string, say: (message: string) => void, opts: { walnutFile: boolean }) => Promise<NetUpdateSource | { missing: string }>
  /** The host's mode (one-service-mode.ts), as DaemonConnection decides it for every link; absent: the host keeps its mode. */
  mode?: NetServiceModeDeps
  update?: typeof updateRemoteDaemonService
  io?: NetUpdateIoOptions
  settleMs?: number
  recheckMs?: number
  now?: () => number
  env?: Record<string, string | undefined>
}

export interface NetServiceModeDeps {
  /** Read on a live link: a switch alone due, and the words the update carries (serviceModeAsk). */
  read(): Promise<{ due: boolean; serve?: { home: string; on: boolean } }>
  /** An update that ran asked this switch: not asked again with this build (ServiceModeAsk). */
  asked(ask: ServiceModeAsk): void
  /** This build's walnut file cannot go to the host: no offer with this build, and the build goes without it. */
  unfit(expected: string, why: string): void
}

export type NetUpdatePhase = 'idle' | 'checking' | 'running' | 'updated' | 'failed' | 'skipped' | 'held' | 'postponed'
export interface NetUpdateState { phase: NetUpdatePhase; host: string; running: string | null; expected: string | null; message: string; at: number; skip?: NetUpdateSkip }

const MAX_BACKOFF_MS = 6 * 3600_000
/** Uploads the link cut while the host stays on one build before the next cut is a failure (Walnut Health's "3 times or more"). */
export const LINK_CUTS_BEFORE_FAILURE = 3
/** Tries of one build whose walnut file did not reach the host before that build goes without the switch. */
export const STAGE_TRIES_BEFORE_UNFIT = 3
/** Answers that need no word in the log: nothing to do, or not this path's host. */
/** Why another build's daemon on this link is kept (daemon-shared.ts), or null. */
function sharedWhy(c: NetUpdateLink, expected: string | null, now: number): string | null {
  if (!expected || !c.daemonVersion || c.daemonVersion === expected) return null
  const v = sharedDaemonVerdict({ ourKey: walnutKeyOf(WALNUT_HOME), runningVersion: c.daemonVersion, running: c.daemonServes ?? null, now })
  return v.keep ? v.why : null
}

const QUIET_SKIPS: ReadonlySet<NetUpdateSkip> = new Set(['current', 'not-net', 'local', 'test-server', 'follower', 'cooldown', 'no-build-version'])

/** Per host, for the server's life: the host setting that holds updates is news once per build. */
const HELD_BY_HOST_SETTING = new Map<string, HoldNews>()
function heldByHostSetting(host: string): HoldNews {
  let news = HELD_BY_HOST_SETTING.get(host)
  if (!news) HELD_BY_HOST_SETTING.set(host, news = new HoldNews(Number.POSITIVE_INFINITY))
  return news
}

export class NetDaemonUpdater {
  private timer: ReturnType<typeof setTimeout> | null = null
  private inFlight: Promise<NetUpdateState> | null = null
  private lastAttempt: { expected: string; at: number } | null = null
  /** Failed tries of one build, counted per build. */
  private failed: { expected: string; count: number } | null = null
  /** Uploads the link cut (stageCutByLink) while the host ran `from`: a postponement until LINK_CUTS_BEFORE_FAILURE. */
  private linkCuts: { from: string | null; count: number } | null = null
  /** Tries of a build whose walnut file did not reach the host: a postponement until STAGE_TRIES_BEFORE_UNFIT. */
  private stageFails: { expected: string; count: number } | null = null
  /** The build this server put on the host (its update answered ok). */
  private installed: string | null = null
  /** No automatic try before this (ms epoch, wall clock: it must run out across sleep): the backoff after a failed one. */
  private retryAt = 0
  /** A build that stopped the host's daemon and did not stay serving: a day off, kept across restarts (undefined until read). */
  private notServing: BuildBackoffEntry | null | undefined = undefined
  private skipNoted: string | null = null
  private overdueNoted: string | null = null
  /** Since when this build's update has been held by the update gap (daemon-update-gap.ts). */
  private gapHeld: { expected: string; since: number } | null = null
  private stopped = false
  private waiters: Array<() => void> = []
  /** The update this server started there, until its record is read (daemon-net-update-record.ts), and the read's timer. */
  private readonly launched: LaunchedNetUpdate
  private readTimer: ReturnType<typeof setTimeout> | null = null
  state: NetUpdateState

  constructor(private readonly d: NetUpdaterDeps) {
    this.state = { phase: 'idle', host: d.conn.host, running: null, expected: null, message: '', at: 0 }
    this.launched = new LaunchedNetUpdate(d.conn.host, () => (d.now ?? Date.now)(), (expected, reason) => this.buildDidNotStay(expected, reason))
  }

  /** Its daemon update for the host's status. Read on every status frame: fields only, never expectedVersion() (a sync hash). */
  get view(): DaemonUpdateView | null { return this.launched.view(this.d.conn.connected, this.d.conn.daemonVersion) }

  /** The link came up: decide once it settled (a new link's first seconds carry its copies). */
  schedule(delayMs = this.d.settleMs ?? 20_000): void {
    if (this.stopped || this.d.kind() !== 'net') return
    // A record left by an update whose answer never came is read at once, not after the backoff its failure set.
    if (this.launched.unread) {
      if (this.readTimer) clearTimeout(this.readTimer)
      this.readTimer = setTimeout(() => { this.readTimer = null; void this.readBack(false) }, delayMs)
      this.readTimer.unref?.()
    }
    this.later(delayMs)
  }

  stop(): void {
    this.stopped = true
    for (const t of [this.timer, this.readTimer]) if (t) clearTimeout(t)
    this.timer = this.readTimer = null
  }

  /** The reconnect's timer reads only while no check runs: a check still waiting on its update reads it itself. */
  private async readBack(inCheck: boolean): Promise<void> {
    const c = this.d.conn
    if (this.stopped || !c.connected || !this.launched.unread || (!inCheck && this.inFlight)) return
    await this.launched.readBack(c, c.daemonVersion, (dir) => createNetUpdateIo(c, this.d.io).run(`rm -rf ${shq(dir)}`, 15_000)).catch(() => {})
  }

  /**
   * The build stopped the host's daemon and did not stay serving: a day off for it, kept across
   * restarts, whether the update's answer said so in time or its record was read back later.
   */
  private buildDidNotStay(expected: string, reason: string): Promise<void> {
    const now = (this.d.now ?? Date.now)()
    this.notServing = { expected, at: now, reason }
    this.retryAt = Math.max(this.retryAt, now + BUILD_BACKOFF_MS)
    // The disk write is the promise: the host's record is removed only after it (review 5).
    return writeBuildBackoff(`net:${this.d.conn.host}`, this.notServing)
  }

  /**
   * Run it now (host_daemon_update): past the host setting's hold and the cooldown. Answers once it
   * is decided or started. `gate` (the asking task's grant) is read right before the run starts, before
   * the upload and before the handover: it throws once the asker may no longer have it run, and a
   * refusal there changes nothing on the host.
   */
  async request(waitMs = 8_000, gate?: () => void): Promise<NetUpdateState> {
    const now = this.d.now ?? Date.now
    const until = now() + waitMs
    if (this.inFlight) {
      // An automatic check still deciding: wait for it, then ask past what held it.
      if (this.state.phase !== 'checking') return this.state
      await this.within(this.inFlight, waitMs)
      // Read again: the wait may have ended it.
      if (this.busy() || ['running', 'updated', 'failed'].includes(this.state.phase)) return this.state
    }
    gate?.()
    const run = this.check('request', gate)
    const started = new Promise<void>((r) => { this.waiters.push(r) })
    await this.within(Promise.race([run, started]), Math.max(0, until - now()))
    return this.state
  }

  private busy(): boolean {
    return this.inFlight !== null
  }

  private async within(p: Promise<unknown>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([p.then(() => {}, () => {}), new Promise<void>((r) => { timer = setTimeout(r, ms) })])
    clearTimeout(timer)
  }

  /** The next automatic check, never before the backoff after a failure (a reconnect does not cut it short). */
  private later(ms: number): void {
    if (this.timer) clearTimeout(this.timer)
    const wait = Math.max(ms, this.retryAt - (this.d.now ?? Date.now)())
    this.timer = setTimeout(() => { this.timer = null; void this.check('auto') }, wait)
    this.timer.unref?.()
  }

  private set(phase: NetUpdatePhase, message: string, extra: Partial<NetUpdateState> = {}): NetUpdateState {
    const c = this.d.conn
    this.state = { phase, host: c.host, running: c.daemonVersion, expected: this.d.expectedVersion(), message, at: (this.d.now ?? Date.now)(), ...extra }
    if (phase !== 'checking') for (const w of this.waiters.splice(0)) w()
    return this.state
  }

  private check(trigger: 'auto' | 'request', gate?: () => void): Promise<NetUpdateState> {
    if (this.inFlight) return this.inFlight
    const run = this.attempt(trigger, gate).catch((err) => this.set('failed', err instanceof Error ? err.message : String(err)))
      .finally(() => { this.inFlight = null })
    this.inFlight = run
    return run
  }

  private async facts(trigger: 'auto' | 'request', modeDue: boolean): Promise<NetUpdateFacts> {
    const c = this.d.conn
    const env = this.d.env ?? process.env
    return {
      kind: this.d.kind(), host: c.host, testServer: this.d.testServer(),
      follower: await (this.d.follower ? Promise.resolve(this.d.follower()) : defaultFollower()), expected: this.d.expectedVersion(),
      running: c.daemonVersion, startup: c.daemonStartup, serviceExecutable: c.serviceExecutable,
      has: (cap) => c.hasCapability(cap), autofixOff: await (this.d.autofixOff ?? (() => defaultAutofixOff(c.host)))(),
      turnedOff: netDaemonUpdateTurnedOff(env),
      requested: trigger === 'request', modeDue, lastAttempt: this.lastAttempt, now: (this.d.now ?? Date.now)(), cooldownMs: this.d.cooldownMs,
      shared: sharedWhy(c, this.d.expectedVersion(), (this.d.now ?? Date.now)()),
      contested: !!this.installed && this.installed === this.d.expectedVersion() && c.daemonVersion !== this.installed,
      failedTries: this.failed && this.failed.expected === this.d.expectedVersion() ? this.failed.count : 0,
      daemonAgeMs: c.daemonStartedAt ? (this.d.now ?? Date.now)() - c.daemonStartedAt : null,
      minGapMs: this.d.minGapMs ?? daemonUpdateMinGapMs(env),
      gapHeldForMs: this.gapHeld && this.gapHeld.expected === this.d.expectedVersion() ? (this.d.now ?? Date.now)() - this.gapHeld.since : 0,
    }
  }

  private async attempt(trigger: 'auto' | 'request', gate?: () => void): Promise<NetUpdateState> {
    const c = this.d.conn
    const refused = (): string | null => {
      try { gate?.(); return null } catch (err) { return err instanceof Error ? err.message : String(err) }
    }
    if (this.stopped || !c.connected) return this.set('skipped', 'the host is not connected')
    this.set('checking', 'checking the host\'s daemon')
    // Back after an update whose answer never came over the link: read what it left there, also
    // one a server before this one launched (kept on disk, daemon-net-update-record.ts).
    await this.launched.load()
    await this.readBack(true)
    // The mode as decided now, from this link's hello (never a version read over SSH: there is none).
    const mode: Awaited<ReturnType<NetServiceModeDeps['read']>> = c.connected && this.d.mode ? await this.d.mode.read().catch(() => ({ due: false })) : { due: false }
    const facts = await this.facts(trigger, mode.due)
    // The bound on the whole update (daemon-update-behind.ts), read before any skip so a round that
    // skips (a cooldown, the gap) still counts as seen: behind this long, the writes in flight and
    // the host_exec runs no longer hold it, and the daemon goes over its own work.
    const behind = daemonUpdateOverdue(c.host, c.daemonVersion ?? '', !!facts.expected && !!c.daemonVersion && c.daemonVersion !== facts.expected, (this.d.now ?? Date.now)())
    if (this.notServing === undefined) this.notServing = await readBuildBackoff(`net:${c.host}`)
    if (trigger === 'auto' && facts.expected && buildBackedOff(this.notServing, facts.expected, (this.d.now ?? Date.now)())) {
      this.retryAt = Math.max(this.retryAt, this.notServing!.at + BUILD_BACKOFF_MS)
      if (!this.stopped) this.later(0)
      return this.set('failed', `this build did not stay serving on the host, so it is tried again in a day or with a newer build: ${this.notServing!.reason}`)
    }
    const first = decideNetUpdate(facts)
    if (first.go === false) return this.skipped(first, trigger)
    // Its runner may still be in its check; a second update would swap the service under it.
    if (this.launched.unread) return this.postpone('the previous daemon update is still running on the host')
    // Another host name of this daemon is updating it (daemon-update-claim.ts): nothing goes up from here.
    const peer = await daemonUpdateHeldBy(c.host, () => this.sameDaemonNames())
    if (peer) return this.postpone(peerUpdatingWhy(peer))
    const expected = facts.expected!
    if (behind.overdue && this.overdueNoted !== expected) {
      this.overdueNoted = expected
      log.session.warn('DaemonConnection: host network daemon update overdue; it goes ahead over the work that held it', {
        host: c.host, running: c.daemonVersion, expected, behindMs: behind.behindMs,
      })
    }
    // Overdue: the CLI goes over the daemon's own work, in at most a minute (daemon-over-busy.ts).
    const goesOver = behind.overdue
    const holds = async (): Promise<string | null> => {
      if (!goesOver) return this.d.hold() ?? await this.hostBusy()
      // Overdue: the writes in flight get a moment to end (as on the SSH path), then go over the rest.
      const until = Date.now() + OVERDUE_GATE_WAIT_MS
      while (this.d.hold() && Date.now() < until) await new Promise((resolve) => setTimeout(resolve, 1_000))
      return null
    }
    // Overdue, the old daemon may be restarted unprepared, and an older one's shutdown does not
    // wait for a file write: from the launch on (after the upload), this server's file changes
    // wait for the swap (daemon-over-busy.ts).
    let release: (() => void) | undefined
    const io = createNetUpdateIo(c, {
      ...this.d.io,
      beforeLaunch: async () => {
        const no = !c.connected ? 'the link dropped' : refused() ?? await holds()
        if (no === null && goesOver && !release) release = this.d.fence?.()
        return no
      },
      cancelled: () => this.stopped,
      onLaunched: (directory) => this.launched.started(directory, expected, c.daemonVersion),
    })
    const held = await holds()
    if (held) return this.postpone(held)
    const scope = scopeFromStatus(await io.run(`${shq(facts.serviceExecutable!)} walnut daemon status 2>/dev/null || true`, 60_000))
    if (!('scope' in scope)) return this.skipped({ go: false, skip: 'unmanaged', why: scope.why }, trigger)
    // Only now the lookups: the probe is one more command, and the walnut file may be a download or a build.
    facts.target = await (this.d.target ?? probeTarget)((command, ms) => io.run(command, ms)).catch(() => null)
    const say = (message: string) => log.session.info('DaemonConnection: getting the walnut file for a host network daemon', { host: c.host, message })
    const lookup = (t: HostFileTarget, walnutFile: boolean) => (this.d.source ?? netDaemonSource)(t, expected, say, { walnutFile })
    // `--serve` needs the walnut file (it holds the server), as the SSH path's slot does.
    let serve = mode.serve
    facts.source = facts.target ? await lookup(facts.target, serve?.on === true) : { missing: 'unknown system' }
    if (serve?.on && facts.target && 'missing' in facts.source) {
      // No walnut file of this build for the host: no offer with this build (Walnut Health says why), the build goes as before.
      this.d.mode?.unfit(expected, facts.source.missing.slice(0, 300))
      serve = undefined
      facts.modeDue = false
      if (c.daemonVersion !== expected) facts.source = await lookup(facts.target, false)
    }
    const decision = decideNetUpdate(facts)
    // A lookup that found nothing waits a cooldown too: it may have been a download.
    this.lastAttempt = { expected, at: (this.d.now ?? Date.now)() }
    if (decision.go !== true) return this.skipped(decision as Extract<NetUpdateDecision, { go: false }>, trigger)
    const src = decision.source
    // The status and the lookups took time: the asker's grant is read again before the upload.
    const no = refused()
    if (no) return this.skipped({ go: false, skip: 'refused', why: no }, trigger)
    const from = c.daemonVersion
    const asked: ServesAs | null = serve ? (serve.on ? 'walnut-serve' : 'daemon') : null
    // Claimed for every name of this daemon before the first upload byte; the lookups above took time.
    const claim = await claimDaemonUpdate(c.host, () => this.sameDaemonNames())
    if ('heldBy' in claim) return this.postpone(peerUpdatingWhy(claim.heldBy))
    // Kept for the settle window once the update went through, may still run on the host (its answer
    // lost), or was refused there before it changed anything (this name asks again, its file already
    // on the host): only a failure frees the other names at once.
    let claimKept = false
    try {
      log.session.info('DaemonConnection: updating a host network machine\'s daemon over its link', {
        host: c.host, from, expected, scope: scope.scope, target: decision.target, source: 'file' in src ? 'daemon binary' : `walnut file ${src.id}`, trigger,
        ...(asked ? { mode: asked } : {}),
      })
      this.set('running', `uploading ${expected} and updating its ${scope.scope} service`)
      await (this.d.update ?? updateRemoteDaemonService)('file' in src ? { binary: src.file, base: facts.serviceExecutable } : { binary: null, gz: src.gz, base: facts.serviceExecutable }, expected, io, scope.scope, {
        overBusy: goesOver,
        // The build's hold before its record (the staging dir) is removed on the host.
        onBuildFailed: (error) => this.buildDidNotStay(expected, error.message.slice(0, 300)),
        ...(serve ? { serve } : {}),
      })
      claimKept = true
    } catch (err) {
      // The upload was paid for: the next try waits a cooldown, it is not a failure.
      // Read from its record after the launch too (a probation, the install lock): answered, and no failure.
      if (err instanceof NetUpdateHeldError) {
        claimKept = true
        this.lastAttempt = null
        this.launched.answered()
        this.launched.outcome(expected, null)
        return this.postpone(err.message, this.d.cooldownMs)
      }
      const msg = err instanceof Error ? err.message : String(err), deferredAt = msg.indexOf('update deferred: ')
      // The build stopped the daemon and did not stay serving (daemon-service-update.ts): a day, kept
      // across restarts, written before the record goes (a server killed in between keeps one of
      // them). 2026-11-04 review: 10, 20, 40 min ... each try stopped the healthy daemon again.
      const buildFailed = (err as { buildFailed?: unknown }).buildFailed === true
      if (buildFailed) void this.buildDidNotStay(expected, msg.slice(0, 300))
      // Unanswered: the record stays on the host, read when it is back; any other end is read already.
      if (!(err instanceof NetUpdateUnansweredError)) this.launched.answered()
      // The answer never came: the update may still run there, so the other names wait it out too.
      else claimKept = true
      // 2026-11-04: deferred on the host (launchd starting no jobs in a dark wake), so nothing changed there: no failure, asked again after the cooldown.
      if (deferredAt >= 0) { claimKept = true; this.launched.outcome(expected, null); return this.postpone(msg.slice(deferredAt), this.d.cooldownMs) }
      // The daemon refused before it changed anything (busy, or its drain ran out): asked again,
      // not a failure that gives the build up after a few. Overdue, in a minute; otherwise after
      // the cooldown, since each try uploads the file again.
      if (!buildFailed && daemonBusyRefusal(err)) {
        claimKept = true
        this.lastAttempt = null
        this.launched.outcome(expected, null)
        return this.postpone(`the host's daemon is busy (${msg.split('\n')[0].slice(0, 200)})`,
          goesOver ? (this.d.recheckMs ?? 60_000) : this.d.cooldownMs)
      }
      // The link dropped while the new daemon was put on the host (a cut upload, a command lost
      // with the link): nothing changed there and the next connection tries again, as the SSH path
      // postpones its stage failures. 2026-11-18: all 13 "update failed" errors of 3 days were such
      // cuts, each in the same millisecond as the link's drop. A link that cuts every try is a failure.
      if (!buildFailed && stageCutByLink(err, c.connected)) {
        // Counted per running build, not per new one: a host whose link cuts every upload stays
        // behind across deploys, and that is still said as a failure after a few.
        const cuts = this.linkCuts?.from === from ? this.linkCuts.count + 1 : 1
        this.linkCuts = { from, count: cuts }
        if (cuts < LINK_CUTS_BEFORE_FAILURE) {
          this.launched.outcome(expected, null)
          return this.postpone(`the link dropped while the new daemon was put on the host, so nothing changed there (${msg.split('\n')[0].slice(0, 200)})`, this.d.cooldownMs)
        }
      }
      // Nothing went onto the host (DaemonUpdateStageError, by name as on the SSH path). A walnut file
      // that did not go there is tried again after the cooldown (a passing fault: a full disk, a slow link);
      // the third try of the same build takes the offer away for it, and the build is asked again without it.
      const staging = err instanceof Error && err.name === 'DaemonUpdateStageError'
      if (staging && serve?.on) {
        const tries = this.stageFails?.expected === expected ? this.stageFails.count + 1 : 1
        this.stageFails = { expected, count: tries }
        this.lastAttempt = null
        this.launched.outcome(expected, null)
        const first = msg.split('\n')[0].slice(0, 200)
        if (tries < STAGE_TRIES_BEFORE_UNFIT) {
          return this.postpone(`the walnut file did not reach the host (try ${tries} of ${STAGE_TRIES_BEFORE_UNFIT}), so nothing changed there; tried again after the cooldown (${first})`, this.d.cooldownMs)
        }
        this.d.mode?.unfit(expected, msg.slice(0, 300))
        return this.postpone(`the walnut file could not be put on the host, so the update goes without the switch (${first})`)
      }
      // A switch whose update failed past its staging is not asked again with this build (each try restarts the host's service).
      if (asked && !staging) this.d.mode?.asked({ expected, want: asked, failed: msg.split('\n')[0].slice(0, 300) })
      this.failed = { expected, count: this.failed?.expected === expected ? this.failed.count + 1 : 1 }
      const count = this.failed.count
      this.launched.outcome(expected, msg)
      const retryInMs = buildFailed ? BUILD_BACKOFF_MS : Math.min(this.d.cooldownMs * 2 ** (count - 1), MAX_BACKOFF_MS)
      log.session.error(`DaemonConnection: host network daemon update failed; ${afterUpdateFailure(err)}`, {
        host: c.host, from, expected, error: msg.slice(0, 600), failures: count, retryInMs,
      })
      this.retryAt = (this.d.now ?? Date.now)() + retryInMs
      if (!this.stopped) this.later(0)
      return this.set('failed', msg)
    } finally { release?.(); claim.release(claimKept) }
    this.failed = null
    this.linkCuts = null
    this.stageFails = null
    this.retryAt = 0
    this.installed = expected
    // The switch went with an update that ran: not asked again with this build, whatever the host chose.
    if (asked) this.d.mode?.asked({ expected, want: asked })
    this.launched.answered()
    this.launched.outcome(expected, null)
    log.session.info('DaemonConnection: host network machine\'s daemon updated', { host: c.host, from, expected })
    return this.set('updated', `its daemon was updated to ${expected}`)
  }

  private skipped(d: Extract<NetUpdateDecision, { go: false }>, trigger: 'auto' | 'request'): NetUpdateState {
    const c = this.d.conn
    if (d.skip === 'held') {
      const expected = this.d.expectedVersion()
      // Said once per build and host for this server: an updater is made per connection, and a
      // host whose link drops (2026-11-14: 62 a day for one home machine) said it again at each.
      holdLog(heldByHostSetting(c.host), expected ?? '', 'held by the host setting', 'DaemonConnection: daemon update held by the host setting', { host: c.host, running: c.daemonVersion, expected, why: d.why })
      return this.set('held', d.why, { skip: d.skip })
    }
    // A skip that ends by itself (the gap after a daemon started, the cooldown, a lookup that may
    // pass) is decided again when it ends, not at the next reconnect, which a steady link never makes.
    if (d.retryInMs && !this.stopped) {
      const expected = this.d.expectedVersion()
      if (d.skip === 'recent' && expected && this.gapHeld?.expected !== expected) this.gapHeld = { expected, since: (this.d.now ?? Date.now)() }
      this.later(d.retryInMs + 5_000)
    }
    // Said once per reason and build: a link that comes back every few minutes would say it every time.
    const noted = `${d.skip}:${this.d.expectedVersion()}`
    if (!QUIET_SKIPS.has(d.skip) && (trigger === 'request' || this.skipNoted !== noted)) {
      this.skipNoted = noted
      log.session.warn('DaemonConnection: host network daemon not updated', {
        host: c.host, running: c.daemonVersion, expected: this.d.expectedVersion(), skip: d.skip, why: d.why, trigger,
      })
    }
    return this.set('skipped', d.why, { skip: d.skip })
  }

  private hostBusy(): Promise<string | null> {
    const c = this.d.conn
    return (this.d.busy ?? (async () => await execRunsHold(c, c.host) ?? await acpTurnsHoldOverLink(c, (this.d.now ?? Date.now)())))()
  }

  /** Every host name of this daemon (sameDaemonHosts), this one included; just this one when unknown. */
  private async sameDaemonNames(): Promise<string[]> {
    const host = this.d.conn.host
    try { return [...new Set([host, ...(this.d.sameDaemon ? await this.d.sameDaemon() : [])])] } catch { return [host] }
  }

  private postpone(reason: string, delayMs = this.d.recheckMs ?? 60_000): NetUpdateState {
    // A wait asked again every minute (a 2 h host_exec run) is logged when its reason changes.
    if (this.state.phase !== 'postponed' || this.state.message !== `waiting: ${reason}`) {
      log.session.info('DaemonConnection: host network daemon update postponed', { host: this.d.conn.host, reason, retryInMs: delayMs })
    }
    if (!this.stopped) this.later(delayMs)
    return this.set('postponed', `waiting: ${reason}`)
  }
}

async function defaultFollower(): Promise<boolean> {
  return (await import('../core/server-role.js')).isFollower()
}

/** Why automatic updates are held for `host` ('config', 'env', 'config-unreadable'), or null. `load` is a test seam. */
export async function defaultAutofixOff(host: string, load?: () => Promise<{ hosts?: Record<string, unknown> } | null>): Promise<string | null> {
  const [{ autofixDisabledReason }, { getConfig }] = await Promise.all([import('../core/hosts/host-autofix.js'), import('../core/config-manager.js')])
  // A config that cannot be read holds the update: a machine someone guards is never changed on a guess.
  const config = await (load ?? getConfig)().catch(() => null)
  if (!config) return 'config-unreadable'
  return autofixDisabledReason(process.env, config.hosts?.[host] as Parameters<typeof autofixDisabledReason>[1])
}

/** The host's target as the SSH path reads it (host-target.ts: musl, Rosetta and 32-bit systems included), over exec.run. */
async function probeTarget(run: (command: string, timeoutMs?: number) => Promise<string>): Promise<HostFileTarget | null> {
  const { parseHostTarget, targetProbeScript } = await import('../core/host-server/host-target.js')
  return parseHostTarget(await run(targetProbeScript(), 15_000)).target
}
