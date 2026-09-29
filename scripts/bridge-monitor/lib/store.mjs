/**
 * NDJSON store: one file per LOCAL day, `YYYY-MM-DD.ndjson` for the collector
 * and `probe-YYYY-MM-DD.ndjson` for the control probe. Every record carries
 * `t` (ISO UTC) and `kind`. Retention prunes by the date in the file name.
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import readline from 'node:readline'

export const FILE_RE = /^(?:(probe)-)?(\d{4}-\d\d-\d\d)\.ndjson$/

export function localTz() {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

const dayFormatters = new Map()

/** Local calendar day (YYYY-MM-DD) of an instant, in the given IANA zone. */
export function localDay(t, tz = localTz()) {
  let fmt = dayFormatters.get(tz)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' })
    dayFormatters.set(tz, fmt)
  }
  return fmt.format(new Date(t))
}

/** UTC epoch ms of local midnight that starts `day` in `tz`. */
export function dayStartMs(day, tz = localTz()) {
  const [y, m, d] = day.split('-').map(Number)
  // Guess UTC midnight, then correct by the zone offset at that instant (twice
  // covers DST edges).
  let guess = Date.UTC(y, m - 1, d)
  for (let i = 0; i < 2; i++) {
    const shown = localParts(guess, tz)
    const shownMs = Date.UTC(shown.y, shown.m - 1, shown.d, shown.h, shown.min, shown.s)
    guess += Date.UTC(y, m - 1, d) - shownMs
  }
  return guess
}

function localParts(ms, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(ms))
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), min: get('minute'), s: get('second') }
}

/** The next local day after `day`. */
export function nextDay(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10)
}

export function prevDay(day) {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10)
}

export class Store {
  constructor(dir, { prefix = '', tz = localTz() } = {}) {
    this.dir = dir
    this.prefix = prefix
    this.tz = tz
  }

  fileFor(day) {
    return path.join(this.dir, `${this.prefix ? `${this.prefix}-` : ''}${day}.ndjson`)
  }

  /** Append records (grouped by local day). Async, never blocks the loop. */
  async append(records) {
    const list = Array.isArray(records) ? records : [records]
    if (list.length === 0) return
    const byFile = new Map()
    for (const rec of list) {
      if (!rec.t) rec.t = new Date().toISOString()
      const file = this.fileFor(localDay(rec.t, this.tz))
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file).push(JSON.stringify(rec))
    }
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 })
    for (const [file, lines] of byFile) {
      await fsp.appendFile(file, `${lines.join('\n')}\n`, { mode: 0o600 })
    }
  }
}

/** Read every record from the given day files (missing files are skipped). */
export async function readDays(dir, days, { prefix = '' } = {}) {
  const out = []
  for (const day of days) {
    const file = path.join(dir, `${prefix ? `${prefix}-` : ''}${day}.ndjson`)
    if (!fs.existsSync(file)) continue
    const rl = readline.createInterface({ input: fs.createReadStream(file, 'utf-8'), crlfDelay: Infinity })
    for await (const line of rl) {
      if (!line.trim()) continue
      try { out.push(JSON.parse(line)) } catch { /* torn line from a crash: skip */ }
    }
  }
  return out
}

/** List of `n` local days ending at `lastDay` (inclusive), oldest first. */
export function dayRange(lastDay, n) {
  const days = [lastDay]
  while (days.length < n) days.unshift(prevDay(days[0]))
  return days
}

/**
 * Delete store files whose date is older than `retentionDays` before
 * `today`. Only names matching FILE_RE are ever touched.
 */
export async function pruneStore(dir, retentionDays, today) {
  let names = []
  try { names = await fsp.readdir(dir) } catch { return [] }
  const cutoff = dayRange(today, retentionDays)[0]
  const removed = []
  for (const name of names) {
    const m = FILE_RE.exec(name)
    if (!m || m[2] >= cutoff) continue
    await fsp.rm(path.join(dir, name), { force: true })
    removed.push(name)
  }
  return removed
}
