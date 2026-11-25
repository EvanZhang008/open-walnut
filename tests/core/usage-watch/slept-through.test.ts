/**
 * A call or request this machine slept through part of is Walnut being away, never the tool's or
 * the route's own fault (2026-11-25: the Mac slept 3.4 hours on 1% battery, and two host_exec_read
 * calls held across the sleep rang "A watched tool fails" as timeouts of 12,380,000 ms). It is
 * counted as unreachable with the code `asleep`: no error counter, no slow read, no new code for
 * a watch. The ratchet at the end fails when a new failure or slowness counter of an op call or a
 * request is counted without the same check.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { setUsageWatchFile, readHours, readEvents, closeUsageWatchStore } from '../../../src/core/usage-watch/store.js'
import { addObserveTap } from '../../../src/core/observability/metrics.js'
import { _resetUsageRecorderForTesting, flushUsage, recordHttp, recordOpCall, setWatchedOps } from '../../../src/core/usage-watch/record.js'
import { judgeTarget } from '../../../src/core/usage-watch/watches.js'
import { ASLEEP_CODE } from '../../../src/core/usage-watch/normalize.js'
import { __resetSleepLedgerForTest, noteSleepSinceLastLook } from '../../../src/lib/sleep-ledger.js'

const T0 = Date.parse('2026-11-25T05:00:00Z')
const H = 3_600_000
let dir: string
let wall = T0
let mono = 0

/** The Mac sleeps `ms` now: its wall clock moves on, its monotonic clock does not. */
function sleep(ms: number): void {
  noteSleepSinceLastLook()
  wall += ms
  mono += 50
  noteSleepSinceLastLook()
}

/** Time passes with the Mac awake: both clocks move. */
function awake(ms: number): void {
  noteSleepSinceLastLook()
  wall += ms
  mono += ms
  noteSleepSinceLastLook()
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-slept-'))
  setUsageWatchFile(path.join(dir, 'usage-watch.sqlite'))
  _resetUsageRecorderForTesting(true)
  wall = T0
  mono = 0
  __resetSleepLedgerForTest({ now: () => wall, monoNow: () => mono })
})

afterEach(() => {
  closeUsageWatchStore()
  setUsageWatchFile(null)
  _resetUsageRecorderForTesting(false)
  setWatchedOps([])
  __resetSleepLedgerForTest(null)
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('a call the machine slept through', () => {
  it('a timeout that was mostly sleep is unreachable (asleep); a thrown error, a short nap or an awake timeout is still an error', () => {
    setWatchedOps(['host_exec_read'])
    const seen: string[] = []
    const off = addObserveTap((name) => { if (name.startsWith('usage.op.')) seen.push(name) })
    try {
      const start = wall
      sleep(3.4 * H)
      awake(6_000)
      recordOpCall({ op: 'host_exec_read', client: 'cli', cls: 'timeout', code: 'lost', size: 140, overLimit: false, ms: wall - start, now: wall })
      expect(seen).toEqual([])
      // A thrown error is the tool's fault, slept through or not.
      recordOpCall({ op: 'host_exec_read', client: 'cli', cls: 'error', code: 'thrown', size: 10, overLimit: false, ms: wall - start, now: wall })
      expect(seen).toEqual(['usage.op.errors', 'usage.op.watched_errors'])
      // A 30-minute timeout with one 6 s nap in it is the tool's own.
      seen.length = 0
      const long = wall
      awake(10 * 60_000)
      sleep(6_000)
      awake(20 * 60_000)
      recordOpCall({ op: 'host_exec_read', client: 'cli', cls: 'timeout', code: 'lost', size: 140, overLimit: false, ms: wall - long, now: wall })
      expect(seen).toEqual(['usage.op.errors', 'usage.op.watched_errors'])
      // An hour later, awake: a timeout is the tool's.
      seen.length = 0
      awake(H)
      recordOpCall({ op: 'host_exec_read', client: 'cli', cls: 'timeout', code: 'lost', size: 140, overLimit: false, ms: 20_000, now: wall })
      expect(seen).toEqual(['usage.op.errors', 'usage.op.watched_errors'])
      // A refusal is the tool's answer, and an already unreachable call keeps its own code.
      recordOpCall({ op: 'host_exec_read', client: 'cli', cls: 'refused', code: 'session_only', size: 114, overLimit: false, ms: 3 * H, now: wall })
      recordOpCall({ op: 'host_exec_read', client: 'cli', cls: 'unreachable', code: 'host_offline', size: 80, overLimit: false, ms: 3 * H, now: wall })
    } finally { off() }
    flushUsage(wall + 60_000)
    const aggs = readHours(0).filter((r) => r.kind === 'op' && r.name === 'host_exec_read').map((r) => r.agg)
    const codes: Record<string, number> = {}
    for (const a of aggs) for (const [k, v] of Object.entries(a.codes)) codes[k] = (codes[k] ?? 0) + v
    expect(codes).toEqual({ [ASLEEP_CODE]: 1, lost: 2, thrown: 1, session_only: 1, host_offline: 1 })
    // The slept call's time is its awake part, not the 3.4 hours.
    const asleepEvent = readEvents({ since: 0, limit: 50 }).find((e) => e.code === ASLEEP_CODE)!
    expect(asleepEvent.problem).toBe('unreachable')
    expect(asleepEvent.ms).toBeLessThan(10_000)
  })

  it('a gateway answer mostly slept through is unreachable, a read is slow only by its time awake, a 500 stays a server error', () => {
    const seen: string[] = []
    const off = addObserveTap((name) => { if (name.startsWith('usage.http.')) seen.push(name) })
    const T = '/api/v1/hosts/:host/exec/:jobId'
    try {
      const start = wall
      sleep(3.4 * H)
      // Answered 3 s after the wake: under the slow line by its time awake.
      awake(3_000)
      recordHttp({ method: 'GET', template: T, status: 503, ms: wall - start, waits: false, now: wall })
      recordHttp({ method: 'GET', template: T, status: 200, ms: wall - start, waits: false, now: wall })
      expect(seen).toEqual([])
      recordHttp({ method: 'GET', template: T, status: 500, ms: wall - start, waits: false, now: wall })
      expect(seen).toEqual(['usage.http.server_errors'])
      seen.length = 0
      awake(H)
      recordHttp({ method: 'GET', template: T, status: 503, ms: 20, waits: false, now: wall })
      recordHttp({ method: 'GET', template: T, status: 200, ms: 6_000, waits: false, now: wall })
      expect(seen.sort()).toEqual(['usage.http.server_errors', 'usage.http.slow'])
    } finally { off() }
  })
})

describe('a watch', () => {
  it('never reads asleep as a new error code of its target', () => {
    const start = wall
    sleep(3.4 * H)
    awake(6_000)
    recordOpCall({ op: 'host_exec_read', client: 'cli', cls: 'timeout', code: 'lost', size: 140, overLimit: false, ms: wall - start, now: wall })
    flushUsage(wall + 60_000)
    const r = judgeTarget('op:host_exec_read', {}, T0 - H, wall + H)
    expect(r.uses).toBe(1)
    expect(r.newCodes).toBeUndefined()
    expect(r.ok).toBe(true)
  })
})

describe('ratchet: every failure or slowness counter of a call checks for sleep', () => {
  it('each function that counts an op or request failure or a slow read reads sleptOf', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../../src/core/usage-watch/record.ts'), 'utf8')
    const fns = src.split(/\nexport function /).slice(1)
    const counting = fns.filter((f) => /count\('usage\.(op|http)\.[a-z_]*(errors|slow)/.test(f))
    expect(counting.map((f) => f.slice(0, f.indexOf('(')))).toEqual(expect.arrayContaining(['recordHttp', 'recordOpCall']))
    for (const f of counting) expect(f, f.slice(0, 40)).toContain('sleptOf(')
  })
})
