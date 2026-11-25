/**
 * The slash palette's host reads: answered from a cache at once, or within a
 * short budget, never by waiting out the host.
 *
 * The palette is a decoration of the composer: its list is worth a second at
 * most. A request that waited for a cold remote scan (about a hundred daemon
 * round trips per host, plus a stream tail of up to 5 MB per session) held a
 * browser connection for 7 to 15 s after every server restart, one scan per
 * session folder, several at once on the same link (2026-11-25, eleven slow
 * reads in an hour after a wake and two deploys). Now:
 *  - one scan per key runs at a time, however many requests ask (they join it);
 *  - the scan writes its result to the cache when it lands, whether or not the
 *    request that started it is still waiting, so the next ask is instant;
 *  - a cached list always answers at once (an expired one starts one
 *    revalidation in the background), and only a cold cache can degrade;
 *  - a request waits for a scan at most its budget, then answers without it;
 *  - the entries outlive a restart (slash-commands-disk.ts writes them to cache/): one read
 *    back keeps its age, so it answers at once and an expired one is revalidated as above.
 */
import { withDeadline } from '../../lib/with-deadline.js'
import { registerMemoryHolder, stringCharsOf } from '../../core/observability/memory-ledger.js'
import type { KeptSection } from '../../core/kept-cache-file.js'

/** How long one palette request waits for its host reads before it answers without them. */
export const PALETTE_HOST_BUDGET_MS = 1_500

/** A scan read back from disk older than this is not taken back (a server down a day or more). */
export const PALETTE_RESTORE_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** `run()` for `key`, started once while it runs: concurrent callers share one promise. */
export function sharedFlight<T>(flights: Map<string, Promise<T>>, key: string, run: () => Promise<T>): Promise<T> {
  const running = flights.get(key)
  if (running) return running
  const flight = run().finally(() => {
    if (flights.get(key) === flight) flights.delete(key)
  })
  flights.set(key, flight)
  return flight
}

/** `work` within `budgetMs`: `{ value }`, or null when the budget passed first (the work goes on). */
export function withinBudget<T>(work: Promise<T>, budgetMs: number): Promise<{ value: T } | null> {
  return withDeadline(work.then((value) => ({ value })), budgetMs, () => null)
}

/**
 * Stale-while-revalidate cache for one kind of palette scan, keyed by what shapes it.
 * On the memory ledger by `name`; past `maxEntries` the entry written longest ago goes.
 */
export class PaletteScanCache<T> implements KeptSection {
  private readonly entries = new Map<string, { time: number; value: T }>()
  /** The entries a previous process kept, being read back: a read waits for them (within its budget). */
  private restoring: Promise<void> | null = null
  private changed: (() => void) | null = null
  /** The scan running per key; `fresh` = started for a refresh, so a later refresh may join it. */
  private readonly flights = new Map<string, { work: Promise<T>; fresh: boolean; lateHeard: boolean }>()

  constructor(
    name: string,
    private readonly ttlMs: number,
    private readonly maxEntries: number,
    budgetBytes: number,
    /** Whether a value read back from disk has this cache's shape (anything else is dropped). */
    private readonly isValue: (value: unknown) => value is T = (_v: unknown): _v is T => false,
  ) {
    registerMemoryHolder({
      name, budgetBytes,
      read: () => {
        let chars = 0
        for (const [key, entry] of this.entries) chars += key.length + stringCharsOf(entry.value)
        return { entries: this.entries.size, chars }
      },
    })
  }

  /**
   * The scan for `key`, once while it runs; its result is cached when it lands,
   * answered or not. A `fresh` ask never takes the answer of a scan that began
   * before it (a revalidation that may predate the change the user refreshed
   * for): it starts another one, after the running one so the newer result is
   * written last, and later asks join that.
   */
  private scanOnce(key: string, scan: () => Promise<T>, fresh: boolean): { work: Promise<T>; fresh: boolean; lateHeard: boolean } {
    const running = this.flights.get(key)
    if (running && (!fresh || running.fresh)) return running
    const before = running ? running.work.then(() => undefined, () => undefined) : Promise.resolve()
    const flight = { work: before.then(scan).then((value) => {
      this.entries.delete(key)
      this.entries.set(key, { time: Date.now(), value })
      this.trim()
      this.changed?.()
      return value
    }), fresh, lateHeard: false }
    flight.work.finally(() => {
      if (this.flights.get(key) === flight) this.flights.delete(key)
    }).catch(() => { /* the readers of `work` hear its failure */ })
    this.flights.set(key, flight)
    return flight
  }

  /**
   * The list for `key`. Not `fresh`: a cached one answers at once (an expired
   * one is revalidated in the background). Otherwise, or when nothing is
   * cached: the scan (joined when one runs, see scanOnce) within `budgetMs`. A
   * scan that is late or fails answers the cached list when there is one; with
   * none, a late scan is null (it goes on and fills the cache) and a failed one
   * throws its error. A failure no request waits for any more (a background
   * revalidation, or a scan that failed after its budget) goes to
   * `onBackgroundError`, once per scan.
   */
  async read(
    key: string,
    scan: () => Promise<T>,
    opts: { fresh?: boolean; budgetMs: number; onBackgroundError: (err: unknown) => void },
  ): Promise<{ value: T } | null> {
    let budgetMs = opts.budgetMs
    if (this.restoring) {
      const began = Date.now()
      await withinBudget(this.restoring, budgetMs)
      budgetMs = Math.max(0, budgetMs - (Date.now() - began))
    }
    const cached = this.entries.get(key)
    if (cached && !opts.fresh) {
      if (Date.now() - cached.time >= this.ttlMs && !this.flights.has(key)) {
        this.hearLateFailure(this.scanOnce(key, scan, false), opts.onBackgroundError)
      }
      return { value: cached.value }
    }
    const flight = this.scanOnce(key, scan, opts.fresh === true)
    try {
      const out = await withinBudget(flight.work, budgetMs)
      if (out) return out
      this.hearLateFailure(flight, opts.onBackgroundError)
    } catch (err) {
      if (!cached) throw err
      opts.onBackgroundError(err)
    }
    return cached ? { value: cached.value } : null
  }

  /** The scan's failure, if it comes, is heard once (several late asks may have left it). */
  private hearLateFailure(flight: { work: Promise<T>; lateHeard: boolean }, onError: (err: unknown) => void): void {
    if (flight.lateHeard) return
    flight.lateHeard = true
    flight.work.catch(onError)
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) this.entries.delete(this.entries.keys().next().value as string)
  }

  /** Every entry as `[key, time, value]`, the one written longest ago first (KeptSection). */
  forDisk(): Array<[string, number, T]> {
    return [...this.entries].map(([key, e]) => [key, e.time, e.value])
  }

  /**
   * Take back the entries a previous process kept (KeptSection), with their age (a time
   * ahead of this clock counts as now), so an expired one answers once and is revalidated.
   * A key this process already scanned keeps its own, newer entry; those read back are older
   * than any of this process, so they go first past the cap. A malformed entry, or one older
   * than PALETTE_RESTORE_MAX_AGE_MS, is dropped: that host is scanned as on a first boot.
   */
  restore(data: Promise<unknown>): Promise<void> {
    const work = data.then((rows) => {
      if (!Array.isArray(rows)) return
      const now = Date.now()
      const back = new Map<string, { time: number; value: T }>()
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 3) continue
        const [key, time, value] = row as [unknown, unknown, unknown]
        if (typeof key !== 'string' || typeof time !== 'number' || !Number.isFinite(time) || !this.isValue(value)) continue
        if (now - time > PALETTE_RESTORE_MAX_AGE_MS) continue
        if (this.entries.has(key)) continue
        back.delete(key)
        back.set(key, { time: Math.min(time, now), value })
      }
      if (back.size === 0) return
      const mine = [...this.entries]
      this.entries.clear()
      for (const [k, e] of back) this.entries.set(k, e)
      for (const [k, e] of mine) { this.entries.delete(k); this.entries.set(k, e) }
      this.trim()
    }, () => undefined)
    const restoring = work.finally(() => {
      if (this.restoring === restoring) this.restoring = null
    })
    this.restoring = restoring
    return restoring
  }

  /** `changed` is called after each entry written (KeptSection). */
  onChange(changed: () => void): void {
    this.changed = changed
  }

  /** Test seam: the scans running now, settled (a test waits out the reads it left behind). */
  async settled(): Promise<void> {
    await Promise.allSettled([...this.flights.values()].map((f) => f.work))
  }

  /** Test seam: forget every entry and running scan. */
  clear(): void {
    this.entries.clear()
    this.flights.clear()
    this.restoring = null
  }
}
