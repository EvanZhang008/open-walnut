/**
 * A host's daemon is replaced automatically at most once every 2 hours.
 *
 * Every server restart with a new daemon build replaced each remote host's daemon, so a
 * run of deploys replaced it once per build (2026-11-03: seven pushes to clouddev in 20
 * minutes; 2026-11-24: 19 swaps of one host in 24 hours, each cutting both of its links). A
 * daemon that started less than the gap ago keeps serving; the update is decided again
 * when the gap ends, with the build the server runs then, so the builds in between are
 * never pushed. Nothing is lost by waiting: a server talks to an older daemon through its
 * capabilities.
 *
 * The same rule on both paths that replace a remote daemon from here: SSH
 * (DaemonConnection.shouldUpgradeDaemon) and the host network (decideNetUpdate), whether
 * the host runs the daemon or its one Walnut service. Not held by it:
 *   - a host with no daemon (that is a start, not a replacement);
 *   - an update someone asked for (host_daemon_update, on either path), until that build runs there;
 *   - an update past the 3 h bound (daemon-update-behind.ts), which every hold gives way to;
 *   - a capability a feature here needs and refuses or degrades without (needCapability,
 *     daemon-capability-need.ts; a missing required one at the handshake), which this build's
 *     daemon has and the running one lacks: the held update is decided again at once.
 * One build is held one gap at most in all: a daemon that keeps restarting (a crash loop)
 * always looks young, and the build that would fix it must still go out.
 * WALNUT_DAEMON_UPDATE_MIN_GAP_MS sets the gap; 0 turns the hold off.
 *
 * The gap's state of a host (its held-since clock, the ask, a capability needed) lives in one
 * place per host for the server's life (hostUpdateGap), never on a connection object: a
 * reconnect that made a new connection lost the ask with the old one, and the next automatic
 * decision held the asked build for the gap again (2026-11-25, a busy host).
 */
import { HOST_DEPENDENT_CAPABILITIES } from './daemon-shared.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { sinceTime } from './daemon-update-wait.js'
import { log } from '../logging/index.js'

export const DAEMON_UPDATE_MIN_GAP_MS = 2 * 60 * 60_000

/**
 * A held update is decided again at least this often (the longest recheck delay of the SSH
 * path): the 3 h bound's clock starts over when a host is not checked for 2 h
 * (DAEMON_UPDATE_BEHIND_STALE_MS), so a recheck only at the gap's end would reset it.
 */
export const DAEMON_UPDATE_GAP_RECHECK_MS = 15 * 60_000

export function daemonUpdateMinGapMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = (env.WALNUT_DAEMON_UPDATE_MIN_GAP_MS ?? '').trim()
  if (!raw) return DAEMON_UPDATE_MIN_GAP_MS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 0 ? n : DAEMON_UPDATE_MIN_GAP_MS
}

/**
 * How long to wait before replacing a daemon that has run `ageMs`; 0 = go now.
 * Unknown age: go now. `heldForMs`, how long this build's update has already been
 * held, caps it at one gap in all.
 */
export function daemonUpdateWaitMs(ageMs: number | null | undefined, gapMs: number, heldForMs = 0): number {
  if (gapMs <= 0 || ageMs === null || ageMs === undefined || !Number.isFinite(ageMs) || ageMs < 0) return 0
  const wait = ageMs < gapMs ? gapMs - ageMs : 0
  return Math.max(0, Math.min(wait, gapMs - Math.max(0, heldForMs)))
}

/** 2 h, 1 h 40 min, 5 min. */
export function spanWords(ms: number): string {
  const total = Math.max(1, Math.round(ms / 60_000))
  const h = Math.floor(total / 60), m = total % 60
  return h ? (m ? `${h} h ${m} min` : `${h} h`) : `${m} min`
}

/** The words for a held update, the same on every path: when it goes, and how to have it now. */
export function daemonUpdateGapWhy(ageMs: number, waitMs: number, o: { host: string; gapMs: number; now?: number }): string {
  const now = o.now ?? Date.now()
  return `its daemon started ${spanWords(ageMs)} ago; Walnut replaces a host's daemon by itself at most once every ${spanWords(o.gapMs)}, `
    + `so this update goes at ${sinceTime(now + waitMs, now)} with the build of then (host_daemon_update ${o.host} does it now)`
}

/** The words for an update the gap no longer holds because this server needs `cap`. */
export function capabilityNeedWhy(cap: string): string {
  return `a feature here needs ${cap}, which this build's daemon has and the running one lacks, so the update no longer waits for the gap`
}

/**
 * Capabilities a daemon says by where it runs, never by its build, so no update brings them:
 * the host-dependent ones (daemon-shared.ts) and those of the WebSocket door, which a daemon
 * inside a server's process does not claim (daemon-standalone.ts DOOR_CAPABILITIES;
 * tests/providers/daemon-update-gap.test.ts keeps the two lists equal).
 */
export const DOOR_CAPABILITIES: ReadonlySet<string> = new Set(['net-v1', 'net-join-v1', 'net-web-v1', 'host-server-v1', 'hub-forward-v1'])
const BY_BUILD: ReadonlySet<string> = new Set(ADVERTISED_DAEMON_CAPABILITIES.filter((c) => !HOST_DEPENDENT_CAPABILITIES.has(c) && !DOOR_CAPABILITIES.has(c)))

/** This build's daemon has `cap` wherever it runs: a daemon that lacks it lacks it by its build. */
export function capabilityByBuild(cap: string): boolean {
  return BY_BUILD.has(cap)
}

export interface GapFacts {
  host: string
  /** How long the running daemon has run; null or undefined: unknown. */
  ageMs: number | null | undefined
  gapMs: number
  /** How long this build's update has been held by the gap already. */
  heldForMs?: number
  /** Past the 3 h bound (daemon-update-behind.ts). */
  overdue?: boolean
  /** A capability a feature here needs that the running daemon lacks (needCapability, a missing required one). */
  needs?: string | null
  /** Someone asked for this build (host_daemon_update): the gap no longer holds it. */
  asked?: boolean
  now?: number
}

/** Whether the gap holds this update now: how long, until when, and its words; null = it goes. Pure. */
export function daemonUpdateGapHold(f: GapFacts): { waitMs: number; until: number; why: string } | null {
  if (f.overdue || f.needs || f.asked) return null
  const waitMs = daemonUpdateWaitMs(f.ageMs, f.gapMs, f.heldForMs ?? 0)
  if (waitMs <= 0) return null
  const now = f.now ?? Date.now()
  return { waitMs, until: now + waitMs, why: daemonUpdateGapWhy(f.ageMs!, waitMs, { host: f.host, gapMs: f.gapMs, now }) }
}

/** What the asker of an update said (host_daemon_update). */
export interface UpdateAsk {
  /**
   * Go over the work in progress there now: the update takes the forced path an overdue one takes
   * (daemon-over-busy.ts), for the asked build only. Absent: it waits for that work, as before.
   */
  overBusy?: boolean
}

/**
 * The gap's state of one host, for both paths (hostUpdateGap gives the SSH path of DaemonConnection
 * and its NetDaemonUpdater the same one): since when a build has been held (one gap at most in all,
 * kept for that build once it passed), whether the gap holds it now, the build someone asked for (it
 * goes past the gap until it runs there or another build is expected) with what the asker said and
 * the asker's gate, a capability a feature needs that the running daemon lacks (noted once per
 * running build), and the swaps of a build that went over the host's work (MAX_FORCED_TRIES).
 */
/**
 * Swaps of one build that went over the host's work (overdue, or asked with over_busy) before it is
 * not forced again: a host that still runs another build after them (a broken version stamp, a
 * wrapper that starts the old file) would have its work ended on every retry for good.
 */
export const MAX_FORCED_TRIES = 3

/** The grants file could not be read just now (host-exec-grant.ts): no answer on the grant, never a revoke. */
const GRANTS_UNREADABLE = 'exec_grants_unreadable'

export class UpdateGapHold {
  private build: { expected: string; since: number } | null = null
  private holding: { expected: string; until: number } | null = null
  private needed: { running: string; cap: string } | null = null
  private askedFor: { expected: string; overBusy: boolean; gate?: () => void } | null = null
  private forcedTries: { expected: string; n: number } | null = null

  /**
   * Decide the gap for `expected`, with this build's held time, its ask, and the running build's need.
   * `f.asked`: this decision is the asked run itself, which goes past the gap whatever the ask reads
   * now (a grant revoked meanwhile is the run's own refusal to say, at its gate).
   */
  decide(expected: string, f: Omit<GapFacts, 'heldForMs' | 'needs'> & { running: string | null }): { waitMs: number; until: number; why: string } | null {
    const now = f.now ?? Date.now()
    const hold = daemonUpdateGapHold({ ...f, now, heldForMs: this.heldForMs(expected, now), needs: this.needs(f.running), asked: f.asked || this.asked(expected) })
    if (hold) this.held(expected, hold.until, now)
    else this.release()
    return hold
  }

  /** How long the gap has held `expected` in all (0 for a build it never held). */
  heldForMs(expected: string, now: number = Date.now()): number {
    return this.build?.expected === expected ? Math.max(0, now - this.build.since) : 0
  }

  /** The gap holds `expected` until `until` (its clock starts at the first hold of that build). */
  held(expected: string, until: number, now: number = Date.now()): void {
    if (this.build?.expected !== expected) this.build = { expected, since: now }
    this.holding = { expected, until }
  }

  /** The gap no longer holds it (the update went, the host runs this build, or another hold decides now). */
  release(): void { this.holding = null }

  /** Whether the gap holds an update now; fields only. */
  get holds(): boolean { return this.holding !== null }

  /** Until when the gap holds it (ms epoch); null when it does not. */
  get until(): number | null { return this.holding?.until ?? null }

  /**
   * Someone asked for `expected` (host_daemon_update): every later decision of that build goes past
   * the gap, so an ask a safety hold put off (an open ACP turn) is not then held for up to 2 h. The
   * latest ask's words count: an ask without `overBusy` after one with it waits for the work again.
   * `gate` (the asking task's grant) is read again at every later read of the ask, the automatic
   * retries included: once it throws (the grant revoked, the host closed to tasks) the ask is gone.
   * An ask with `overBusy` starts the build's forced swaps over: the bound is on the retries no one
   * asked for, and a busy answer offers over_busy again (daemonBusyWhy).
   */
  ask(expected: string, said: UpdateAsk = {}, gate?: () => void): void {
    this.askedFor = { expected, overBusy: said.overBusy === true, ...(gate ? { gate } : {}) }
    if (said.overBusy === true && this.forcedTries?.expected === expected) this.forcedTries = null
  }
  /** The asker may no longer have it run (its grant was revoked): the ask is gone, the gap holds as before. */
  unask(expected: string): void { if (this.askedFor?.expected === expected) this.askedFor = null }
  asked(expected: string): boolean { return this.standing(expected) !== null }
  /**
   * The asker of `expected` said to go over the work in progress (UpdateAsk.overBusy), and the build
   * has not used up its forced swaps (MAX_FORCED_TRIES): once it has, the ask stops forcing and waits
   * for the work as a plain ask does.
   */
  overBusy(expected: string | null | undefined): boolean {
    const ask = expected ? this.standing(expected) : null
    if (!ask?.overBusy) return false
    if (!this.forcedSpent(ask.expected)) return true
    ask.overBusy = false
    log.session.warn('DaemonConnection: daemon update asked over busy went over the host\'s work and it still runs another build; it waits for a quiet moment again', {
      expected: ask.expected, tries: this.forcedTries!.n,
    })
    return false
  }
  /** The ask of `expected` while its asker may still have it run (its gate, read now); null otherwise. */
  private standing(expected: string): { expected: string; overBusy: boolean; gate?: () => void } | null {
    const ask = this.askedFor
    if (ask?.expected !== expected) return null
    try { ask.gate?.() } catch (err) {
      // A grants file read only in part for a moment (a sync merge) is no revoke: the ask waits for the next read.
      if ((err as { code?: unknown } | null)?.code === GRANTS_UNREADABLE) return null
      log.session.info('DaemonConnection: an asked daemon update ends, its asker may no longer have it run', {
        expected, code: (err as { code?: unknown } | null)?.code ?? null,
      })
      this.askedFor = null
      return null
    }
    return ask
  }

  /**
   * What the host runs, as a decision read it (`running`; empty: no daemon). The asked build running
   * there ends its ask: a later decision of it after the host went back to another build (another
   * Walnut sharing the daemon swapped it) is an automatic one again, never forced with nobody asking.
   * Running it, or nothing, ends its forced swaps too.
   */
  runs(running: string | null | undefined, expected: string): void {
    if (!running || running === expected) this.forcedTries = null
    if (running === expected) this.unask(expected)
  }

  /** A swap of `expected` that goes over the host's work is starting (counted against MAX_FORCED_TRIES). */
  forcedTry(expected: string): void {
    this.forcedTries = { expected, n: this.forcedTries?.expected === expected ? this.forcedTries.n + 1 : 1 }
  }
  /**
   * A counted try whose swap never happened (held or deferred on the host after its upload): it went
   * over nothing, so it does not use up the forced tries (2026-11-10 review: three dark-wake deferrals
   * spent them, and the holds were back with no bound).
   */
  forcedTryUndone(expected: string): void {
    if (this.forcedTries?.expected !== expected) return
    this.forcedTries = this.forcedTries.n > 1 ? { expected, n: this.forcedTries.n - 1 } : null
  }
  /** `expected` went over the host's work MAX_FORCED_TRIES times and the host still runs another build. */
  forcedSpent(expected: string): boolean {
    return this.forcedTries?.expected === expected && this.forcedTries.n >= MAX_FORCED_TRIES
  }
  /** The forced swaps counted, for tests and logs; fields only. */
  get forced(): { expected: string; n: number } | null { return this.forcedTries ? { ...this.forcedTries } : null }

  /** The capability noted while `running` runs there, if any. */
  needs(running: string | null | undefined): string | null {
    return running && this.needed?.running === running ? this.needed.cap : null
  }

  /**
   * A feature here needs `cap` and the daemon running `running` lacks it. True the first time per
   * running build when this build's daemon has it: the caller decides a held update again now.
   */
  need(cap: string, running: string | null | undefined): boolean {
    if (!running || this.needed?.running === running || !capabilityByBuild(cap)) return false
    this.needed = { running, cap }
    return true
  }
}

/**
 * The one place a host's gap state lives: one per host key, for the server's life, read by every
 * connection to that host on either path (tests/providers/daemon-update-gap-place.test.ts fails on
 * any other place that builds one). On globalThis so a test setup can clear it without importing the app
 * (tests/setup/outage-repeat-reset.ts).
 */
const HOST_GAPS = Symbol.for('open-walnut.hostUpdateGaps')
export function hostUpdateGap(host: string): UpdateGapHold {
  const g = globalThis as unknown as Record<symbol, Map<string, UpdateGapHold> | undefined>
  const all = (g[HOST_GAPS] ??= new Map())
  let gap = all.get(host)
  if (!gap) all.set(host, gap = new UpdateGapHold())
  return gap
}

/** `ps -o etime=` ([[DD-]HH:]MM:SS) in ms, or null. */
export function parseEtimeMs(text: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!m) return null
  const [days, hours, mins, secs] = [m[1], m[2], m[3], m[4]].map((v) => (v ? parseInt(v, 10) : 0))
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000
}
