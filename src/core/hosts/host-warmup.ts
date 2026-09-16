/**
 * Remote-host daemon warmup.
 *
 * Every explicitly configured remote host needs its session daemon connected
 * before anything useful can happen there (list a folder, start a session, read
 * a file). Until this module existed that connect only began when a user opened
 * the folder picker, so the FIRST interaction with a host paid the whole cost:
 * ssh ControlMaster, a runtime install on a fresh box, the daemon upload, the
 * tunnel. Minutes, inside a click.
 *
 * This moves the connect to server startup and keeps it warm.
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
 */

import { bus, EventNames } from '../event-bus.js'
import { log } from '../../logging/index.js'
import type { SshTarget } from '../../providers/session-io.js'

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
type SweepReason = 'startup' | 'resweep' | 'config' | 'explicit'

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
      const skip = this.skipReason(host, reason === 'explicit')
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
      if (reason === 'resweep' && !this.dueForResweep(host.key)) continue
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

  private record(key: string, state: HostWarmupState, error?: string, notify = true): void {
    const entry: HostWarmupEntry = { state, at: this.now() }
    if (error) entry.error = error
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
      try {
        const result = await this.deps.connect(host.key, host.sshTarget)
        if (!resolvedConnected(result)) {
          // connect() has an early return for "somebody else is mid-connect";
          // a warmup that reported done on that would lie to every surface.
          throw new Error('connect finished without a live connection')
        }
        this.failures.delete(host.key)
        this.record(host.key, 'done')
        this.logger.info('host warmup: connected', { host: host.key, elapsedMs: this.now() - started })
      } catch (err) {
        const message = errText(err)
        const prior = this.failures.get(host.key)
        this.failures.set(host.key, { count: (prior?.count ?? 0) + 1, at: this.now() })
        this.record(host.key, 'failed', message)
        // Expected at startup (host asleep, VPN down) — warn, never throw.
        this.logger.warn('host warmup: connect failed', {
          host: host.key, elapsedMs: this.now() - started, error: message,
          consecutiveFailures: (prior?.count ?? 0) + 1,
        })
      } finally {
        this.inFlight--
      }

      if (this.stopped) return
      if (this.queue.length > 0 && this.paceMs > 0) await this.sleep(this.paceMs)
    }
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

/** A connect result that says `connected: false` is a failure; anything else is trusted. */
function resolvedConnected(result: unknown): boolean {
  if (result && typeof result === 'object' && 'connected' in result) {
    return (result as { connected: unknown }).connected !== false
  }
  return true
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Timers must never hold the process open; typed defensively for DOM lib builds. */
function unref(timer: unknown): void {
  if (timer && typeof timer === 'object' && 'unref' in timer) {
    (timer as { unref: () => void }).unref()
  }
}
