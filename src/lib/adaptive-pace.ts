/**
 * The upload pace one connection to one host learns, with no setting (pure: no I/O, no clock).
 *
 * Most hosts are plain SSH and take an upload at full speed; some sit behind a relay on the SSH
 * path that ends a connection whose upload is fast or bursty (the measurements are in
 * providers/ssh-upload-budget.ts). Nothing tells the two apart up front, so a host starts with no
 * memory, which is unpaced, and only a connection ended while it carried an upload teaches:
 *
 *   - unpaced (no memory) --cut--> paced at a third of the rate the cut came at (its ceiling),
 *     never under `floor`; the burst is `burstSec` of the rate (at least `minBurstBytes`).
 *     On the relay measured (lives at 10 to 20 KB/s smooth, ends 100 KB/s or more within
 *     seconds) a cut at 500 KB/s is paced at 167, then 56, then 19 KB/s: three cuts.
 *   - paced --cut--> a third of the new ceiling (the lower of the rate measured and the cap).
 *   - paced --`probeAfterDemandMs` of demand with no cut--> up by `probeStep`, kept under
 *     `probeHeadroom` x ceiling while the last cut is within `ceilingKeepMs`. Demand is time
 *     the pacer held bytes back: an idle connection proves nothing about a faster pace.
 *   - a ceiling older than `ceilingKeepMs` is forgotten; probing then goes up by `freeStep`
 *     and past `unpacedFromBytesPerSec` the memory is dropped: unpaced again.
 *
 * Why these numbers: a third puts the first paced rate well under the cut one (a relay that
 * ends at 30 KB/s often and at 100 KB/s always gives no room for a gentler step, and every cut
 * costs a redial and the frame in flight). +20% per 10 minutes of demand takes about 50 minutes
 * of real upload from a third of the ceiling back to 0.8 of it, while 20 KB/s with 96 KB bursts
 * lived 7 to 476 s on that relay, so a pace that is still too high shows within one probe step.
 * 24 h: a relay's rule is a property of the path, not of the hour; after a day with no cut the
 * path may have changed (another network, the relay gone), and doubling per probe gets from the
 * floor back to unpaced in 60 to 80 minutes of demand.
 */

export interface PaceLimits {
  bytesPerSec: number
  burstBytes: number
}

/** What a host's connection learned (null anywhere it is held: no memory, unpaced). */
export interface PaceMemory {
  /** The pace the upload is held to, bytes per second. */
  rate: number
  /** The rate the last cut came at, or null once forgotten. */
  ceiling: number | null
  /** When the last cut that taught came (wall clock ms). */
  cutAt: number
  /** Demand (ms the pacer held bytes back) since the last cut or probe; not kept across restarts. */
  demandMs: number
  /** When it last changed (wall clock ms). */
  at: number
}

export interface PaceRules {
  /** The lowest pace a cut sets, bytes per second. */
  floor: number
  /** The rate after a cut, as a part of the ceiling. */
  cutFactor: number
  /**
   * The ceiling a cut sets is at least this part of the pace in force then: a cut whose last
   * seconds carried little (a pause between frames) says little about the rate that was cut.
   */
  ceilingMinOfCap: number
  burstSec: number
  minBurstBytes: number
  probeAfterDemandMs: number
  probeStep: number
  probeHeadroom: number
  ceilingKeepMs: number
  freeStep: number
  unpacedFromBytesPerSec: number
  /** A connection that sent a byte within this long before it ended was uploading. */
  uploadRecentMs: number
}

export const DEFAULT_PACE_RULES: PaceRules = {
  floor: 4 * 1024,
  cutFactor: 1 / 3,
  ceilingMinOfCap: 0.5,
  burstSec: 1.5,
  minBurstBytes: 16 * 1024,
  probeAfterDemandMs: 10 * 60_000,
  probeStep: 1.2,
  probeHeadroom: 0.8,
  ceilingKeepMs: 24 * 3600_000,
  freeStep: 2,
  unpacedFromBytesPerSec: 1024 * 1024,
  uploadRecentMs: 5_000,
}

/** The pacer's limits for a memory: null is unpaced. */
export function paceLimits(mem: PaceMemory | null, rules: PaceRules = DEFAULT_PACE_RULES): PaceLimits | null {
  if (!mem) return null
  const bytesPerSec = Math.round(mem.rate)
  return { bytesPerSec, burstBytes: Math.max(rules.minBurstBytes, Math.round(bytesPerSec * rules.burstSec)) }
}

/** How one connection ended, as its owner saw it. */
export interface ConnectionEnd {
  /** Walnut stopped it (a teardown, a redial, a server stop). */
  byWalnut: boolean
  /** Ms from its last byte up to its end, or null: it never sent one. */
  sinceSentMs: number | null
  /** Bytes still waiting behind the pacer when it ended. */
  queuedBytes: number
  /** The host's whole link went down near the same time (sleep, network loss, a wake). */
  hostLinkDropped: boolean
}

/** Only a connection that ended of its own while it carried an upload teaches. */
export function cutTeaches(end: ConnectionEnd, rules: PaceRules = DEFAULT_PACE_RULES): boolean {
  if (end.byWalnut || end.hostLinkDropped) return false
  return end.queuedBytes > 0 || (end.sinceSentMs !== null && end.sinceSentMs <= rules.uploadRecentMs)
}

/**
 * The memory after a cut: `measured` is the upload rate of its last seconds, `cap` the pace it
 * was held to (null: unpaced). Unchanged when the cut says nothing about a rate.
 */
export function learnFromCut(
  mem: PaceMemory | null, cut: { at: number; measured: number; cap: number | null }, rules: PaceRules = DEFAULT_PACE_RULES,
): PaceMemory | null {
  const measured = Number.isFinite(cut.measured) && cut.measured > 0 ? cut.measured : null
  const ceiling = cut.cap === null ? measured
    : Math.max(cut.cap * rules.ceilingMinOfCap, Math.min(measured ?? cut.cap, cut.cap))
  if (ceiling === null) return mem
  // A cut never raises the pace (one from a connection that began at an older, higher one).
  const rate = Math.max(rules.floor, Math.min(ceiling * rules.cutFactor, mem?.rate ?? Infinity))
  return { rate, ceiling, cutAt: cut.at, demandMs: 0, at: cut.at }
}

/**
 * The memory after `ms` more of demand at `at`. `changed`: the pace moved (probed up, or unpaced
 * again); a ceiling forgotten on the way counts too, so it is kept.
 */
export function noteDemand(
  mem: PaceMemory | null, d: { at: number; ms: number }, rules: PaceRules = DEFAULT_PACE_RULES,
): { mem: PaceMemory | null; changed: boolean } {
  if (!mem || !(d.ms > 0)) return { mem, changed: false }
  let next: PaceMemory = { ...mem, demandMs: mem.demandMs + d.ms }
  let changed = false
  if (next.ceiling !== null && Math.abs(d.at - next.cutAt) >= rules.ceilingKeepMs) {
    next = { ...next, ceiling: null, at: d.at }
    changed = true
  }
  if (next.demandMs < rules.probeAfterDemandMs) return { mem: next, changed }
  const up = next.ceiling !== null
    ? Math.min(next.rate * rules.probeStep, next.ceiling * rules.probeHeadroom)
    : next.rate * rules.freeStep
  if (next.ceiling === null && up >= rules.unpacedFromBytesPerSec) return { mem: null, changed: true }
  if (up <= next.rate) return { mem: { ...next, demandMs: 0 }, changed }
  return { mem: { ...next, rate: up, demandMs: 0, at: d.at }, changed: true }
}

/** A kept memory read back under today's rules: never under the floor (a floor raised since it was kept). */
export function readBackPace(mem: PaceMemory, rules: PaceRules = DEFAULT_PACE_RULES): PaceMemory {
  return { ...mem, rate: Math.max(rules.floor, mem.rate), demandMs: 0 }
}

/** A kept memory read back: anything else (an old or broken file) reads as none. */
export function validPaceMemory(e: unknown): e is PaceMemory {
  const m = e as PaceMemory
  const pos = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0
  return !!m && typeof m === 'object' && pos(m.rate) && (m.ceiling === null || pos(m.ceiling))
    && Number.isFinite(m.cutAt) && Number.isFinite(m.at) && typeof m.demandMs === 'number' && Number.isFinite(m.demandMs)
}
