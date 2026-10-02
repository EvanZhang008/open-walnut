/**
 * What each session costs its machine: the server side of the daemon's
 * `proc.sample` (proc-sample-core.ts).
 *
 * The daemon on every connected host runs ONE `ps` per sample and attributes
 * CPU and RSS to the sessions it runs; this module asks each host, names the
 * sessions (task, title) from the store, keeps a short history per session, and
 * pushes one `session:resources` frame per host to the web clients. Nothing
 * here spawns a process or reads a transcript: the frame that crosses the
 * tunnel is a few hundred bytes per host.
 *
 * Cadence: a slow tick on its own (SLOW_MS, so the badges and the kebab rows
 * are never older than that), and a fast tick (FAST_MS) while a client is
 * watching the Machine readout (`markWatched`, renewed by every fresh read and
 * expiring WATCH_MS after the last one). A fresh read that lands inside
 * MIN_GAP_MS of the previous sample gets that sample: two panes opening at once
 * cost one ps. Sampling is skipped on a cloud replica and under vitest.
 *
 * Degrading, never hanging: a route read waits at most READ_DEADLINE_MS per host
 * and otherwise answers the last frame marked `stale` (the sample still lands as
 * a WS frame). A failed sample keeps the last good rows for KEEP_GOOD_MS, marked
 * `stale` with the error, so a heavy session does not lose its pill exactly when
 * its host is overloaded. A host that leaves the pool gets one last
 * `not_connected` frame, so no client keeps showing its old numbers.
 */

import { bus, EventNames } from '../event-bus.js'
import { getSessionByClaudeIdSync, getSessionByAcpRuntimeIdSync } from '../session-tracker.js'
import type { SessionRecord } from '../types.js'
import type { ProcSample, SessionProcUsage } from '../../providers/proc-sample-core.js'

export const SESSION_RESOURCES_EVENT = 'session:resources'

/** Slow cadence: the badge and the kebab rows ride this. */
export const SLOW_MS = 30_000
/** Fast cadence while someone watches the Machine readout. */
export const FAST_MS = 5_000
/** How long a fresh read keeps the fast cadence. */
export const WATCH_MS = 60_000
/** A fresh read closer than this to the last sample reuses it. */
export const MIN_GAP_MS = 1_500
/** Points kept per session (30 min at the slow cadence, 5 min at the fast one). */
export const HISTORY_POINTS = 60
/** A session absent from this many consecutive samples loses its history. */
const HISTORY_GRACE_SAMPLES = 3
/** The daemon's ps budget is 5s; this is the round trip's ceiling. */
const COMMAND_TIMEOUT_MS = 10_000
/** The longest a route read waits for one host before answering what it has. */
export const READ_DEADLINE_MS = 2_500
/** How long a failed sample may stand on the last good rows. */
export const KEEP_GOOD_MS = 3 * SLOW_MS
/** An ACP runtime id with no session record is asked about again after this. */
const ACP_MISS_TTL_MS = 30_000
/** A cached ACP runtime id not reported for this long is forgotten. */
const ACP_FORGET_MS = 10 * 60_000

/** Above either, a session wears the heavy pill on its column. */
export const HEAVY_RSS_BYTES = 1.5 * 1024 ** 3
export const HEAVY_CPU_PCT = 100

export interface ResourcePoint { at: number; rssBytes: number; cpuPct: number | null }

export interface SessionResourceRow extends SessionProcUsage {
  /**
   * The Walnut session id this row belongs to, when the store knows it. Same as
   * `sid` for a CLI; an ACP worker's `sid` is its runtime id, which no column,
   * route or menu knows, so the UI keys on this.
   */
  sessionId?: string
  /** The Walnut session this is, when the store knows it. */
  taskId?: string
  title?: string
  /** False for a session the daemon runs for another Walnut (an ephemeral server's). */
  known: boolean
  heavy: boolean
  /** Only on a read that asked for it. */
  history?: ResourcePoint[]
}

export interface HostResourceFrame {
  /** Pool key: '__local__' or the host alias. */
  host: string
  at: number
  ok: boolean
  /**
   * When !ok: why there is no reading for this host. With ok, `error`: the last
   * sample failed (or one daemon's ps did) and the rows are what was read before.
   * `sampling`: the first sample has not answered yet.
   */
  reason?: 'not_connected' | 'daemon_needs_upgrade' | 'error' | 'sampling'
  error?: string
  /** These rows are from an earlier sample (see `reason`/`error` for why). */
  stale?: boolean
  /** With `stale` after a failure: when the rows were read. */
  goodAt?: number
  machine?: ProcSample['host']
  processCount: number
  /** How long the daemon's ps plus attribution took. */
  sampleMs?: number
  sessions: SessionResourceRow[]
  totals: { sessions: number; rssBytes: number; cpuPct: number | null }
}

export interface DaemonLink {
  hasCapability: (c: string) => boolean
  send: (cmd: string, params: Record<string, unknown>, timeoutMs?: number) => Promise<Record<string, unknown>>
}

export interface SessionResourcesDeps {
  listHosts: () => string[]
  /** Every connected daemon of a host (a handover, or a local daemon on two sockets, gives more than one). */
  connectionsFor: (host: string) => DaemonLink[]
  sessionBySid: (sid: string) => Pick<SessionRecord, 'claudeSessionId' | 'taskId' | 'title'> | null
  sessionByAcpRuntimeId: (rid: string) => Pick<SessionRecord, 'claudeSessionId' | 'taskId' | 'title'> | null
  publish: (frame: HostResourceFrame) => void
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (t: unknown) => void
  /** Thresholds, overridable for tests and by env. */
  heavyRssBytes?: number
  heavyCpuPct?: number
}

export function isHeavy(u: Pick<SessionProcUsage, 'rssBytes' | 'cpuPct'>, rss = HEAVY_RSS_BYTES, cpu = HEAVY_CPU_PCT): boolean {
  return u.rssBytes >= rss || (u.cpuPct != null && u.cpuPct >= cpu)
}

/** The sampler: one per server. */
export class SessionResourceSampler {
  private frames = new Map<string, HostResourceFrame>()
  private history = new Map<string, { points: ResourcePoint[]; missed: number }>()
  private inFlight = new Map<string, Promise<HostResourceFrame>>()
  /** ACP runtime id -> Walnut session id (immutable, so a hit never re-scans the store). */
  private acpSessionIds = new Map<string, { sessionId: string; seenAt: number }>()
  private acpMisses = new Map<string, number>()
  private watchedUntil = 0
  private timer: unknown = null
  private stopped = false
  private readonly heavyRss: number
  private readonly heavyCpu: number

  constructor(private readonly deps: SessionResourcesDeps) {
    this.heavyRss = deps.heavyRssBytes ?? HEAVY_RSS_BYTES
    this.heavyCpu = deps.heavyCpuPct ?? HEAVY_CPU_PCT
  }

  /** Begin the self-scheduling tick. */
  start(): void {
    this.stopped = false
    this.schedule(0)
  }

  stop(): void {
    this.stopped = true
    if (this.timer != null) this.deps.clearTimer(this.timer)
    this.timer = null
  }

  /** A client is looking at the Machine readout: sample fast for a while. */
  markWatched(): void {
    const was = this.watching()
    this.watchedUntil = this.deps.now() + WATCH_MS
    if (!was && !this.stopped) this.schedule(0)
  }

  watching(): boolean {
    return this.deps.now() < this.watchedUntil
  }

  /** The last frame per host (no history). */
  latest(host?: string): HostResourceFrame[] {
    if (host) {
      const f = this.frames.get(host)
      return f ? [f] : []
    }
    return Array.from(this.frames.values())
  }

  /**
   * One host now (or the sample in flight / the one younger than MIN_GAP_MS),
   * with history attached when asked. A host with no connected daemon answers a
   * not_connected frame without touching the network.
   */
  async read(host: string, opts: { fresh?: boolean; history?: boolean; deadlineMs?: number } = {}): Promise<HostResourceFrame> {
    let frame: HostResourceFrame
    const last = this.frames.get(host)
    if (!opts.fresh && last) frame = last
    else if (last && this.deps.now() - last.at < MIN_GAP_MS) frame = last
    else frame = await this.withDeadline(host, this.sampleHost(host), opts.deadlineMs)
    if (!opts.history) return frame
    return {
      ...frame,
      sessions: frame.sessions.map((s) => ({ ...s, history: this.history.get(this.historyKey(host, s.sid))?.points ?? [] })),
    }
  }

  /** Every connected host now (fresh) or as last seen. */
  async readAll(opts: { fresh?: boolean; history?: boolean; deadlineMs?: number } = {}): Promise<HostResourceFrame[]> {
    const hosts = this.deps.listHosts()
    this.forgetHostsNotIn(hosts)
    return Promise.all(hosts.map((h) => this.read(h, opts)))
  }

  /**
   * A host that left the pool: one last not_connected frame (so every client
   * drops its rows and pills), then its frame and history go.
   */
  private forgetHostsNotIn(hosts: string[]): void {
    for (const key of Array.from(this.frames.keys())) {
      if (hosts.includes(key)) continue
      this.frames.delete(key)
      const prefix = key + '\u0000'
      for (const hk of Array.from(this.history.keys())) if (hk.startsWith(prefix)) this.history.delete(hk)
      this.deps.publish(this.errorFrame(key, 'not_connected'))
    }
  }

  /**
   * Wait for a sample at most `ms`: past it, answer the last frame marked stale
   * (or a `sampling` placeholder); the sample still lands and is published.
   */
  private withDeadline(host: string, sample: Promise<HostResourceFrame>, ms?: number): Promise<HostResourceFrame> {
    if (ms == null) return sample
    return new Promise((resolve) => {
      let done = false
      const timer = this.deps.setTimer(() => {
        if (done) return
        done = true
        const last = this.frames.get(host)
        resolve(last ? { ...last, stale: true } : this.errorFrame(host, 'sampling'))
      }, ms)
      void sample.then((frame) => {
        if (done) return
        done = true
        this.deps.clearTimer(timer)
        resolve(frame)
      })
    })
  }

  private historyKey(host: string, sid: string): string {
    return host + '\u0000' + sid
  }

  private schedule(ms: number): void {
    if (this.stopped) return
    if (this.timer != null) this.deps.clearTimer(this.timer)
    this.timer = this.deps.setTimer(() => {
      this.timer = null
      void this.tick()
    }, ms)
  }

  private async tick(): Promise<void> {
    try {
      await this.readAll({ fresh: true })
    } catch { /* a host that failed answered its own error frame; nothing else can throw */ }
    const now = this.deps.now()
    for (const [rid, v] of this.acpSessionIds) if (now - v.seenAt > ACP_FORGET_MS) this.acpSessionIds.delete(rid)
    for (const [rid, until] of this.acpMisses) if (now >= until) this.acpMisses.delete(rid)
    this.schedule(this.watching() ? FAST_MS : SLOW_MS)
  }

  private async sampleHost(host: string): Promise<HostResourceFrame> {
    const running = this.inFlight.get(host)
    if (running) return running
    const settle = (got: HostResourceFrame): HostResourceFrame => {
      this.inFlight.delete(host)
      const frame = this.keepLastGood(host, got)
      this.frames.set(host, frame)
      this.deps.publish(frame)
      return frame
    }
    const p = this.sampleHostNow(host).then(settle, (err) => settle(this.errorFrame(host, 'error', err instanceof Error ? err.message : String(err))))
    this.inFlight.set(host, p)
    return p
  }

  /** A failed sample over a recent good one keeps the good rows, marked stale with the error. */
  private keepLastGood(host: string, got: HostResourceFrame): HostResourceFrame {
    if (got.ok || got.reason !== 'error') return got
    const last = this.frames.get(host)
    if (!last || !last.ok || last.reason === 'sampling') return got
    // The rows' age is the last good sample's, not the last stale frame's.
    const goodAt = last.stale ? (last.goodAt ?? last.at) : last.at
    if (got.at - goodAt > KEEP_GOOD_MS) return got
    return { ...last, at: got.at, stale: true, goodAt, reason: 'error', ...(got.error ? { error: got.error } : {}) }
  }

  private errorFrame(host: string, reason: NonNullable<HostResourceFrame['reason']>, error?: string): HostResourceFrame {
    return {
      host, at: this.deps.now(), ok: false, reason, ...(error ? { error } : {}),
      processCount: 0, sessions: [], totals: { sessions: 0, rssBytes: 0, cpuPct: null },
    }
  }

  private async sampleHostNow(host: string): Promise<HostResourceFrame> {
    const conns = this.deps.connectionsFor(host)
    if (conns.length === 0) return this.errorFrame(host, 'not_connected')
    const able = conns.filter((c) => c.hasCapability('proc-sample-v1'))
    if (able.length === 0) return this.errorFrame(host, 'daemon_needs_upgrade')
    const reply = await this.askAll(able)
    if (reply.ok === false) return this.errorFrame(host, 'error', reply.error ?? 'proc.sample failed')
    // The server's clock, not the daemon's: a remote host's clock can be off,
    // and the gap check and the history both compare against this clock.
    const at = this.deps.now()
    // A root that is gone and left nothing behind costs nothing: no row (its
    // history ages out). A gone root with leaked children stays, that is the point.
    const usages = (Array.isArray(reply.sessions) ? reply.sessions : []).filter((u) => u.alive || u.procCount > 0)
    const sessions = usages.map((u) => this.enrich(host, u, at))
    this.ageHistory(host, new Set(usages.map((u) => u.sid)))
    let rss = 0
    let cpu: number | null = null
    for (const s of sessions) {
      rss += s.rssBytes
      if (s.cpuPct != null) cpu = (cpu ?? 0) + s.cpuPct
    }
    sessions.sort((a, b) => b.rssBytes - a.rssBytes)
    return {
      host, at, ok: true,
      ...(reply.error ? { reason: 'error' as const, error: reply.error } : {}),
      machine: reply.host, processCount: reply.processCount ?? 0, sampleMs: reply.sampleMs,
      sessions,
      totals: { sessions: sessions.length, rssBytes: rss, cpuPct: cpu == null ? null : Math.round(cpu * 10) / 10 },
    }
  }

  /**
   * One proc.sample per daemon, merged: the sessions of all of them (a sid two
   * daemons report keeps the reading with the live root, then the bigger tree),
   * the largest process table. It fails only when every daemon failed.
   */
  private async askAll(conns: DaemonLink[]): Promise<Partial<ProcSample> & { ok?: boolean; error?: string }> {
    type Reply = Partial<ProcSample> & { ok?: boolean; error?: string }
    const settled = await Promise.allSettled(conns.map((c) => c.send('proc.sample', {}, COMMAND_TIMEOUT_MS) as Promise<Reply>))
    const good: Reply[] = []
    const errors: string[] = []
    for (const s of settled) {
      if (s.status === 'rejected') errors.push(s.reason instanceof Error ? s.reason.message : String(s.reason))
      else if (s.value.ok === false) errors.push(s.value.error ?? 'proc.sample failed')
      else good.push(s.value)
    }
    if (good.length === 0) return { ok: false, error: errors[0] ?? 'proc.sample failed' }
    if (good.length === 1) return good[0]
    const bySid = new Map<string, SessionProcUsage>()
    for (const r of good) {
      for (const u of Array.isArray(r.sessions) ? r.sessions : []) {
        const prev = bySid.get(u.sid)
        if (!prev || (u.alive && !prev.alive) || (u.alive === prev.alive && u.procCount > prev.procCount)) bySid.set(u.sid, u)
      }
    }
    const widest = good.reduce((a, b) => ((b.processCount ?? 0) > (a.processCount ?? 0) ? b : a))
    // One daemon whose ps failed does not make the host's reading partial when another answered.
    const failed = good.every((r) => r.error) ? good[0] : undefined
    return {
      ok: true, host: widest.host, processCount: widest.processCount,
      sampleMs: Math.max(...good.map((r) => r.sampleMs ?? 0)),
      sessions: Array.from(bySid.values()),
      ...(failed?.error ? { error: failed.error } : {}),
    }
  }

  /** The session record behind a row: by id for a CLI, by runtime id (cached) for an ACP worker. */
  private recordFor(u: SessionProcUsage): ReturnType<SessionResourcesDeps['sessionBySid']> {
    if (u.kind !== 'acp') return this.deps.sessionBySid(u.sid)
    const now = this.deps.now()
    const known = this.acpSessionIds.get(u.sid)
    if (known) {
      known.seenAt = now
      return this.deps.sessionBySid(known.sessionId)
    }
    const miss = this.acpMisses.get(u.sid)
    if (miss != null && now < miss) return null
    // The store scans payloads for a runtime id: once per worker, not once per tick.
    const rec = this.deps.sessionByAcpRuntimeId(u.sid)
    if (rec?.claudeSessionId) {
      this.acpSessionIds.set(u.sid, { sessionId: rec.claudeSessionId, seenAt: now })
      this.acpMisses.delete(u.sid)
    } else {
      this.acpMisses.set(u.sid, now + ACP_MISS_TTL_MS)
    }
    return rec
  }

  private enrich(host: string, u: SessionProcUsage, at: number): SessionResourceRow {
    const rec = this.recordFor(u)
    const key = this.historyKey(host, u.sid)
    const h = this.history.get(key) ?? { points: [], missed: 0 }
    h.missed = 0
    h.points.push({ at, rssBytes: u.rssBytes, cpuPct: u.cpuPct })
    if (h.points.length > HISTORY_POINTS) h.points.splice(0, h.points.length - HISTORY_POINTS)
    this.history.set(key, h)
    return {
      ...u,
      ...(rec?.claudeSessionId ? { sessionId: rec.claudeSessionId } : {}),
      ...(rec?.taskId ? { taskId: rec.taskId } : {}),
      ...(rec?.title ? { title: rec.title } : {}),
      known: rec != null,
      heavy: isHeavy(u, this.heavyRss, this.heavyCpu),
    }
  }

  /** Forget sessions this host no longer reports, after a short grace. */
  private ageHistory(host: string, seen: Set<string>): void {
    const prefix = host + '\u0000'
    for (const [key, h] of this.history) {
      if (!key.startsWith(prefix)) continue
      if (seen.has(key.slice(prefix.length))) continue
      h.missed += 1
      if (h.missed >= HISTORY_GRACE_SAMPLES) this.history.delete(key)
    }
  }
}

// ── The server's instance ──

let instance: SessionResourceSampler | null = null
let starting: Promise<SessionResourceSampler | null> | null = null
/** Bumped by every stop, so a start still awaiting its import never arms a sampler nobody can stop. */
let generation = 0

function envNumber(name: string, fallback: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n > 0 ? n : fallback
}

/** Build the production sampler over the daemon pool and the session store. */
export async function createSessionResourceSampler(): Promise<SessionResourceSampler> {
  const dc = await import('../../providers/daemon-connection.js')
  return new SessionResourceSampler({
    listHosts: () => Array.from(dc.listConnectedDaemonsByHost().keys()),
    connectionsFor: (host) => (dc.listConnectedDaemonsByHost().get(host) ?? []).map((c) => ({
      hasCapability: (cap: string) => c.hasCapability(cap),
      send: (cmd: string, params: Record<string, unknown>, t?: number) => c.send(cmd, params, t),
    })),
    sessionBySid: (sid) => getSessionByClaudeIdSync(sid),
    sessionByAcpRuntimeId: (rid) => getSessionByAcpRuntimeIdSync(rid),
    publish: (frame) => { bus.emit(EventNames.SESSION_RESOURCES, frame, ['web-ui']) },
    now: () => Date.now(),
    setTimer: (fn, ms) => setTimeout(fn, ms),
    clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>),
    heavyRssBytes: envNumber('WALNUT_HEAVY_SESSION_MB', HEAVY_RSS_BYTES / 1024 ** 2) * 1024 ** 2,
    heavyCpuPct: envNumber('WALNUT_HEAVY_SESSION_CPU', HEAVY_CPU_PCT),
  })
}

/** Start the server's sampler (idempotent). Returns null where sampling is off. */
export async function startSessionResourceSampler(opts: { cloudMode: boolean; vitest?: boolean }): Promise<SessionResourceSampler | null> {
  if (instance) return instance
  if (starting) return starting
  if (opts.cloudMode || opts.vitest || process.env.WALNUT_SESSION_RESOURCES === '0') return null
  const gen = generation
  starting = createSessionResourceSampler().then((s) => {
    if (gen !== generation) return null
    instance = s
    s.start()
    return s
  }).finally(() => { starting = null })
  return starting
}

export function getSessionResourceSampler(): SessionResourceSampler | null {
  return instance
}

export function stopSessionResourceSampler(): void {
  generation += 1
  instance?.stop()
  instance = null
}
