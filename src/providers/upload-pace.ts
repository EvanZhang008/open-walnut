/**
 * The upload pace each host's own connections learned (lib/adaptive-pace.ts holds the rules):
 * one memory per host and channel ('bulk': the bulk channel's forward, paced-forward.ts;
 * 'lane': the stream lane's background streams, stream-lane.ts).
 *
 * A connection's pacer comes from here at the pace learned so far and follows a probe while it
 * runs. When the connection ends, its owner says so (ended) before it drops the pacer: a cut
 * while it carried an upload paces lower at once (the redial goes at the new pace) and is judged
 * CUT_JUDGE_MS later: when the session link to the same host went down too (Mac sleep, network
 * loss, a wake), the pace before it comes back and nothing is kept.
 *
 * Kept machine-local (WALNUT_HOME/local/upload-pace.json, keyed by this machine's id, through
 * KeyedUpdateStore): the pace belongs to this machine's path to the host, so git-sync never
 * carries it to another machine. Entries unchanged for PACE_MEMORY_MAX_MS go.
 */

import { createUploadPacer, type UploadPacer } from '../lib/upload-pacer.js'
import {
  DEFAULT_PACE_RULES, cutTeaches, learnFromCut, noteDemand, paceLimits, readBackPace, validPaceMemory,
  type PaceLimits, type PaceMemory, type PaceRules,
} from '../lib/adaptive-pace.js'
import { log } from '../logging/index.js'
import { KeyedUpdateStore } from './daemon-update-store.js'
import { linkDownIntervals } from './host-link-ledger.js'
import { lastHostSignalAt, WAKE_GRACE_MS } from './daemon-reconnect-cause.js'
import { BULK_PACE_FLOOR_BYTES_PER_SEC, LANE_PACE_FLOOR_BYTES_PER_SEC } from './ssh-upload-budget.js'

export type UploadChannel = 'bulk' | 'lane'

export const CHANNEL_RULES: Record<UploadChannel, PaceRules> = {
  bulk: { ...DEFAULT_PACE_RULES, floor: BULK_PACE_FLOOR_BYTES_PER_SEC },
  lane: { ...DEFAULT_PACE_RULES, floor: LANE_PACE_FLOOR_BYTES_PER_SEC },
}

/** A memory unchanged this long is dropped: the next upload starts unpaced and learns again. */
export const PACE_MEMORY_MAX_MS = 30 * 24 * 3600_000
/** How long after a cut it is judged, and how near a drop of the host's whole link must be to excuse it. */
export const CUT_JUDGE_MS = 15_000

export const uploadPaceStore = new KeyedUpdateStore<PaceMemory>(
  'upload-pace.json', 'WALNUT_UPLOAD_PACE_FILE', PACE_MEMORY_MAX_MS, validPaceMemory)

/** Where a connection's pacer comes from; a fixed pace (tests, a caller that names one) never learns. */
export interface PaceSource {
  /** Resolves once the pace learned earlier is read (before the first pacer()). */
  ready?(): Promise<void>
  pacer(): UploadPacer
  /**
   * The connection `pacer` served ended; `byWalnut`: Walnut stopped it, or it did not end by
   * itself (a promise when its owner learns that a moment later). Call before pacer.drop(): what
   * the pacer held is read at once.
   */
  ended(pacer: UploadPacer, how: { byWalnut: boolean | Promise<boolean> }): void
}

export function fixedPace(limits: PaceLimits | null): PaceSource {
  return {
    pacer: () => createUploadPacer(limits ? { ...limits } : { bytesPerSec: null }),
    ended: () => {},
  }
}

export interface UploadPaceDeps {
  now?: () => number
  /** Whether the host's whole link went down within [from, to] (wall clock), or this Mac woke or changed network. */
  hostLinkDroppedNear?: (host: string, from: number, to: number) => boolean
  judgeMs?: number
  store?: Pick<KeyedUpdateStore<PaceMemory>, 'read' | 'write'>
}

function defaultHostLinkDroppedNear(host: string, from: number, to: number): boolean {
  if (linkDownIntervals(host, from, to).length > 0) return true
  const signal = lastHostSignalAt()
  return signal > 0 && signal >= from - WAKE_GRACE_MS && signal <= to
}

const kb = (n: number | null | undefined) => (n == null ? null : Math.round(n / 102.4) / 10)

export class HostUploadPace implements PaceSource {
  private mem: PaceMemory | null = null
  private loading: Promise<void> | null = null
  /** Bumped by every cut learned: a judgement later is about the cut it was made for only. */
  private cutSeq = 0
  /**
   * The memory before the earliest cut not judged yet: cuts close together (a lane that redials
   * within a second and is cut again in the same outage) are rolled back as one, to it.
   */
  private pending: { before: PaceMemory | null } | null = null
  private readonly live = new Set<UploadPacer>()
  private readonly rules: PaceRules
  private readonly now: () => number

  constructor(readonly host: string, readonly channel: UploadChannel, private readonly deps: UploadPaceDeps = {}) {
    this.rules = CHANNEL_RULES[channel]
    this.now = deps.now ?? Date.now
  }

  private get key(): string { return `ssh:${this.host}#${this.channel}` }
  private get store() { return this.deps.store ?? uploadPaceStore }

  /** Read what an earlier server learned (once); a cut or probe seen meanwhile wins. */
  load(): Promise<void> {
    this.loading ??= this.store.read(this.key).then((kept) => {
      if (kept && !this.mem && this.cutSeq === 0 && this.now() - kept.at < PACE_MEMORY_MAX_MS) this.mem = readBackPace(kept, this.rules)
    }, () => {})
    return this.loading
  }

  ready(): Promise<void> { return this.load() }

  get limits(): PaceLimits | null { return paceLimits(this.mem, this.rules) }

  /** For log lines: the pace now (KB/s, null: unpaced) and the ceiling it stays under. */
  describe(): { paceKBps: number | null; ceilingKBps: number | null } {
    return { paceKBps: kb(this.mem?.rate), ceilingKBps: kb(this.mem?.ceiling) }
  }

  pacer(): UploadPacer {
    const limits = this.limits
    const p: UploadPacer = createUploadPacer({
      ...(limits ?? { bytesPerSec: null }),
      now: this.deps.now,
      onDemand: (ms) => this.demand(ms),
    })
    this.live.add(p)
    return p
  }

  ended(pacer: UploadPacer, how: { byWalnut: boolean | Promise<boolean> }): void {
    if (!this.live.delete(pacer)) return
    const at = this.now()
    const seen = {
      sinceSentMs: pacer.lastSentAt === null ? null : at - pacer.lastSentAt,
      queuedBytes: pacer.queuedBytes,
      hostLinkDropped: false,
    }
    // Carried no upload: nothing to learn, whoever ended it.
    if (!cutTeaches({ ...seen, byWalnut: false }, this.rules)) return
    const cut = { at, measured: pacer.recentBytesPerSec(), cap: pacer.limits?.bytesPerSec ?? null }
    void Promise.resolve(how.byWalnut).then(async (byWalnut) => {
      if (!cutTeaches({ ...seen, byWalnut }, this.rules)) return
      await this.load()
      this.learnCut(cut)
    }, () => {})
  }

  /**
   * Paced lower at once, so the redial that follows (the lane's within a second) goes at the new
   * pace; judged CUT_JUDGE_MS later: undone if the host's whole link went down with it, else kept.
   */
  private learnCut(cut: { at: number; measured: number; cap: number | null }): void {
    const before = this.mem
    const learned = learnFromCut(before, cut, this.rules)
    if (learned === before) return
    const seq = ++this.cutSeq
    this.pending ??= { before }
    this.set(learned, false)
    log.session.info('upload pace: a connection was cut while uploading; paced lower', {
      host: this.host, channel: this.channel, fromKBps: kb(before?.rate), toKBps: kb(learned?.rate),
      ceilingKBps: kb(learned?.ceiling), measuredKBps: kb(cut.measured), capKBps: kb(cut.cap),
    })
    const judge = () => {
      // The latest cut judges every cut not judged yet (demand and probes since do not count).
      if (seq !== this.cutSeq) return
      const near = this.deps.hostLinkDroppedNear ?? defaultHostLinkDroppedNear
      const restore = this.pending?.before ?? null
      this.pending = null
      if (!near(this.host, cut.at - CUT_JUDGE_MS, cut.at + CUT_JUDGE_MS)) { this.set(this.mem); return }
      // Every cut since the last judged one goes with it: they came in the same outage.
      this.set(restore, false)
      log.session.info('upload pace: the cut came with its host link going down; pace restored', {
        host: this.host, channel: this.channel, toKBps: kb(restore?.rate),
      })
    }
    const ms = this.deps.judgeMs ?? CUT_JUDGE_MS
    if (ms <= 0) { judge(); return }
    const t = setTimeout(judge, ms)
    t.unref?.()
  }

  private demand(ms: number): void {
    const before = this.mem
    const { mem, changed } = noteDemand(before, { at: this.now(), ms }, this.rules)
    // Only the count moves: the memory stays the same one until the pace changes.
    if (!changed) { if (before && mem) before.demandMs = mem.demandMs; return }
    this.set(mem)
    if (mem?.rate === before?.rate) return
    log.session.info('upload pace: no cut through its demand; probing up', {
      host: this.host, channel: this.channel, fromKBps: kb(before?.rate), toKBps: kb(mem?.rate), ceilingKBps: kb(mem?.ceiling),
    })
  }

  /** A new pace: every running pacer follows it, and (`keep`) it is kept for the next server. */
  private set(mem: PaceMemory | null, keep = true): void {
    this.mem = mem
    const limits = this.limits
    for (const p of this.live) p.setLimits(limits)
    if (keep) void this.store.write(this.key, mem ? { ...mem, demandMs: 0 } : null)
  }
}

const paces = new Map<string, HostUploadPace>()

/** The one memory of this process for a host's channel. */
export function uploadPaceFor(host: string, channel: UploadChannel): HostUploadPace {
  const key = `${channel}|${host}`
  let pace = paces.get(key)
  if (!pace) { pace = new HostUploadPace(host, channel); paces.set(key, pace) }
  return pace
}

/** Tests: forget every memory of this process (a file a test named stays). */
export function resetUploadPacesForTest(): void {
  paces.clear()
}
