/**
 * Remote-host daemon warmup: connect every explicitly configured host at server
 * startup and keep it warm, so the FIRST interaction with a host (a folder
 * list, a session) never pays ssh + runtime install + upload + tunnel inside a
 * click. Before this, that connect began only when the picker opened.
 *
 * Design constraints (the whole point):
 *   - STRICTLY SEQUENTIAL. N hosts at once = N ssh ControlMasters + N deploys
 *     fired in the same second, which corporate SSH front-ends rate-limit (and
 *     which each burn CPU on the remote). One at a time, always.
 *   - PACED: an idle gap between hosts, so a 6-host warmup never looks like a
 *     burst to anything watching.
 *   - NEVER FATAL: a host that is asleep, off-VPN or misconfigured is the normal
 *     case at startup. Every failure is caught, recorded, logged once, and the
 *     queue moves on.
 *   - ONLY EXPLICIT HOSTS. getConfig() merges every Host block of the user's
 *     real ~/.ssh/config as `discovered: true`; ssh-ing all of those at boot
 *     would be a port scan of the user's infrastructure. Skipped, deliberately.
 *     A human asking for ONE host by name (kick(host)) is a different matter:
 *     that is the same deliberate act as clicking the host's tab, and it dials.
 *   - BACKS OFF. A host that keeps failing (a laptop asleep for the weekend)
 *     would otherwise burn a full ssh timeout every resweep, forever. Each
 *     consecutive failure doubles its wait, capped at an hour; a success, a
 *     config edit or a human retry resets it.
 *   - WAITS FOR CREDENTIALS. An expired SSH certificate, a missing agent or an
 *     SSH proxy's expired login (CREDENTIAL_WAIT_KINDS) is fixed OUTSIDE Walnut,
 *     by a login command, so nobody comes back to click Retry. Those hosts are
 *     re-dialled on their own clock (1, 2, 5 minutes, then every 5) and ONLY
 *     by it (plus a login seen on disk, host-credential-signal.ts): the periodic
 *     resweep skips them, or every failure would advance the clock twice. A host
 *     known only from ~/.ssh/config (one Retry dialled it) stops after a day.
 */

import { bus, EventNames } from '../event-bus.js'
import { log } from '../../logging/index.js'
import type { SshTarget } from '../../providers/session-io.js'
import {
  classifyHostConnectError, CREDENTIAL_WAIT_KINDS, credentialRetryDelayMs, type HostConnectErrorKind,
} from '../sessions/host-connect-hint.js'

export type HostWarmupState = 'queued' | 'running' | 'done' | 'failed' | 'skipped'

export interface HostWarmupCandidate {
  key: string
  sshTarget: SshTarget
  discovered?: boolean
  enabled?: boolean
}

export interface HostWarmupEntry {
  state: HostWarmupState
  /** When this state was recorded (ms epoch). */
  at: number
  error?: string
  /** A credential wait is armed: the host is re-dialled on its own at this time (ms epoch). */
  retryAt?: number
}

export interface HostWarmupDeps {
  listHosts: () => Promise<HostWarmupCandidate[]>
  /**
   * getDaemonConnection — resolves when the daemon is connected. A result with a
   * boolean `connected` is checked (a resolved connect that left the host
   * disconnected is recorded as a failure, not as done).
   */
  connect: (key: string, sshTarget: SshTarget) => Promise<unknown>
  /** isDaemonConnected — an already-warm host is skipped, not re-dialled. */
  isConnected: (key: string) => boolean
  /**
   * True while a connect for this host is already in flight somewhere else (a
   * picker click, the connection's own reconnect loop). The warmup never stacks a
   * second connect on top of one: the reconnect path has no pool-level dedup, so
   * a resweep landing on it would open a second tunnel on the same instance.
   */
  isConnecting?: (key: string) => boolean
  now?: () => number
  /** Delay before the first sweep (server settle time). */
  startupDelayMs?: number
  /** Idle gap between two consecutive connects. */
  paceMs?: number
  /** Periodic re-sweep of not-connected hosts; 0 disables. */
  resweepIntervalMs?: number
  /** Cap on the per-host failure backoff between resweeps. */
  maxBackoffMs?: number
  /**
   * Quiet period after a config change before it re-sweeps. Settings autosaves
   * 600ms after the last keystroke, so without this a hostname is dialled (and
   * pinned in the connection pool) half-typed.
   */
  configQuietMs?: number
  onChange?: (key: string, state: HostWarmupState) => void
  /** Error kind of a failed connect; default classifyHostConnectError. */
  classify?: (message: string, host: HostWarmupCandidate) => HostConnectErrorKind
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void; warn: (msg: string, meta?: Record<string, unknown>) => void }
}

const DEFAULTS = {
  startupDelayMs: 3_000,
  paceMs: 1_500,
  resweepIntervalMs: 10 * 60_000,
  maxBackoffMs: 60 * 60_000,
  configQuietMs: 8_000,
} as const

/** Why a sweep is running — decides which hosts it may touch. */
type SweepReason = 'startup' | 'resweep' | 'config' | 'explicit' | 'credential'

/** Bus subscriber names are the unsubscribe key, so each instance needs its own. */
let instanceSeq = 0

/**
 * Should this process warm hosts at all? Returns the REASON not to (a string for
 * the log), or null to go ahead.
 *
 * Every clause is a real hazard, not caution:
 *   - cloudMode: a replica has no ssh; connecting is the primary's job.
 *   - ephemeral: a throwaway sandbox attaches to production daemons and must
 *     never install or fight over one.
 *   - vitest: 182 test files boot a real server with the user's REAL
 *     ~/.ssh/config merged into config.hosts. A warming server would ssh the
 *     user's actual infrastructure from a unit test.
 *   - the env/config switches are the user's own off ramps.
 */
export function hostWarmupGateReason(opts: {
  cloudMode: boolean
  ephemeral: boolean
  env?: Record<string, string | undefined>
  config?: { hosts_warmup?: { enabled?: boolean } }
}): string | null {
  const env = opts.env ?? {}
  if (opts.cloudMode) return 'cloud mode'
  if (opts.ephemeral) return 'ephemeral server'
  if (env.VITEST) return 'vitest'
  if (env.WALNUT_HOST_WARMUP === '0') return 'WALNUT_HOST_WARMUP=0'
  if (opts.config?.hosts_warmup?.enabled === false) return 'config hosts_warmup.enabled=false'
  return null
}

export class HostWarmup {
  /** How long a host known only from ~/.ssh/config keeps its credential re-dials. */
  static readonly DISCOVERED_CREDENTIAL_WAIT_MS = 24 * 60 * 60_000
  private readonly deps: HostWarmupDeps
  private readonly startupDelayMs: number
  private readonly paceMs: number
  private readonly resweepIntervalMs: number
  private readonly maxBackoffMs: number
  private readonly configQuietMs: number
  private readonly now: () => number
  private readonly logger: NonNullable<HostWarmupDeps['log']>
  private readonly busSubscriber = `host-warmup-${++instanceSeq}`

  private stopped = true
  private queue: HostWarmupCandidate[] = []
  private queued = new Set<string>()
  private draining = false
  private states = new Map<string, HostWarmupEntry>()
  /** Consecutive failures per host — the exponent of its resweep backoff. */
  private failures = new Map<string, { count: number; at: number }>()
  /** Hosts waiting on a credential fix: how many re-dials so far, and the armed timer. */
  private credentialWaits = new Map<string, { attempts: number; timer: ReturnType<typeof setTimeout>; at: number; since: number }>()
  private timers = new Set<ReturnType<typeof setTimeout>>()
  /** Resolvers of in-flight pace sleeps, so stop() can release the drain loop. */
  private sleepResolvers = new Set<() => void>()
  private resweepTimer: ReturnType<typeof setInterval> | null = null
  private configTimer: ReturnType<typeof setTimeout> | null = null
  private busSubscribed = false
  /** Guards the "one connect at a time" invariant — asserted by the tests. */
  private inFlight = 0

  constructor(deps: HostWarmupDeps) {
    this.deps = deps
    this.startupDelayMs = deps.startupDelayMs ?? DEFAULTS.startupDelayMs
    this.paceMs = deps.paceMs ?? DEFAULTS.paceMs
    this.resweepIntervalMs = deps.resweepIntervalMs ?? DEFAULTS.resweepIntervalMs
    this.maxBackoffMs = deps.maxBackoffMs ?? DEFAULTS.maxBackoffMs
    this.configQuietMs = deps.configQuietMs ?? DEFAULTS.configQuietMs
    this.now = deps.now ?? (() => Date.now())
    this.logger = deps.log ?? { info: (m, x) => log.session.info(m, x), warn: (m, x) => log.session.warn(m, x) }
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false

    // A config edit that adds or enables a host must warm it without a restart.
    // global + interest (not a named destination): every config writer emits to
    // ['web-ui'] only, so a named subscription would never be woken.
    bus.subscribe(this.busSubscriber, () => {
      if (this.stopped) return
      this.kickAfterConfigQuiet()
    }, { global: true, interest: [EventNames.CONFIG_CHANGED] })
    this.busSubscribed = true

    const t = setTimeout(() => {
      this.timers.delete(t)
      void this.sweep('startup')
      if (this.resweepIntervalMs > 0) {
        this.resweepTimer = setInterval(() => { void this.sweep('resweep') }, this.resweepIntervalMs)
        unref(this.resweepTimer)
      }
    }, this.startupDelayMs)
    unref(t)
    this.timers.add(t)

    this.logger.info('host warmup started', {
      startupDelayMs: this.startupDelayMs, paceMs: this.paceMs, resweepIntervalMs: this.resweepIntervalMs,
    })
  }

  stop(): void {
    this.stopped = true
    if (this.busSubscribed) { bus.unsubscribe(this.busSubscriber); this.busSubscribed = false }
    for (const t of this.timers) clearTimeout(t)
    this.timers.clear()
    if (this.resweepTimer) { clearInterval(this.resweepTimer); this.resweepTimer = null }
    if (this.configTimer) { clearTimeout(this.configTimer); this.configTimer = null }
    // Release a drain loop parked in a pace sleep — otherwise its promise never
    // settles, `draining` stays true, and a later start() can never drain again.
    for (const resolve of this.sleepResolvers) resolve()
    this.sleepResolvers.clear()
    this.queue = []
    this.queued.clear()
    this.credentialWaits.clear()
  }

  /**
   * Warm hosts now. With `hostKey`, exactly that host, even if it failed before
   * or is only known from ~/.ssh/config (the human just hit Retry / Connect now;
   * the caller clears the failure cache first). Without one, re-list and warm
   * every eligible host that is not connected, backoff ignored (a deliberate
   * call is not the timer).
   */
  async kick(hostKey?: string): Promise<void> {
    await this.sweep(hostKey ? 'explicit' : 'config', hostKey)
  }

  snapshot(): Record<string, HostWarmupEntry> {
    const out: Record<string, HostWarmupEntry> = {}
    for (const [key, entry] of this.states) out[key] = { ...entry }
    return out
  }

  /** One host's warmup state, without copying the whole snapshot (the live push
   *  path asks this several times per connect). */
  stateOf(hostKey: string): HostWarmupState | undefined {
    return this.states.get(hostKey)?.state
  }

  // ── internals ──

  private kickAfterConfigQuiet(): void {
    if (this.configTimer) { clearTimeout(this.configTimer); this.timers.delete(this.configTimer) }
    const t = setTimeout(() => {
      this.timers.delete(t)
      this.configTimer = null
      void this.sweep('config')
    }, this.configQuietMs)
    unref(t)
    this.timers.add(t)
    this.configTimer = t
  }

  private async sweep(reason: SweepReason, hostKey?: string): Promise<void> {
    if (this.stopped) return
    let hosts: HostWarmupCandidate[]
    try {
      hosts = await this.deps.listHosts()
    } catch (err) {
      this.logger.warn('host warmup: listing hosts failed', { error: errText(err) })
      return
    }
    if (this.stopped) return
    if (reason === 'config') this.failures.clear()

    for (const host of hosts) {
      if (hostKey && host.key !== hostKey) continue
      // A credential re-dial was asked for by a connect that already ran, so
      // the host is as eligible as when a human asked for it.
      const skip = this.skipReason(host, reason === 'explicit' || reason === 'credential')
      if (skip) {
        // Recorded (so the status surface can say why) but NOT announced: a user
        // with 40 Host blocks in ~/.ssh/config would otherwise get 40 live
        // pushes at boot about hosts Walnut deliberately does not manage.
        this.record(host.key, skip, undefined, false)
        continue
      }
      // Already warm: nothing to do (an explicit kick for a connected host is
      // satisfied by definition).
      if (this.isConnected(host.key)) { this.record(host.key, 'done'); continue }
      // Somebody else is already connecting it: theirs to finish.
      if (this.isConnecting(host.key)) continue
      // The credential clock alone re-dials a waiting host (else each tier advances twice).
      if (reason === 'resweep' && this.credentialWaits.has(host.key)) continue
      if (reason === 'resweep' && !this.dueForResweep(host.key)) continue
      if (reason === 'explicit' || reason === 'config') this.clearCredentialWait(host.key, true)
      if (reason === 'explicit') this.failures.delete(host.key)
      this.push(host)
    }
    this.drainSoon()
  }

  /** '' = eligible. Only host-intrinsic reasons live here. */
  private skipReason(host: HostWarmupCandidate, explicit: boolean): HostWarmupState | '' {
    if (host.key === '__local__') return 'skipped'
    if (host.enabled === false) return 'skipped'
    // ~/.ssh/config entries the user never asked Walnut to manage — unless the
    // user is asking right now, for this one.
    if (host.discovered === true && !explicit) return 'skipped'
    if (!host.sshTarget?.hostname) return 'skipped'
    return ''
  }

  private isConnected(key: string): boolean {
    try { return this.deps.isConnected(key) } catch { return false }
  }

  private isConnecting(key: string): boolean {
    try { return this.deps.isConnecting?.(key) ?? false } catch { return false }
  }

  /** Exponential per-host backoff: interval × 2^(failures-1), capped. */
  private dueForResweep(key: string): boolean {
    const f = this.failures.get(key)
    if (!f) return true
    const wait = Math.min(this.maxBackoffMs, this.resweepIntervalMs * 2 ** Math.max(0, f.count - 1))
    return this.now() - f.at >= wait
  }

  private push(host: HostWarmupCandidate): void {
    if (this.queued.has(host.key)) return
    this.queued.add(host.key)
    this.queue.push(host)
    this.record(host.key, 'queued')
  }

  private record(key: string, state: HostWarmupState, error?: string, notify = true, retryAt?: number): void {
    const entry: HostWarmupEntry = { state, at: this.now() }
    if (error) entry.error = error
    if (retryAt !== undefined) entry.retryAt = retryAt
    this.states.set(key, entry)
    if (!notify) return
    try { this.deps.onChange?.(key, state) } catch { /* observers never break warmup */ }
  }

  private drainSoon(): void {
    if (this.draining || this.stopped || this.queue.length === 0) return
    this.draining = true
    void this.drain().finally(() => {
      this.draining = false
      // A host pushed between drain() seeing an empty queue and this finally
      // would otherwise sit there until the next sweep.
      if (this.queue.length > 0) this.drainSoon()
    })
  }

  /** Sequential drain: ONE connect at a time, with an idle gap between hosts. */
  private async drain(): Promise<void> {
    while (!this.stopped) {
      const host = this.queue.shift()
      if (!host) return
      this.queued.delete(host.key)
      if (this.isConnected(host.key)) { this.record(host.key, 'done'); continue }
      if (this.isConnecting(host.key)) {
        // Queued behind a long connect, and meanwhile somebody else took this
        // host on. Nothing to say about it any more.
        this.states.delete(host.key)
        continue
      }

      this.record(host.key, 'running')
      const started = this.now()
      this.inFlight++
      if (this.inFlight > 1) {
        // Should be impossible; loud rather than silently parallel.
        this.logger.warn('host warmup: concurrent connect detected', { host: host.key, inFlight: this.inFlight })
      }
      const hadCredentialWait = this.credentialWaits.has(host.key)
      try {
        const result = await this.deps.connect(host.key, host.sshTarget)
        if (!resolvedConnected(result)) {
          // connect() has an early return for "somebody else is mid-connect";
          // a warmup that reported done on that would lie to every surface.
          throw new Error('connect finished without a live connection')
        }
        this.failures.delete(host.key)
        this.clearCredentialWait(host.key, true)
        this.record(host.key, 'done')
        this.logger.info('host warmup: connected', { host: host.key, elapsedMs: this.now() - started })
        if (hadCredentialWait) this.redialCredentialPeers(host.key)
      } catch (err) {
        const message = errText(err)
        const prior = this.failures.get(host.key)
        this.failures.set(host.key, { count: (prior?.count ?? 0) + 1, at: this.now() })
        const kind = this.classify(message, host)
        const retryAt = CREDENTIAL_WAIT_KINDS.has(kind) ? this.armCredentialWait(host) : undefined
        if (retryAt === undefined) this.clearCredentialWait(host.key, true)
        this.record(host.key, 'failed', message, true, retryAt)
        // Expected at startup (host asleep, VPN down) — warn, never throw.
        this.logger.warn('host warmup: connect failed', {
          host: host.key, elapsedMs: this.now() - started, error: message,
          consecutiveFailures: (prior?.count ?? 0) + 1, kind,
          ...(retryAt !== undefined ? { credentialRetryInMs: retryAt - this.now() } : {}),
        })
      } finally {
        this.inFlight--
      }

      if (this.stopped) return
      if (this.queue.length > 0 && this.paceMs > 0) await this.sleep(this.paceMs)
    }
  }

  private classify(message: string, host: HostWarmupCandidate): HostConnectErrorKind {
    try {
      if (this.deps.classify) return this.deps.classify(message, host)
      const t = host.sshTarget
      const target = t?.user ? `${t.user}@${t.hostname}` : t?.hostname ?? host.key
      return classifyHostConnectError(message, target, [host.key, t?.hostname ?? '', t?.user ?? '']).kind
    } catch { return 'unknown' }
  }

  /**
   * Re-dial `host` on the credential schedule (credentialRetryDelayMs). The
   * attempt count survives each re-dial, so the waits grow 1 → 2 → 5 minutes,
   * then stay at 5. Returns when the re-dial fires.
   */
  private armCredentialWait(host: HostWarmupCandidate): number | undefined {
    const prior = this.credentialWaits.get(host.key)
    if (prior) { clearTimeout(prior.timer); this.timers.delete(prior.timer) }
    const since = prior?.since ?? this.now()
    // A ~/.ssh/config host dialled by one Retry gets a day, not ssh every 5 minutes forever.
    if (host.discovered === true && this.now() - since >= HostWarmup.DISCOVERED_CREDENTIAL_WAIT_MS) {
      this.credentialWaits.delete(host.key)
      this.logger.info('host warmup: giving up the credential wait for a host not in config', { host: host.key })
      return undefined
    }
    const attempts = prior?.attempts ?? 0
    const delay = credentialRetryDelayMs(attempts)
    const t = setTimeout(() => {
      this.timers.delete(t)
      if (this.stopped) return
      const wait = this.credentialWaits.get(host.key)
      if (wait?.timer !== t) return
      void this.sweep('credential', host.key)
    }, delay)
    unref(t)
    this.timers.add(t)
    const at = this.now() + delay
    this.credentialWaits.set(host.key, { attempts: attempts + 1, timer: t, at, since })
    return at
  }

  /** Forget a host's credential wait (connected, a different failure, a human retry, a config edit). */
  private clearCredentialWait(key: string, resetAttempts: boolean): void {
    const wait = this.credentialWaits.get(key)
    if (!wait) return
    clearTimeout(wait.timer)
    this.timers.delete(wait.timer)
    if (resetAttempts) this.credentialWaits.delete(key)
  }

  /** One login (a certificate, an agent) fixes every host behind it: redial each other waiting host once, now (C59). */
  private redialCredentialPeers(except: string): void {
    const peers = [...this.credentialWaits.keys()].filter((k) => k !== except)
    if (peers.length) this.logger.info('host warmup: a credential wait cleared, redialling the other waiting hosts', { host: except, peers })
    for (const key of peers) { this.clearCredentialWait(key, false); void this.sweep('credential', key) }
  }

  /** When the host's next credential re-dial fires (ms epoch), if one is armed. */
  credentialRetryAt(hostKey: string): number | undefined {
    return this.credentialWaits.get(hostKey)?.at
  }

  /** Hosts waiting on their credential clock, with when their last dial failed (none mid-dial). */
  credentialWaiters(): Array<{ host: string; failedAt: number }> {
    const out: Array<{ host: string; failedAt: number }> = []
    for (const key of this.credentialWaits.keys()) {
      const entry = this.states.get(key)
      if (entry?.state === 'failed') out.push({ host: key, failedAt: entry.at })
    }
    return out
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => { this.sleepResolvers.delete(done); resolve() }
      const t = setTimeout(() => { this.timers.delete(t); done() }, ms)
      unref(t)
      this.timers.add(t)
      this.sleepResolvers.add(done)
    })
  }
}

function resolvedConnected(result: unknown): boolean { // `connected: false` is a failure; anything else is trusted
  if (result && typeof result === 'object' && 'connected' in result) {
    return (result as { connected: unknown }).connected !== false
  }
  return true
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function unref(timer: unknown): void { // never hold the process open; typed for DOM lib builds
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref: () => void }).unref()
  }
}
