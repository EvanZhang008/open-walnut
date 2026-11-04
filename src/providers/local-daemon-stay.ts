/**
 * The probation of a daemon this server started to replace another one (local-daemon.ts, with the
 * copies of local-daemon-replace.ts): it counts as up only once it stayed STAY_MS, and till then
 * the build before it stays the one to go back to.
 *
 * 2026-11-04 review 5: it was 30 s on a monotonic clock, in memory only, and looked once at its
 * end. Review 6: a daemon found gone long after the window (a server that was down at its end)
 * was refused as if it died inside it.
 */
import os from 'node:os'
import type { ProvenRecord, StayRecord } from './daemon-update-store.js'

/**
 * How long a daemon started to replace another one must stay serving before it counts as up (its
 * probation, on the wall clock), and the file of the build before it stays the one to go back to.
 * 2026-11-04 review 5: 30 s, so a build that died at its first session spawn, on a 60 s timer or
 * after the fold prewarm passed, and its file took the one slot of the build before it.
 */
export const STAY_MS = 15 * 60_000
/** How often a daemon on its probation is looked at (one gone is started over at once, not at the end). */
export const STAY_CHECK_EVERY_MS = 10_000
/**
 * A daemon first found gone later than this after its window's end may have stayed through it (no
 * one looked at its end: a server that was down then): its build is watched anew, from its next
 * start, rather than refused or kept.
 */
export const STAY_SETTLE_SLACK_MS = 3 * STAY_CHECK_EVERY_MS
/** Two boot times further apart than this are two boots (os.uptime is read in whole seconds, and a clock may be set). */
const BOOT_SLACK_MS = 2 * 60_000

/** Where a StayWatch keeps its watch (daemon-update-store.ts stayWatches, under `local:<dir>`). */
export interface StayStore {
  read(): Promise<StayRecord | null>
  write(entry: StayRecord | null): Promise<void>
}

/** Where a StayWatch keeps the build proven here (daemon-update-store.ts provenBuilds, under `local:<dir>`). */
export interface ProvenStore {
  read(): Promise<ProvenRecord | null>
  write(entry: ProvenRecord | null): Promise<void>
}

/** When this boot began, on the wall clock. */
export const bootTime = (): number => Date.now() - os.uptime() * 1000

/**
 * The daemon started to replace another one, until it stayed serving STAY_MS (its probation, on
 * the wall clock: a Mac that slept through it still had it run). Looked at every
 * STAY_CHECK_EVERY_MS while `alive` is known: `due` runs once the window is over or the daemon is
 * gone, and settle() then answers once: null while it stays or once it did, else the refusal's
 * words; passed() says whether the watch that ended was stayed through. A pid not known is not
 * judged until claim() names it, and a window that ends with none named passed nothing.
 *
 * Kept on disk (`store`): a server restarted inside the window resumes it (resume), and keeps
 * the build before it as the one to go back to till then. A reboot since is no failure: the
 * daemon it ended is started again by this server, and its probation starts over with it.
 *
 * The build proven here (`proven`, on disk too): the last one that stayed through its watch, or
 * that the server vouched for (prove: found serving with no watch). A start of any other build is
 * a replacement (2026-11-05 review 6: one that never ran here was started unwatched).
 */
export class StayWatch {
  private watched: StayRecord | null = null
  private ended: { expected: string; passed: boolean } | null = null
  private due: ((expected: string) => void) | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private resumed = false
  /** The build proven here; undefined until read from `proven`. */
  private provenBuild: string | null | undefined = undefined

  constructor(
    private readonly stayMs = STAY_MS,
    private readonly now: () => number = () => Date.now(),
    private readonly o: { store?: StayStore; proven?: ProvenStore; alive?: (pid: number) => boolean; everyMs?: number; bootAt?: () => number } = {},
  ) {}

  /**
   * Watch the daemon `pid` started for `expected` (null: not started yet, named by claim() or the
   * next start); `due` runs once the window is over, or once it is gone. The promise: the watch is
   * on disk. One before it is replaced in one write, never cleared first.
   */
  start(expected: string, pid: number | null, due: (expected: string) => void): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.ended = null
    this.resumed = true
    this.watched = { expected, pid, at: this.now(), bootAt: (this.o.bootAt ?? bootTime)() }
    const written = this.o.store?.write(this.watched) ?? Promise.resolve()
    this.due = due
    this.arm(this.due)
    return written.catch(() => {})
  }

  /** `expected` stayed through a probation here, or was vouched for (prove); read once from disk. */
  async proven(expected: string): Promise<boolean> {
    if (this.provenBuild === undefined) {
      const kept = await this.o.proven?.read().catch(() => null)
      // prove() may have run while the read was out: its word stands.
      if (this.provenBuild === undefined) this.provenBuild = kept?.expected ?? null
    }
    return this.provenBuild === expected
  }

  /** `expected` is the build proven here from now on (its watch passed, or it serves with none). */
  prove(expected: string): void {
    if (this.provenBuild === expected) return
    this.provenBuild = expected
    void this.o.proven?.write({ at: this.now(), expected }).catch(() => {})
  }

  /**
   * The watch a server before this one kept, taken up once (nothing when this one watches
   * already): the same boot, for what is left of its window (one past it is settled at once); a
   * boot since, over again from now with its pid not known (the start after the boot names it).
   */
  async resume(due: (expected: string) => void): Promise<void> {
    if (this.resumed) return
    this.resumed = true
    const kept = await this.o.store?.read().catch(() => null)
    if (!kept || this.watched) return
    const boot = (this.o.bootAt ?? bootTime)()
    this.due = due
    if (Math.abs(kept.bootAt - boot) > BOOT_SLACK_MS) this.anew(kept.expected)
    else {
      this.watched = kept
      this.arm(due)
    }
  }

  /** The daemon of `expected` started or found now: its pid, when the watch does not know it yet. */
  claim(expected: string, pid: number | null): void {
    const w = this.watched
    if (!w || w.expected !== expected || w.pid !== null || pid === null) return
    w.pid = pid
    void this.o.store?.write(w)
  }

  /** The daemon of `expected` is stopped and started again by this server (not its failure): its pid is not known till claim(). */
  forgetPid(expected: string): void {
    const w = this.watched
    if (!w || w.expected !== expected || w.pid === null) return
    w.pid = null
    void this.o.store?.write(w)
  }

  /** The build watched now, or null. */
  current(): string | null {
    return this.watched?.expected ?? null
  }

  /** A daemon of `expected` is watched now: not yet past its window. */
  watching(expected: string): boolean {
    return this.watched?.expected === expected
  }

  /** How long the watch of `expected` has left (0: none). */
  leftMs(expected: string): number {
    const w = this.watched
    return w && w.expected === expected ? Math.max(0, this.stayMs - (this.now() - w.at)) : 0
  }

  /** The last watch that ended was of `expected`, and its daemon stayed serving through it. */
  passed(expected: string): boolean {
    return this.ended?.expected === expected && this.ended.passed
  }

  /**
   * `served`: the build the daemon on the port answers as (null: none answers; undefined: not
   * asked). A watch past its window passes only on its own build answering: its pid alone may be
   * another process's by then (a server away longer than the window; 2026-11-05 review 8: a dead
   * build passed, was proven, and later started plain), so one that does not is watched anew.
   */
  settle(alive: (pid: number) => boolean, served?: string | null): { expected: string; reason: string } | null {
    const w = this.watched
    if (!w) return null
    const lived = this.now() - w.at
    // No daemon of it was named in its window (a reboot, a restart no start claimed): nothing of it
    // was watched, so its end passes nothing.
    if (w.pid === null) {
      if (lived >= this.stayMs) this.end(w, false)
      return null
    }
    if (alive(w.pid)) {
      if (lived >= this.stayMs) {
        if (served !== undefined && served !== w.expected) this.anew(w.expected)
        else this.end(w, true)
      }
      return null
    }
    // Found gone only well past its window: when it went is not known, so it is neither refused
    // nor kept; the start that follows is watched over again (2026-11-04 review 7: ending the watch
    // here left a build that kept dying started unwatched, with the way back never used).
    if (lived > this.stayMs + STAY_SETTLE_SLACK_MS) {
      this.anew(w.expected)
      return null
    }
    this.end(w, false)
    return { expected: w.expected, reason: `it stopped within ${Math.max(1, Math.round(lived / 1000))} s after it started on the real dir` }
  }

  clear(): void {
    if (this.watched) void this.o.store?.write(null)
    this.watched = null
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
  }

  /** The watch of `expected` over again from now, its pid not known till claim() (the start after it names it). */
  private anew(expected: string): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = null }
    this.watched = { expected, pid: null, at: this.now(), bootAt: (this.o.bootAt ?? bootTime)() }
    void this.o.store?.write(this.watched)
    if (this.due) this.arm(this.due)
  }

  private end(w: StayRecord, passed: boolean): void {
    this.clear()
    this.ended = { expected: w.expected, passed }
    if (passed) this.prove(w.expected)
  }

  private arm(due: (expected: string) => void): void {
    const w = this.watched
    if (!w) return
    const left = this.stayMs - (this.now() - w.at)
    // Without a way to look at the pid, only the window's end.
    const every = this.o.alive ? (this.o.everyMs ?? STAY_CHECK_EVERY_MS) : Infinity
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.watched !== w) return
      const gone = w.pid !== null && !!this.o.alive && !this.o.alive(w.pid)
      if (gone || this.now() - w.at >= this.stayMs) due(w.expected)
      else this.arm(due)
    }, Math.max(0, Math.min(every, left + 50)))
    this.timer.unref?.()
  }
}
