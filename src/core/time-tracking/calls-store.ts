/**
 * Call intervals on disk, Mac-local: WALNUT_HOME/time-tracking/outside/calls/<date>.jsonl.
 * Under outside/ on purpose: that directory is git-ignored by the data sync, so
 * when the user was on a call never leaves this Mac.
 *
 * Two line shapes, both append-only and safe to repeat (reads take the union):
 *   {"t":"call","app":"zoom.us","start":ISO,"end":ISO,"src":"live"|"log"}
 *   {"t":"cov","start":ISO,"end":ISO,"src":"live"|"log"}   a stretch that was watched
 * Coverage is what makes "no call" an answer: a meeting with no call inside
 * coverage had none on this Mac; one outside it is unknown.
 *
 * Lines go under the local date of their start; a read takes the day before too,
 * so a call across midnight is found from either day. Coverage is cut at local
 * midnight into one line per day (coverageLines): the log's span is a week long,
 * and a single line under its first day was invisible to a read of any later day.
 * All fs is async and every write for the store runs in one chain.
 */

import fsp from 'node:fs/promises'
import path from 'node:path'
import { WALNUT_HOME } from '../../constants.js'
import { log } from '../../logging/index.js'
import { callSessions, mergeCalls, mergeSpans, COVERAGE_JOIN_MS, type CallInterval, type Span } from './calls.js'
import { localDateKey, shiftDateKey } from './rollup.js'

export type CallSource = 'live' | 'log'

/** A day file this large is not ours (a call a minute for a day is ~100 KB). */
const MAX_DAY_BYTES = 4 * 1024 * 1024
const MAX_APP_LEN = 80

function dir(): string {
  return path.join(WALNUT_HOME, 'time-tracking', 'outside', 'calls')
}

function dayFile(date: string): string {
  return path.join(dir(), `${date}.jsonl`)
}

export function callLine(c: CallInterval, src: CallSource): string {
  return JSON.stringify({ t: 'call', app: c.app.slice(0, MAX_APP_LEN), start: new Date(c.startMs).toISOString(), end: new Date(c.endMs).toISOString(), src })
}

export function coverageLine(span: Span, src: CallSource): string {
  return JSON.stringify({ t: 'cov', start: new Date(span[0]).toISOString(), end: new Date(span[1]).toISOString(), src })
}

/** A watched stretch as one line per local day it touches, ready for appendCallLines. */
export function coverageLines(span: Span, src: CallSource): Array<{ startMs: number; line: string }> {
  const out: Array<{ startMs: number; line: string }> = []
  let a = span[0]
  for (let guard = 0; a < span[1] && guard < 400; guard++) {
    const d = new Date(a)
    const b = Math.min(span[1], new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime())
    out.push({ startMs: a, line: coverageLine([a, b], src) })
    a = b
  }
  return out
}

let tail: Promise<void> = Promise.resolve()

function chained<T>(work: () => Promise<T>): Promise<T> {
  const run = tail.then(work, work)
  tail = run.then(() => undefined, () => undefined)
  return run
}

async function readText(file: string): Promise<string> {
  try {
    const st = await fsp.stat(file)
    if (st.size > MAX_DAY_BYTES) return ''
    return await fsp.readFile(file, 'utf8')
  } catch {
    return ''
  }
}

/**
 * Append lines, grouped by the local date of each line's start, skipping lines the
 * day already holds (a backfill re-reads the whole log every run). Never throws.
 */
export function appendCallLines(lines: ReadonlyArray<{ startMs: number; line: string }>): Promise<number> {
  if (lines.length === 0) return Promise.resolve(0)
  return chained(async () => {
    const byDate = new Map<string, string[]>()
    for (const l of lines) {
      const date = localDateKey(new Date(l.startMs))
      const list = byDate.get(date) ?? []
      list.push(l.line)
      byDate.set(date, list)
    }
    let written = 0
    try {
      await fsp.mkdir(dir(), { recursive: true })
      for (const [date, list] of byDate) {
        const file = dayFile(date)
        const have = new Set((await readText(file)).split('\n'))
        const fresh = [...new Set(list)].filter((l) => !have.has(l))
        if (fresh.length === 0) continue
        await fsp.appendFile(file, `${fresh.join('\n')}\n`, 'utf8')
        written += fresh.length
      }
    } catch (err) {
      log.web.warn('calls store: append failed', { error: err instanceof Error ? err.message : String(err) })
    }
    return written
  })
}

export interface CallsRead {
  /** Merged per app, sorted by start. */
  calls: CallInterval[]
  /** One per call, never joined to the next (callSessions): which meeting a call was. */
  sessions: CallInterval[]
  /** Merged stretches this Mac was watching for calls. */
  coverage: Array<[number, number]>
}

function parseLine(line: string, calls: CallInterval[], cov: Span[]): void {
  if (!line) return
  let rec: Record<string, unknown>
  try { rec = JSON.parse(line) as Record<string, unknown> } catch { return }
  const a = typeof rec.start === 'string' ? Date.parse(rec.start) : NaN
  const b = typeof rec.end === 'string' ? Date.parse(rec.end) : NaN
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return
  if (rec.t === 'call' && typeof rec.app === 'string' && rec.app) calls.push({ app: rec.app.slice(0, MAX_APP_LEN), startMs: a, endMs: b })
  else if (rec.t === 'cov') cov.push([a, b])
}

/** Calls and coverage that touch [fromMs, toMs). The day files from the day before `fromMs` on are read. */
export function readCalls(fromMs: number, toMs: number): Promise<CallsRead> {
  return chained(async () => {
    const calls: CallInterval[] = []
    const cov: Span[] = []
    const last = localDateKey(new Date(toMs))
    for (let d = shiftDateKey(localDateKey(new Date(fromMs)), -1), guard = 0; d <= last && guard < 120; d = shiftDateKey(d, 1), guard++) {
      for (const line of (await readText(dayFile(d))).split('\n')) parseLine(line, calls, cov)
    }
    const touches = (a: number, b: number): boolean => b > fromMs && a < toMs
    return {
      calls: mergeCalls(calls).filter((c) => touches(c.startMs, c.endMs)),
      sessions: callSessions(calls).filter((c) => touches(c.startMs, c.endMs)),
      coverage: mergeSpans(cov, COVERAGE_JOIN_MS).filter(([a, b]) => touches(a, b)),
    }
  })
}

/** Tests: forget the write chain (a test that swaps WALNUT_HOME starts clean). */
export function resetCallsStore(): void {
  tail = Promise.resolve()
}
