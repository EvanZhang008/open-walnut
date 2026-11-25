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
 *   - an update someone asked for (host_daemon_update, on either path);
 *   - an update past the 3 h bound (daemon-update-behind.ts), which every hold gives way to;
 *   - a capability this server asked the connection for that this build's daemon has and the
 *     running one lacks (UpdateGapHold.need): the held update is decided again at once.
 * One build is held one gap at most in all: a daemon that keeps restarting (a crash loop)
 * always looks young, and the build that would fix it must still go out.
 * WALNUT_DAEMON_UPDATE_MIN_GAP_MS sets the gap; 0 turns the hold off.
 */
import { HOST_DEPENDENT_CAPABILITIES } from './daemon-shared.js'
import { ADVERTISED_DAEMON_CAPABILITIES } from './daemon-capabilities.js'
import { sinceTime } from './daemon-update-wait.js'

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
  return `this server needs ${cap}, which this build's daemon has and the running one lacks, so the update no longer waits for the gap`
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
  /** A capability this server asked for that the running daemon lacks (UpdateGapHold.need). */
  needs?: string | null
  now?: number
}

/** Whether the gap holds this update now: how long, until when, and its words; null = it goes. Pure. */
export function daemonUpdateGapHold(f: GapFacts): { waitMs: number; until: number; why: string } | null {
  if (f.overdue || f.needs) return null
  const waitMs = daemonUpdateWaitMs(f.ageMs, f.gapMs, f.heldForMs ?? 0)
  if (waitMs <= 0) return null
  const now = f.now ?? Date.now()
  return { waitMs, until: now + waitMs, why: daemonUpdateGapWhy(f.ageMs!, waitMs, { host: f.host, gapMs: f.gapMs, now }) }
}

/**
 * The gap's state on one connection, for both paths (DaemonConnection owns one and hands it to
 * its NetDaemonUpdater): since when a build has been held (one gap at most in all, kept for
 * that build once it passed), whether the gap holds it now, and a capability need noted once.
 */
export class UpdateGapHold {
  private build: { expected: string; since: number } | null = null
  private holding: { expected: string; until: number } | null = null
  private needed: { expected: string; cap: string } | null = null

  /** Decide the gap for `expected` (the pure rule above, with this build's held time and need). */
  decide(expected: string, f: Omit<GapFacts, 'heldForMs' | 'needs'>): { waitMs: number; until: number; why: string } | null {
    const now = f.now ?? Date.now()
    const hold = daemonUpdateGapHold({ ...f, now, heldForMs: this.heldForMs(expected, now), needs: this.needs(expected) })
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

  /** Whether the gap holds an update now; read on every capability miss, so fields only. */
  get holds(): boolean { return this.holding !== null }

  /** Until when the gap holds it (ms epoch); null when it does not. */
  get until(): number | null { return this.holding?.until ?? null }

  /** The capability noted for `expected`, if any. */
  needs(expected: string): string | null {
    return this.needed?.expected === expected ? this.needed.cap : null
  }

  /**
   * The connection was asked for `cap` and its daemon lacks it. True once per held build when
   * this build's daemon has it: the caller decides the update again now. Cheap: a capability
   * check runs on many paths, often each time.
   */
  need(cap: string): boolean {
    const held = this.holding
    if (!held || this.needed?.expected === held.expected || !capabilityByBuild(cap)) return false
    this.needed = { expected: held.expected, cap }
    return true
  }
}

/** `ps -o etime=` ([[DD-]HH:]MM:SS) in ms, or null. */
export function parseEtimeMs(text: string): number | null {
  const m = /^\s*(?:(\d+)-)?(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*$/.exec(text)
  if (!m) return null
  const [days, hours, mins, secs] = [m[1], m[2], m[3], m[4]].map((v) => (v ? parseInt(v, 10) : 0))
  return (((days * 24 + hours) * 60 + mins) * 60 + secs) * 1000
}
