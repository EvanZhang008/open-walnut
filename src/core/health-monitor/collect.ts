/**
 * What goes into each minute's row.
 *
 *  - Taps on the metrics registry (observability/metrics.ts): a counter sums its
 *    minute, a latency keeps its minute's max. Only the names below are kept, so
 *    a busy registry costs one Map lookup per observation.
 *  - A tap on warn/error log lines: one count per kind (signature.ts), kept
 *    apart from the row (log-store in engine.ts), plus the row's totals.
 *  - Gauges read at the minute's end: disk, open files, memory pressure, RSS,
 *    the SSH certificate, and gauges other modules set (the status check).
 *
 * Every read is async or a cheap in-memory getter: this runs on the server's
 * one event loop.
 */

import fsp from 'node:fs/promises'
import { addObserveTap } from '../observability/metrics.js'
import { setLogLevelTap } from '../../logging/subsystem.js'
import { seriesKeyOf } from './evaluate.js'
import { signatureKey } from './signature.js'
import type { MinuteRow } from './types.js'

const GiB = 1024 ** 3

/** Registry counters kept as `<name>{labels}` sums. */
const COUNTERS = new Set(['host.link.lost'])

/** Registry latencies kept as a minute max, under the health key their labels map to. */
function maxKeyOf(name: string, labels: Record<string, string> | undefined): string | null {
  if (name === 'eventloop.delay.max') return 'eventloop.delay.max'
  if (name === 'session.delivery') {
    const p = labels?.path
    if (p === 'stdin' || p === 'mid-turn') return 'send.delivery.live'
    if (p === 'resume') return 'send.delivery.resume'
  }
  return null
}

/** The most kinds of log line one minute keeps; the rest count under `log.other`. */
const MAX_SIGNATURES_PER_MINUTE = 200

export interface SignatureCount { level: 'warn' | 'error'; n: number; sample: string }

export interface GaugeReaders {
  dataDir: string
  statfs?: (p: string) => Promise<{ bavail: number; bsize: number; blocks: number; bfree: number }>
  fdCount?: () => Promise<number | null>
  memoryPressure?: () => 'normal' | 'warn' | 'critical' | null
  sshCertExpiring?: () => Promise<boolean | null>
  rssBytes?: () => number
}

async function defaultFdCount(): Promise<number | null> {
  try {
    return (await fsp.readdir(process.platform === 'linux' ? '/proc/self/fd' : '/dev/fd')).length
  } catch { return null }
}

export class MinuteCollector {
  private sums = new Map<string, number>()
  private maxes = new Map<string, number>()
  private sticky = new Map<string, number>()
  private sigs = new Map<string, SignatureCount>()
  private warns = 0
  private errors = 0
  private untap: Array<() => void> = []

  constructor(private readonly readers: GaugeReaders) {}

  /** Attach the taps. */
  start(): void {
    this.untap.push(addObserveTap((name, value, labels) => this.observe(name, value, labels)))
    setLogLevelTap((level, subsystem, message) => this.logLine(level, subsystem, message))
    this.untap.push(() => setLogLevelTap(null))
  }

  stop(): void {
    for (const u of this.untap.splice(0)) u()
  }

  observe(name: string, value: number, labels: Record<string, string> | undefined): void {
    if (COUNTERS.has(name)) {
      const k = seriesKeyOf(name, labels)
      this.sums.set(k, (this.sums.get(k) ?? 0) + value)
      return
    }
    const mk = maxKeyOf(name, labels)
    if (mk) {
      const prev = this.maxes.get(mk)
      if (prev === undefined || value > prev) this.maxes.set(mk, value)
    }
  }

  logLine(level: 'warn' | 'error' | 'fatal', subsystem: string, message: string): void {
    const lvl = level === 'warn' ? 'warn' : 'error'
    if (lvl === 'warn') this.warns++
    else this.errors++
    let key = signatureKey(subsystem, message)
    if (!this.sigs.has(key) && this.sigs.size >= MAX_SIGNATURES_PER_MINUTE) key = 'log.other'
    const s = this.sigs.get(key)
    if (s) {
      s.n++
      if (lvl === 'error') s.level = 'error'
    } else {
      this.sigs.set(key, { level: lvl, n: 1, sample: `${subsystem}: ${String(message).slice(0, 300)}` })
    }
  }

  /** A gauge another module sets; it rides every row until set again. */
  setGauge(key: string, value: number | null): void {
    if (value === null || !Number.isFinite(value)) this.sticky.delete(key)
    else this.sticky.set(key, value)
  }

  /**
   * Close the minute starting at `t`: the row, and the log kinds counted in it.
   * `extra` adds gauges the engine owns (restarts, shutdown cut-offs).
   */
  async closeMinute(t: number, extra: Record<string, number> = {}): Promise<{ row: MinuteRow; sigs: Map<string, SignatureCount> }> {
    const v: Record<string, number> = {}
    for (const [k, n] of this.sums) v[k] = n
    for (const [k, n] of this.maxes) v[k] = round(n)
    for (const [k, n] of this.sticky) v[k] = n
    v['log.warn'] = this.warns
    v['log.error'] = this.errors
    const sigs = this.sigs
    this.sums = new Map()
    this.maxes = new Map()
    this.sigs = new Map()
    this.warns = 0
    this.errors = 0
    Object.assign(v, extra, await this.readGauges())
    return { row: { t, v }, sigs }
  }

  private async readGauges(): Promise<Record<string, number>> {
    const r = this.readers
    const out: Record<string, number> = {}
    try {
      const st = await (r.statfs ?? ((p: string) => fsp.statfs(p)))(r.dataDir)
      const total = st.blocks * st.bsize
      if (total > 0) {
        out['disk.free_gb'] = round((st.bavail * st.bsize) / GiB)
        // df's used %: used / (used + available to a user)
        const used = (st.blocks - st.bfree) * st.bsize
        out['disk.used_pct'] = round((used / (used + st.bavail * st.bsize)) * 100)
      }
    } catch { /* no disk reading this minute */ }
    try {
      const fd = await (r.fdCount ?? defaultFdCount)()
      if (fd !== null) out['process.fd'] = fd
    } catch { /* none */ }
    try {
      const lvl = r.memoryPressure?.() ?? null
      if (lvl) out['memory.pressure'] = lvl === 'critical' ? 2 : lvl === 'warn' ? 1 : 0
    } catch { /* none */ }
    try {
      const exp = await r.sshCertExpiring?.()
      if (exp !== null && exp !== undefined) out['ssh.cert.expiring'] = exp ? 1 : 0
    } catch { /* none */ }
    try {
      out['process.rss_mb'] = Math.round((r.rssBytes ?? (() => process.memoryUsage.rss()))() / (1024 * 1024))
    } catch { /* none */ }
    return out
  }
}

function round(n: number): number {
  return Math.round(n * 10) / 10
}
