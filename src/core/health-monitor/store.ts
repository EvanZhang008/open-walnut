/**
 * The health monitor's files, in WALNUT_HOME/local/health-monitor (never synced:
 * each machine's health is its own).
 *
 *   minutes-<UTC day>.jsonl  one MinuteRow per line, kept 14 days; the last 26 hours
 *                            are read back at boot, so a restart keeps its graphs
 *   log-hours.json           warn/error counts per kind (by its short id) per hour, kept 8 days (the
 *                            spike rule's normal and the chronic rule's days)
 *   state.json               alarm states and history, overrides, boots, fix tasks
 *
 * Every write is async; the two JSON files are written whole through a temp file.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import type { AlarmInstanceState, AlarmOverride, MinuteRow } from './types.js'
import type { HourBuckets } from './log-alarms.js'

export const MINUTE_RETENTION_DAYS = 14
export const MEMORY_MINUTES = 26 * 60
export const LOG_HOUR_RETENTION_DAYS = 8

/** Keyed by the kind's short id (log-alarms.ts signatureId); `sig` is the kind itself. */
export interface SignatureMeta { sig: string; level: 'warn' | 'error'; sample: string; lastAt: number }

export interface LogHoursFile {
  version: 1
  hours: HourBuckets
  meta: Record<string, SignatureMeta>
  /** The last hour's counts per minute by the kind's short id (the spike rule's window), for a restart. */
  recent?: Array<{ t: number; c: Record<string, number> }>
}

export interface ServerEvent {
  kind: 'boot' | 'shutdown-bail'
  at: number
  pid: number
  /** A boot's build (commit and build time); absent on boots an older Walnut recorded. */
  build?: string | null
  /** A boot on the build the boot before it ran: a crash, a respawn or a reboot, never a deploy. */
  sameBuild?: boolean
}

export interface StateFile {
  version: 1
  alarms: Record<string, AlarmInstanceState>
  overrides: Record<string, AlarmOverride>
  events: ServerEvent[]
  /** Fix tasks opened, for the daily cap. */
  fixes: Array<{ at: number; alarmId: string; taskId?: string }>
}

export function emptyState(): StateFile {
  return { version: 1, alarms: {}, overrides: {}, events: [], fixes: [] }
}

function dayName(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${crypto.randomBytes(6).toString('hex')}.tmp`)
  try {
    await fsp.writeFile(tmp, text, 'utf-8')
    await fsp.rename(tmp, file)
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => {})
    throw err
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf-8')) as T
  } catch { return null }
}

/** Let the event loop breathe during a long parse. */
const yieldLoop = (): Promise<void> => new Promise((r) => setImmediate(r))

/** Drop hours and kinds older than the retention, in place. */
export function pruneLogHours(f: LogHoursFile, nowMs: number): void {
  const cutoff = nowMs - LOG_HOUR_RETENTION_DAYS * 86_400_000
  for (const h of Object.keys(f.hours)) if (Number(h) < cutoff) delete f.hours[h]
  for (const [k, m] of Object.entries(f.meta)) if (m.lastAt < cutoff) delete f.meta[k]
}

export class HealthStore {
  constructor(readonly dir: string) {}

  async appendMinute(row: MinuteRow): Promise<void> {
    await fsp.mkdir(this.dir, { recursive: true })
    await fsp.appendFile(path.join(this.dir, `minutes-${dayName(row.t)}.jsonl`), JSON.stringify(row) + '\n', 'utf-8')
  }

  /** The rows of the last `MEMORY_MINUTES` before `nowMs`, oldest first. */
  async loadRecentMinutes(nowMs: number): Promise<MinuteRow[]> {
    const from = nowMs - MEMORY_MINUTES * 60_000
    const rows: MinuteRow[] = []
    // Every UTC day the window touches: 26 hours can span three.
    const days: string[] = []
    for (let d = Math.floor(from / 86_400_000) * 86_400_000; d <= nowMs; d += 86_400_000) days.push(dayName(d))
    for (const day of days) {
      let text: string
      try { text = await fsp.readFile(path.join(this.dir, `minutes-${day}.jsonl`), 'utf-8') } catch { continue }
      const lines = text.split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (i > 0 && i % 300 === 0) await yieldLoop()
        const line = lines[i]
        if (!line) continue
        try {
          const r = JSON.parse(line) as MinuteRow
          if (typeof r?.t === 'number' && r.t >= from && r.v && typeof r.v === 'object') rows.push(r)
        } catch { /* a torn last line */ }
      }
    }
    rows.sort((a, b) => a.t - b.t)
    // One row per minute: a restart inside a minute can write it twice; the later one wins.
    const out: MinuteRow[] = []
    for (const r of rows) {
      if (out.length && out[out.length - 1].t === r.t) out[out.length - 1] = r
      else out.push(r)
    }
    return out
  }

  /** Remove minute files older than the retention. */
  async pruneMinutes(nowMs: number): Promise<void> {
    const keep = dayName(nowMs - MINUTE_RETENTION_DAYS * 86_400_000)
    let names: string[]
    try { names = await fsp.readdir(this.dir) } catch { return }
    for (const n of names) {
      const m = /^minutes-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(n)
      if (m && m[1] < keep) await fsp.rm(path.join(this.dir, n), { force: true }).catch(() => {})
    }
  }

  async loadLogHours(): Promise<LogHoursFile> {
    const f = await readJson<LogHoursFile>(path.join(this.dir, 'log-hours.json'))
    return f && f.version === 1 && f.hours && f.meta ? f : { version: 1, hours: {}, meta: {} }
  }

  async saveLogHours(f: LogHoursFile, nowMs: number): Promise<void> {
    pruneLogHours(f, nowMs)
    await writeAtomic(path.join(this.dir, 'log-hours.json'), JSON.stringify(f))
  }

  async loadState(): Promise<StateFile> {
    const f = await readJson<StateFile>(path.join(this.dir, 'state.json'))
    if (!f || f.version !== 1) return emptyState()
    return { ...emptyState(), ...f }
  }

  async saveState(f: StateFile): Promise<void> {
    await writeAtomic(path.join(this.dir, 'state.json'), JSON.stringify(f))
  }
}
